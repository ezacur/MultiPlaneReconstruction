import { mat4, vec3 } from 'gl-matrix';
import type { BodyMesh, Ray } from '../scene';
import { meshEdges } from '../silhouette';
import type { LineBatch } from '../widget';
import {
  bodyCentreInScene,
  dashedLine,
  inScene,
  onPlane,
  snapMove,
  toBodyDirection,
  tube,
  type Context,
  type Geometry,
  type Manipulator,
} from './common';

const SHADOW: [number, number, number] = [0.58, 0.64, 0.78];
const SHADOW_HOT: [number, number, number] = [0.85, 0.9, 1.0];
const WALL: [number, number, number] = [0.5, 0.54, 0.63];
/** The room round the volume and the body reaches this much further, as a
 *  fraction of its size, each way. */
const ROOM_MARGIN = 0.06;

/** A wall of the volume's box: a face, the far one of its axis. */
interface Wall {
  /** Grid axis the wall is square to: 0 = I, 1 = J, 2 = K. */
  axis: number;
  /** Its corners, in order round it. */
  corners: vec3[];
  centre: vec3;
  /** Outward, away from the camera. */
  normal: vec3;
  /** Two unit directions along it, square to each other. */
  e1: vec3;
  e2: vec3;
}

interface Drag {
  wall: Wall;
  model0: mat4;
  grab: vec3;
}

/**
 * The body's shadows on the three far walls of a room round the volume and
 * the body, its walls square to the grid's axes, as on the walls of a 3D
 * chart: its silhouette cast square onto each, filled faintly
 * and outlined. Each wall is a view of the body along one axis of the grid,
 * and dragging a shadow moves the body across that wall, so three flat views
 * place it in depth. The walls are the ones away from the camera, and are
 * held still while a shadow is dragged.
 */
export class Shadows implements Manipulator {
  readonly id = 'shadows';
  readonly fades = true;
  private ctx: Context;
  private hover: number | null = null;
  private drag: Drag | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  get hovering(): boolean {
    return this.hover !== null;
  }

  /**
   * The room the walls belong to: the volume's box, grown along the grid's
   * axes to take the body in as well, wherever it is, and a little more, so
   * its shadows land on the walls. Its corners in the scene, i fastest, then
   * j, then k, as corners() gives the volume's.
   */
  private room(): vec3[] {
    const scene = this.ctx.scene;
    const vol = scene.vol;
    const body = scene.body;
    if (!vol || !body) return [];
    const lo = vec3.fromValues(-0.5, -0.5, -0.5);
    const hi = vec3.fromValues(vol.dims[0] - 0.5, vol.dims[1] - 0.5, vol.dims[2] - 0.5);
    const toVoxel = mat4.mul(mat4.create(), vol.worldToVoxel, scene.bodyModel);
    for (let k = 0; k < 8; k++) {
      const p = vec3.fromValues(
        k & 1 ? body.max[0] : body.min[0],
        k & 2 ? body.max[1] : body.min[1],
        k & 4 ? body.max[2] : body.min[2],
      );
      vec3.transformMat4(p, p, toVoxel);
      vec3.min(lo, lo, p);
      vec3.max(hi, hi, p);
    }
    const margin = vec3.scale(vec3.create(), vec3.sub(vec3.create(), hi, lo), ROOM_MARGIN);
    vec3.sub(lo, lo, margin);
    vec3.add(hi, hi, margin);
    const out: vec3[] = [];
    for (let k = 0; k < 8; k++) {
      const p = vec3.fromValues(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
      out.push(vec3.transformMat4(p, p, vol.voxelToWorld));
    }
    return out;
  }

  /** The far wall for each grid axis, as the camera is now. */
  private walls(): Wall[] {
    const scene = this.ctx.scene;
    const c = this.room();
    if (c.length !== 8) return [];
    const mid = vec3.lerp(vec3.create(), c[0], c[7], 0.5);
    const forward = scene.cameraBasis().forward;
    const out: Wall[] = [];
    for (let axis = 0; axis < 3; axis++) {
      const bit = 1 << axis;
      const [o1, o2] = [0, 1, 2].filter((k) => k !== axis).map((k) => 1 << k);
      let best: Wall | null = null;
      let bestDot = -Infinity;
      for (const side of [0, bit]) {
        // corners() runs i fastest, then j, then k: index = i + 2j + 4k.
        const corners = [side, side | o1, side | o1 | o2, side | o2].map((i) => c[i]);
        const centre = vec3.create();
        for (const p of corners) vec3.scaleAndAdd(centre, centre, p, 0.25);
        const e1 = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), corners[1], corners[0]));
        const across2 = vec3.sub(vec3.create(), corners[3], corners[0]);
        const normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), e1, across2));
        if (vec3.dot(normal, vec3.sub(vec3.create(), centre, mid)) < 0) vec3.negate(normal, normal);
        const e2 = vec3.cross(vec3.create(), normal, e1);
        const away = vec3.dot(normal, forward);
        if (away > bestDot) {
          bestDot = away;
          best = { axis, corners, centre, normal, e1, e2 };
        }
      }
      if (best) out.push(best);
    }
    return out;
  }

  /** The walls in use: held still during a drag. */
  private currentWalls(): Wall[] {
    if (!this.drag) return this.walls();
    const held = this.drag.wall;
    return this.walls().map((w) => (w.axis === held.axis ? held : w));
  }

  /** A scene point cast square onto a wall. */
  private cast(p: vec3, w: Wall): vec3 {
    return vec3.scaleAndAdd(vec3.create(), p, w.normal, -vec3.dot(vec3.sub(vec3.create(), p, w.centre), w.normal));
  }

  /** The body's corners in the scene. */
  private sceneVerts(body: BodyMesh): Float32Array {
    const P = body.positions;
    const m = this.ctx.scene.bodyModel;
    const W = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      W[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      W[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      W[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return W;
  }

  /**
   * The shadow on one wall as triangles in the wall's own coordinates: the
   * triangles turned towards the wall, which between them cover the
   * silhouette about once.
   */
  private shadow2D(body: BodyMesh, W: Float32Array, w: Wall): Float32Array {
    const { normals } = meshEdges(body);
    const d = toBodyDirection(w.normal, this.ctx.scene.bodyModel);
    const I = body.indices;
    const out: number[] = [];
    for (let k = 0; k < I.length; k += 3) {
      if (normals[k] * d[0] + normals[k + 1] * d[1] + normals[k + 2] * d[2] <= 0) continue;
      for (let j = 0; j < 3; j++) {
        const v = I[k + j] * 3;
        const rx = W[v] - w.centre[0], ry = W[v + 1] - w.centre[1], rz = W[v + 2] - w.centre[2];
        out.push(rx * w.e1[0] + ry * w.e1[1] + rz * w.e1[2], rx * w.e2[0] + ry * w.e2[1] + rz * w.e2[2]);
      }
    }
    return Float32Array.from(out);
  }

  /** The wall whose shadow a ray lands on, nearest first, and where. */
  private hit(ray: Ray): { index: number; point: vec3 } | null {
    const body = this.ctx.scene.body;
    if (!body) return null;
    const W = this.sceneVerts(body);
    let best: { index: number; point: vec3; t: number } | null = null;
    this.currentWalls().forEach((w, index) => {
      const p = onPlane(ray, w.centre, w.normal);
      if (!p) return;
      const t = vec3.dot(vec3.sub(vec3.create(), p, ray.origin), ray.dir);
      if (best && t >= best.t) return;
      const rel = vec3.sub(vec3.create(), p, w.centre);
      const x = vec3.dot(rel, w.e1);
      const y = vec3.dot(rel, w.e2);
      const T = this.shadow2D(body, W, w);
      for (let i = 0; i < T.length; i += 6) {
        if (inTriangle(x, y, T[i], T[i + 1], T[i + 2], T[i + 3], T[i + 4], T[i + 5])) {
          best = { index, point: p, t };
          return;
        }
      }
    });
    return best;
  }

  /**
   * A shadow is reached where it shows: not through the image of the slice,
   * which hides the walls behind it. There the plane keeps the pointer.
   */
  overHandle(ray: Ray | null): boolean {
    if (!ray || this.ctx.widget.overPlane(ray) || this.ctx.widget.pick(ray)) return false;
    return this.hit(ray) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const next = ray && !this.ctx.widget.overPlane(ray) ? (this.hit(ray)?.index ?? null) : null;
    const changed = next !== this.hover;
    this.hover = next;
    return changed;
  }

  clearHover(): void {
    this.hover = null;
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0) return false;
    const h = this.hit(ray);
    if (!h) return false;
    this.drag = { wall: this.walls()[h.index], model0: mat4.clone(this.ctx.scene.bodyModel), grab: h.point };
    this.hover = h.index;
    return true;
  }

  move(ray: Ray, snap: boolean): void {
    const d = this.drag;
    if (!d) return;
    if (Math.abs(vec3.dot(ray.dir, d.wall.normal)) < 0.05) return;
    const p = onPlane(ray, d.grab, d.wall.normal);
    if (!p) return;
    const moved = snapMove(vec3.sub(vec3.create(), p, d.grab), [d.wall.e1, d.wall.e2], snap);
    mat4.copy(this.ctx.scene.bodyModel, inScene(d.model0, mat4.fromTranslation(mat4.create(), moved)));
  }

  end(): void {
    this.drag = null;
  }

  cancel(): void {
    if (!this.drag) return;
    mat4.copy(this.ctx.scene.bodyModel, this.drag.model0);
    this.drag = null;
  }

  hint(): string {
    const names = ['I', 'J', 'K'];
    const i = this.drag ? this.drag.wall.axis : this.hover !== null ? this.currentWalls()[this.hover]?.axis : null;
    if (i === null || i === undefined) return '';
    return this.drag
      ? `moviendo el cuerpo en la pared ${names[i]}`
      : `arrastrar mueve el cuerpo en la pared ${names[i]}, la que mira por el eje ${names[i]}`;
  }

  cursor(): string | null {
    return this.drag || this.hover !== null ? 'move' : null;
  }

  geometry(): Geometry {
    const scene = this.ctx.scene;
    const body = scene.body;
    if (!body || !scene.vol) return { body: [], scene: [] };
    const { forward } = scene.cameraBasis();
    const W = this.sceneVerts(body);
    const { edges, normals } = meshEdges(body);
    const out: LineBatch[] = [];
    this.currentWalls().forEach((w, index) => {
      const hot = (this.drag ? this.drag.wall.axis === w.axis : this.hover === index);
      // The wall: a faint pane, so the shadow reads as lying on something.
      const [a, b, c, d] = w.corners;
      out.push({ verts: [...a, ...b, ...c, ...a, ...c, ...d], color: WALL, width: 1, alpha: 0.05, triangles: true, depth: 'test' });
      out.push({ verts: [...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a], color: WALL, width: 1, alpha: 0.35, depth: 'test' });
      // The fill: the triangles turned to the wall, cast onto it.
      const dB = toBodyDirection(w.normal, scene.bodyModel);
      const I = body.indices;
      const fill: number[] = [];
      const lift = vec3.scale(vec3.create(), w.normal, -0.5);
      for (let k = 0; k < I.length; k += 3) {
        if (normals[k] * dB[0] + normals[k + 1] * dB[1] + normals[k + 2] * dB[2] <= 0) continue;
        for (let j = 0; j < 3; j++) {
          const v = I[k + j] * 3;
          const p = this.cast(vec3.fromValues(W[v], W[v + 1], W[v + 2]), w);
          fill.push(p[0] + lift[0], p[1] + lift[1], p[2] + lift[2]);
        }
      }
      out.push({ verts: fill, color: hot ? SHADOW_HOT : SHADOW, width: 1, alpha: hot ? 0.3 : 0.16, triangles: true, depth: 'test' });
      // The outline: the edges where the surface turns from facing the wall
      // to facing away, and the open rim of the cut.
      const lines: number[] = [];
      for (let e = 0; e < edges.a.length; e++) {
        const t0 = edges.t0[e] * 3;
        const t1 = edges.t1[e];
        const s0 = normals[t0] * dB[0] + normals[t0 + 1] * dB[1] + normals[t0 + 2] * dB[2] > 0;
        const s1 = t1 >= 0 ? normals[t1 * 3] * dB[0] + normals[t1 * 3 + 1] * dB[1] + normals[t1 * 3 + 2] * dB[2] > 0 : !s0;
        if (s0 === s1) continue;
        const va = edges.a[e] * 3;
        const vb = edges.b[e] * 3;
        const p = this.cast(vec3.fromValues(W[va], W[va + 1], W[va + 2]), w);
        const q = this.cast(vec3.fromValues(W[vb], W[vb + 1], W[vb + 2]), w);
        lines.push(p[0] + lift[0], p[1] + lift[1], p[2] + lift[2], q[0] + lift[0], q[1] + lift[1], q[2] + lift[2]);
      }
      out.push({ verts: lines, color: hot ? SHADOW_HOT : SHADOW, width: hot ? 2 : 1, alpha: hot ? 1 : 0.7, depth: 'off' });
      // While held, the line from the body's middle to its shadow.
      if (hot) {
        const bc = bodyCentreInScene(scene);
        out.push(...tube(dashedLine(bc, this.cast(bc, w), 14), forward, SHADOW_HOT, false, 0.5));
      }
    });
    return { body: [], scene: out };
  }
}

function inTriangle(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
