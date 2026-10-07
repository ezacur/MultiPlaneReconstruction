import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import type { Ray } from '../scene';
import { depthRibbon, type LineBatch } from '../widget';
import {
  AXIS_COLORS,
  bodyCentre,
  handleUnit,
  inScene,
  quatAbout,
  screenTravel,
  snapQuat,
  toBody,
  toBodyDirection,
  toSceneDirection,
  type Context,
  type Geometry,
  type Manipulator,
  type RGB,
} from './common';

/** The cube's edge, as a fraction of the handle unit, and how far above the
 *  head its middle floats, in edges. */
const EDGE = 0.55;
const ABOVE = 0.9;
/** A press that travels less than this, in pixels, is a click. */
const CLICK_PX = 4;
/** Dragging across the cube's width turns the body a quarter turn. */
const DRAG_TURN = Math.PI / 2;

/**
 * Each face: its outward direction in the body's space, the way up its letter
 * reads, its letter and its colour. The plus faces wear the axis colours and
 * the minus faces a darker shade of them.
 */
const FACES: { n: vec3; up: vec3; letter: string; color: RGB }[] = [
  { n: [1, 0, 0], up: [0, 0, 1], letter: 'R', color: AXIS_COLORS[0] },
  { n: [-1, 0, 0], up: [0, 0, 1], letter: 'L', color: dim(AXIS_COLORS[0]) },
  { n: [0, 1, 0], up: [0, 0, 1], letter: 'A', color: AXIS_COLORS[1] },
  { n: [0, -1, 0], up: [0, 0, 1], letter: 'P', color: dim(AXIS_COLORS[1]) },
  { n: [0, 0, 1], up: [0, 1, 0], letter: 'S', color: AXIS_COLORS[2] },
  { n: [0, 0, -1], up: [0, -1, 0], letter: 'I', color: dim(AXIS_COLORS[2]) },
].map((f) => ({ ...f, n: vec3.clone(f.n as vec3), up: vec3.clone(f.up as vec3) }));

function dim(c: RGB): RGB {
  return [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
}

/**
 * The letters as strokes on a unit box, x across and y up: a polyline each.
 * Enough of a font for R, L, A, P, S and I.
 */
const LETTERS: Record<string, [number, number][][]> = {
  R: [
    [[0, 0], [0, 1], [0.6, 1], [0.8, 0.88], [0.8, 0.62], [0.6, 0.5], [0, 0.5]],
    [[0.4, 0.5], [0.85, 0]],
  ],
  L: [[[0.05, 1], [0.05, 0], [0.8, 0]]],
  A: [
    [[0, 0], [0.42, 1], [0.84, 0]],
    [[0.18, 0.42], [0.66, 0.42]],
  ],
  P: [[[0, 0], [0, 1], [0.6, 1], [0.8, 0.88], [0.8, 0.62], [0.6, 0.5], [0, 0.5]]],
  S: [
    [
      [0.8, 0.86], [0.62, 1], [0.2, 1], [0.02, 0.86], [0.02, 0.62], [0.2, 0.5],
      [0.62, 0.5], [0.82, 0.38], [0.82, 0.14], [0.62, 0], [0.2, 0], [0, 0.14],
    ],
  ],
  I: [
    [[0.42, 0], [0.42, 1]],
    [[0.18, 1], [0.66, 1]],
    [[0.18, 0], [0.66, 0]],
  ],
};

interface Drag {
  face: number;
  button: number;
  model0: mat4;
  ray0: Ray;
  right: vec3;
  up: vec3;
  dragging: boolean;
}

/**
 * An orientation cube floating over the body's head and turning with it, its
 * faces lettered R, L, A, P, S and I like the corner cube of a CAD view. A
 * click on a face turns the body to show that face to the camera, upright; a
 * right click turns it to face the slice instead, on the side the camera is
 * on. Dragging the cube turns the body freely.
 */
export class OrientationCube implements Manipulator {
  readonly id = 'cube';
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

  /** The cube's middle and half its edge, in the body's space. */
  private box(): { c: vec3; h: number } | null {
    const body = this.ctx.scene.body;
    if (!body) return null;
    const edge = handleUnit(this.ctx.scene) * EDGE;
    const mid = bodyCentre(this.ctx.scene);
    return { c: vec3.fromValues(mid[0], mid[1], body.max[2] + edge * ABOVE), h: edge / 2 };
  }

  /** The face a scene ray enters the cube by, or null. */
  private faceAt(ray: Ray): number | null {
    const b = this.box();
    if (!b) return null;
    const r = toBody(ray, this.ctx.scene.bodyModel);
    let t0 = -Infinity;
    let t1 = Infinity;
    let enter = -1;
    for (let k = 0; k < 3; k++) {
      const lo = b.c[k] - b.h;
      const hi = b.c[k] + b.h;
      if (Math.abs(r.dir[k]) < 1e-12) {
        if (r.origin[k] < lo || r.origin[k] > hi) return null;
        continue;
      }
      let ta = (lo - r.origin[k]) / r.dir[k];
      let tb = (hi - r.origin[k]) / r.dir[k];
      // Entering through the low side is the minus face.
      let face = 2 * k + 1;
      if (ta > tb) {
        [ta, tb] = [tb, ta];
        face = 2 * k;
      }
      if (ta > t0) {
        t0 = ta;
        enter = face;
      }
      t1 = Math.min(t1, tb);
    }
    return t0 <= t1 && enter >= 0 ? enter : null;
  }

  overHandle(ray: Ray | null): boolean {
    return ray !== null && this.faceAt(ray) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const next = ray ? this.faceAt(ray) : null;
    const changed = next !== this.hover;
    this.hover = next;
    return changed;
  }

  clearHover(): void {
    this.hover = null;
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0 && button !== 2) return false;
    const face = this.faceAt(ray);
    if (face === null) return false;
    const cam = this.ctx.scene.cameraBasis();
    this.drag = {
      face,
      button,
      model0: mat4.clone(this.ctx.scene.bodyModel),
      ray0: { origin: vec3.clone(ray.origin), dir: vec3.clone(ray.dir) },
      right: cam.right,
      up: cam.up,
      dragging: false,
    };
    return true;
  }

  move(ray: Ray, snap: boolean): void {
    const d = this.drag;
    const b = this.box();
    if (!d || !b || d.button !== 0) return;
    const moved = screenTravel(d.ray0, ray);
    if (!d.dragging && vec3.length(moved) < CLICK_PX * this.ctx.pixel()) return;
    d.dragging = true;
    // Across the screen turns about its up, and up the screen about its right,
    // so the face in front follows the pointer.
    const k = DRAG_TURN / (2 * b.h);
    const q = quat.setAxisAngle(quat.create(), d.up, vec3.dot(moved, d.right) * k);
    const q2 = quat.setAxisAngle(quat.create(), d.right, -vec3.dot(moved, d.up) * k);
    quat.mul(q, q, q2);
    const local = quatAbout(this.centreAt(d.model0), snapQuat(q, snap));
    mat4.copy(this.ctx.scene.bodyModel, inScene(d.model0, local));
  }

  /** The body's middle in the scene under a placement. */
  private centreAt(model: mat4): vec3 {
    return vec3.transformMat4(vec3.create(), bodyCentre(this.ctx.scene), model);
  }

  end(): void {
    const d = this.drag;
    this.drag = null;
    if (!d || d.dragging) return;
    // A click: turn the face to the camera, or to the slice.
    const scene = this.ctx.scene;
    const cam = scene.cameraBasis();
    const back = vec3.negate(vec3.create(), cam.forward);
    let toward: vec3;
    let up: vec3;
    if (d.button === 2) {
      // The slice's normal on the camera's side, with the screen's up laid
      // into the slice as near as it goes.
      toward = vec3.clone(scene.n);
      if (vec3.dot(toward, back) < 0) vec3.negate(toward, toward);
      up = vec3.scaleAndAdd(vec3.create(), cam.up, toward, -vec3.dot(cam.up, toward));
      if (vec3.length(up) < 1e-3) up = vec3.scaleAndAdd(vec3.create(), cam.right, toward, -vec3.dot(cam.right, toward));
      vec3.normalize(up, up);
    } else {
      toward = back;
      up = cam.up;
    }
    const f = FACES[d.face];
    const model = scene.bodyModel;
    // The face's frame in the scene now, and where it is to go.
    const fromN = toSceneDirection(f.n, model);
    const fromUp = toSceneDirection(f.up, model);
    const fromRight = vec3.cross(vec3.create(), fromUp, fromN);
    const toRight = vec3.cross(vec3.create(), up, toward);
    const columns = (x: vec3, y: vec3, z: vec3) =>
      mat3.fromValues(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]);
    const from = columns(fromRight, fromUp, fromN);
    const to = columns(toRight, up, toward);
    // The turn that takes one frame onto the other: to * from^T.
    const rot = mat3.mul(mat3.create(), to, mat3.transpose(mat3.create(), from));
    const q = quat.fromMat3(quat.create(), rot);
    quat.normalize(q, q);
    const target = inScene(model, quatAbout(this.centreAt(model), q));
    this.ctx.animateTo(target);
  }

  cancel(): void {
    if (!this.drag) return;
    mat4.copy(this.ctx.scene.bodyModel, this.drag.model0);
    this.drag = null;
  }

  hint(): string {
    if (this.drag?.dragging) return 'girando el cuerpo';
    const face = this.drag?.face ?? this.hover;
    if (face === null) return '';
    const l = FACES[face].letter;
    return `clic: cara ${l} a la camara; derecho: cara ${l} al corte; arrastrar gira`;
  }

  cursor(): string | null {
    if (this.drag?.dragging) return 'grabbing';
    return this.hover !== null || this.drag ? 'pointer' : null;
  }

  geometry(): Geometry {
    const b = this.box();
    if (!b) return { body: [], scene: [] };
    const scene = this.ctx.scene;
    const model = scene.bodyModel;
    const forward = toBodyDirection(scene.cameraBasis().forward, model);
    const hot = this.drag?.face ?? this.hover;
    const out: LineBatch[] = [];
    const strokes: [vec3, vec3][] = [];
    FACES.forEach((f, i) => {
      // Only the faces turned to the camera: the cube is convex, so they
      // never cover each other and need no sorting.
      if (vec3.dot(f.n, forward) >= 0) return;
      const right = vec3.cross(vec3.create(), f.up, f.n);
      const at = (x: number, y: number) => {
        const p = vec3.scaleAndAdd(vec3.create(), b.c, f.n, b.h);
        vec3.scaleAndAdd(p, p, right, x * b.h);
        return vec3.scaleAndAdd(p, p, f.up, y * b.h);
      };
      const corners = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
      const [p0, p1, p2, p3] = corners;
      const lit = 0.55 + 0.45 * -vec3.dot(f.n, forward);
      const c: RGB = [f.color[0] * lit, f.color[1] * lit, f.color[2] * lit];
      out.push({
        verts: [...p0, ...p1, ...p2, ...p0, ...p2, ...p3],
        color: hot === i ? [Math.min(1, c[0] + 0.25), Math.min(1, c[1] + 0.25), Math.min(1, c[2] + 0.25)] : c,
        width: 1,
        alpha: hot === i ? 1 : 0.85,
        triangles: true,
        depth: 'off',
      });
      for (const line of LETTERS[f.letter]) {
        for (let k = 0; k + 1 < line.length; k++) {
          // The letter on the middle half of the face.
          const q = (pt: [number, number]) => at((pt[0] - 0.42) * 1.0, (pt[1] - 0.5) * 1.1);
          strokes.push([q(line[k]), q(line[k + 1])]);
        }
      }
    });
    out.push(
      ...depthRibbon(strokes, forward, [1, 1, 1], { constantWidth: 2.5, fog: false }).map(
        (bt): LineBatch => ({ ...bt, depth: 'off' }),
      ),
    );
    return { body: out, scene: [] };
  }
}
