import { mat4, vec3 } from 'gl-matrix';
import type { Ray } from '../scene';
import type { LineBatch } from '../widget';
import {
  bodyCentreInScene,
  dashedCircle,
  discBatch,
  inScene,
  onPlane,
  snapAngle,
  SNAP_MM,
  snapMove,
  tube,
  turnAbout,
  type Context,
  type Geometry,
  type Manipulator,
} from './common';

type Part = 'inside' | 'outside';

const HIGHLIGHT: [number, number, number] = [1, 0.72, 0.62];
const GUIDE: [number, number, number] = [0.95, 0.78, 0.7];

interface Drag {
  part: Part;
  model0: mat4;
  grab: vec3;
  centre: vec3;
  n: vec3;
  u: vec3;
  v: vec3;
  angle0: number;
}

/**
 * Placing the body from the slice itself, without a gizmo. On the image, the
 * left button takes the body rather than the plane: inside the red outline it
 * slides the body along the plane, and outside it turns it about the plane's
 * normal, round the outline's middle. Alt and the wheel carry the body
 * through the slice a slice at a time. The plane keeps its ring, and the
 * middle and right buttons still slide it.
 */
export class SliceDrag implements Manipulator {
  readonly id = 'slice';
  readonly fades = true;
  private ctx: Context;
  private hover: Part | null = null;
  private hoverPoint: vec3 | null = null;
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

  /** Where a ray lands on the image, unless the plane's ring has it. */
  private onImage(ray: Ray): vec3 | null {
    const scene = this.ctx.scene;
    if (!scene.body || this.ctx.widget.pick(ray) !== null) return null;
    const p = scene.intersectPlane(ray);
    return p && scene.insideVolume(p) ? p : null;
  }

  /** The outline in the plane's own coordinates, and its middle in the scene. */
  private outline(): { segs: number[][]; centre: vec3; raw: number[] } {
    const scene = this.ctx.scene;
    const raw = scene.bodyContour();
    const p0 = scene.planePoint();
    const segs: number[][] = [];
    const sum = vec3.create();
    let total = 0;
    for (let i = 0; i < raw.length; i += 6) {
      const a = vec3.fromValues(raw[i], raw[i + 1], raw[i + 2]);
      const b = vec3.fromValues(raw[i + 3], raw[i + 4], raw[i + 5]);
      const ra = vec3.sub(vec3.create(), a, p0);
      const rb = vec3.sub(vec3.create(), b, p0);
      segs.push([vec3.dot(ra, scene.u), vec3.dot(ra, scene.v), vec3.dot(rb, scene.u), vec3.dot(rb, scene.v)]);
      const len = vec3.distance(a, b);
      vec3.scaleAndAdd(sum, sum, vec3.add(vec3.create(), a, b), len / 2);
      total += len;
    }
    let centre: vec3;
    if (total > 0) centre = vec3.scale(vec3.create(), sum, 1 / total);
    else {
      // No outline: the body's middle, put square onto the plane.
      const bc = bodyCentreInScene(scene);
      centre = vec3.scaleAndAdd(vec3.create(), bc, scene.n, -vec3.dot(vec3.sub(vec3.create(), bc, p0), scene.n));
    }
    return { segs, centre, raw };
  }

  /** Whether a point of the plane is inside the outline: by the parity of
   *  the outline's crossings on a line from it, which needs no ordering of
   *  the segments. With no outline, the whole image is inside. */
  private inside(p: vec3, segs: number[][]): boolean {
    if (segs.length === 0) return true;
    const scene = this.ctx.scene;
    const rel = vec3.sub(vec3.create(), p, scene.planePoint());
    const x = vec3.dot(rel, scene.u);
    const y = vec3.dot(rel, scene.v);
    let odd = false;
    for (const [x1, y1, x2, y2] of segs) {
      if (y1 > y !== y2 > y) {
        const xi = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
        if (xi > x) odd = !odd;
      }
    }
    return odd;
  }

  overHandle(ray: Ray | null): boolean {
    return ray !== null && this.onImage(ray) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const p = ray ? this.onImage(ray) : null;
    const next: Part | null = p ? (this.inside(p, this.outline().segs) ? 'inside' : 'outside') : null;
    const changed = next !== this.hover || (next === 'outside' && p !== null);
    this.hover = next;
    this.hoverPoint = p;
    return changed;
  }

  clearHover(): void {
    this.hover = null;
    this.hoverPoint = null;
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0) return false;
    const p = this.onImage(ray);
    if (!p) return false;
    const scene = this.ctx.scene;
    const { segs, centre } = this.outline();
    const part: Part = this.inside(p, segs) ? 'inside' : 'outside';
    const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), scene.u, scene.v));
    const rel = vec3.sub(vec3.create(), p, centre);
    this.drag = {
      part,
      model0: mat4.clone(scene.bodyModel),
      grab: p,
      centre,
      n,
      u: vec3.clone(scene.u),
      v: vec3.clone(scene.v),
      angle0: Math.atan2(vec3.dot(rel, scene.v), vec3.dot(rel, scene.u)),
    };
    this.hover = part;
    this.hoverPoint = p;
    return true;
  }

  move(ray: Ray, snap: boolean): void {
    const d = this.drag;
    if (!d) return;
    if (Math.abs(vec3.dot(ray.dir, d.n)) < 0.05) return;
    const p = onPlane(ray, d.grab, d.n);
    if (!p) return;
    this.hoverPoint = p;
    let local: mat4;
    if (d.part === 'inside') {
      local = mat4.fromTranslation(mat4.create(), snapMove(vec3.sub(vec3.create(), p, d.grab), [d.u, d.v], snap));
    } else {
      const rel = vec3.sub(vec3.create(), p, d.centre);
      const angle = Math.atan2(vec3.dot(rel, d.v), vec3.dot(rel, d.u)) - d.angle0;
      local = turnAbout(d.centre, d.n, snapAngle(angle, snap));
    }
    mat4.copy(this.ctx.scene.bodyModel, inScene(d.model0, local));
  }

  end(): void {
    this.drag = null;
  }

  cancel(): void {
    if (!this.drag) return;
    mat4.copy(this.ctx.scene.bodyModel, this.drag.model0);
    this.drag = null;
  }

  /** Alt and the wheel over the image: the body through the slice, a slice
   *  at a time, or a snapping step. */
  wheel(ray: Ray, dir: number, snap: boolean): boolean {
    if (!this.onImage(ray)) return false;
    const scene = this.ctx.scene;
    const step = snap ? SNAP_MM : scene.stepAlongNormal();
    const t = vec3.scale(vec3.create(), scene.n, -dir * step);
    mat4.copy(scene.bodyModel, inScene(mat4.clone(scene.bodyModel), mat4.fromTranslation(mat4.create(), t)));
    return true;
  }

  hint(): string {
    const part = this.drag?.part ?? this.hover;
    if (this.drag) return part === 'inside' ? 'trasladando el cuerpo por el plano' : 'girando el cuerpo en el plano';
    if (part === 'inside') return 'izquierdo traslada el cuerpo; Alt + rueda lo mueve a traves del corte';
    if (part === 'outside') return 'izquierdo gira el cuerpo en el plano; Alt + rueda lo mueve a traves del corte';
    return '';
  }

  cursor(): string | null {
    const part = this.drag?.part ?? this.hover;
    if (part === 'inside') return 'move';
    if (part === 'outside') return this.drag ? 'grabbing' : 'grab';
    return null;
  }

  geometry(): Geometry {
    const part = this.drag?.part ?? this.hover;
    if (!part) return { body: [], scene: [] };
    const scene = this.ctx.scene;
    const { forward, right, up } = scene.cameraBasis();
    const out: LineBatch[] = [];
    const { raw, centre } = this.outline();
    if (part === 'inside') {
      // The outline lit up: it is what the press takes.
      if (raw.length) out.push({ verts: raw, color: HIGHLIGHT, width: 3, alpha: 1, depth: 'off' });
    } else {
      const c = this.drag?.centre ?? centre;
      const p = this.hoverPoint;
      const r = p ? vec3.distance(p, c) : 0;
      if (r > 1e-3) out.push(...tube(dashedCircle(c, scene.u, scene.v, r, 40), forward, GUIDE, false, 0.6));
      out.push(discBatch(c, right, up, 4 * this.ctx.pixel(), GUIDE, 0.9));
    }
    return { body: [], scene: out };
  }
}
