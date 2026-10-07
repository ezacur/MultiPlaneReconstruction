import { mat4, quat, vec3 } from 'gl-matrix';
import type { Ray, Scene } from '../scene';
import { depthRibbon, type LineBatch, type PlaneWidget } from '../widget';

/**
 * What every way of placing the body shares: the contract the controls hold
 * each manipulator to, and the geometry and math they all draw on.
 *
 * A manipulator moves the body by changing `scene.bodyModel`, the rigid move
 * that places the body's space in the scene. Its gestures are absolute, worked
 * out from where the body stood when the drag began, so nothing drifts and
 * Escape puts it back.
 */

export type ManipId =
  | 'pedestal'
  | 'orbit'
  | 'plane'
  | 'slice'
  | 'landmarks'
  | 'arrows'
  | 'trackball'
  | 'cube'
  | 'shadows';

/** Geometry to draw: in the body's space, placed by its model, and in the scene. */
export interface Geometry {
  body: LineBatch[];
  scene: LineBatch[];
}

export interface Manipulator {
  readonly id: ManipId;
  /** A drag is under way. */
  readonly active: boolean;
  /** Some part of it is under the pointer. */
  readonly hovering: boolean;
  /** False keeps it on show, where the others fade when unused. */
  readonly fades: boolean;
  /**
   * Whether a ray takes one of its handles that come before the plane's ring
   * and image: thin ones, which can be taken where they show.
   */
  overHandle(ray: Ray | null): boolean;
  /** Note what is under the pointer; true if the drawing changes. */
  setHover(ray: Ray | null): boolean;
  clearHover(): void;
  /** Start a drag; false if the press is not for it. */
  begin(ray: Ray, button: number): boolean;
  /** Follow the pointer; `snap` rounds turns and moves to steps. */
  move(ray: Ray, snap: boolean): void;
  end(): void;
  /** Put the body back where the drag began. */
  cancel(): void;
  /** A wheel step with Alt held; true if taken. */
  wheel?(ray: Ray, dir: number, snap: boolean): boolean;
  /** What the pointer would do, or is doing, in a few words. */
  hint(): string;
  /** The cursor for the pointer, or null for the view's own. */
  cursor(): string | null;
  geometry(): Geometry;
}

/** What a manipulator may ask of the controls that hold it. */
export interface Context {
  scene: Scene;
  widget: PlaneWidget;
  /** Where a scene ray first meets the body surface, in both spaces. */
  bodyHit(ray: Ray): { body: vec3; scene: vec3; t: number } | null;
  /** Ease the body to a placement. */
  animateTo(target: mat4): void;
  /** Scene millimetres per screen pixel, as the camera is now. */
  pixel(): number;
  /** Something changed outside a drag: the controls and the panel redraw. */
  changed(): void;
}

// ---- steps -------------------------------------------------------------------

/** The steps snapping rounds to: 15 degrees, and 5 millimetres. */
export const SNAP_ANGLE = (15 * Math.PI) / 180;
export const SNAP_MM = 5;

export const snapAngle = (a: number, on: boolean) => (on ? Math.round(a / SNAP_ANGLE) * SNAP_ANGLE : a);
export const snapLength = (d: number, on: boolean) => (on ? Math.round(d / SNAP_MM) * SNAP_MM : d);

/**
 * A move rounded to steps along each of the gesture's own unit `axes`, which
 * should be square to each other: the move's share along each is rounded, and
 * whatever it has off them is dropped, so it stays on them.
 */
export function snapMove(d: vec3, axes: vec3[], on: boolean): vec3 {
  if (!on) return d;
  const out = vec3.create();
  for (const a of axes) vec3.scaleAndAdd(out, out, a, snapLength(vec3.dot(d, a), true));
  return out;
}

/** A turn snapped to steps of its angle, about the same axis. */
export function snapQuat(q: quat, on: boolean): quat {
  if (!on) return q;
  const axis = vec3.create();
  const angle = quat.getAxisAngle(axis, q);
  return quat.setAxisAngle(quat.create(), axis, snapAngle(angle > Math.PI ? angle - 2 * Math.PI : angle, true));
}

// ---- moves -------------------------------------------------------------------

/** A turn of `angle` about the line through `p` along unit `axis`. */
export function turnAbout(p: vec3, axis: vec3, angle: number): mat4 {
  const m = mat4.fromTranslation(mat4.create(), p);
  mat4.rotate(m, m, angle, axis);
  return mat4.translate(m, m, vec3.negate(vec3.create(), p));
}

/** A turn `q` about point `p`. */
export function quatAbout(p: vec3, q: quat): mat4 {
  return mat4.fromRotationTranslationScaleOrigin(mat4.create(), q, [0, 0, 0], [1, 1, 1], p);
}

/** The body placed by a move made in the scene: `local` after `model0`. */
export function inScene(model0: mat4, local: mat4): mat4 {
  return mat4.mul(mat4.create(), local, model0);
}

/** Where a ray meets the plane through `p` with unit normal `n`, if it does. */
export function onPlane(ray: Ray, p: vec3, n: vec3): vec3 | null {
  const denom = vec3.dot(ray.dir, n);
  if (Math.abs(denom) < 1e-6) return null;
  const t = vec3.dot(vec3.sub(vec3.create(), p, ray.origin), n) / denom;
  return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
}

/** The shortest the screen image of a turn's tangent is taken to be, as a
 *  fraction of the radius, so a grab seen end on does not race. */
const TANGENT_FLOOR = 0.3;

/**
 * How far a turn about `axis`, through `centre`, has carried the grabbed point
 * `grab`, read from how far the pointer has moved since the press: the
 * pointer's travel across the screen, taken along the screen image of the
 * point's tangent. One pixel is always the same bit of turn, wherever on the
 * ring the grab is and however the ring is seen, where reading the angle off
 * the pointer's position on the ring's plane leaps whenever the ring is seen
 * slanted or the pointer passes near its centre.
 *
 * The camera is orthographic, so the rays all share a direction and their
 * origins move across the view as the pointer does.
 */
export function tangentTurn(axis: vec3, centre: vec3, grab: vec3, ray0: Ray, ray: Ray): number {
  const radial = vec3.sub(vec3.create(), grab, centre);
  const radius = vec3.length(radial);
  if (radius < 1e-9) return 0;
  // The point's velocity per radian, and its image across the view.
  const tangent = vec3.cross(vec3.create(), axis, radial);
  const dir = ray.dir;
  vec3.scaleAndAdd(tangent, tangent, dir, -vec3.dot(tangent, dir));
  // Seen end on, the tangent shrinks to nothing on screen; a floor on its
  // length keeps the turn from racing there.
  const len2 = Math.max(vec3.dot(tangent, tangent), (radius * TANGENT_FLOOR) ** 2);
  const moved = vec3.sub(vec3.create(), ray.origin, ray0.origin);
  vec3.scaleAndAdd(moved, moved, dir, -vec3.dot(moved, dir));
  return vec3.dot(moved, tangent) / len2;
}

/** The pointer's travel across the screen since the press, in the scene. */
export function screenTravel(ray0: Ray, ray: Ray): vec3 {
  const moved = vec3.sub(vec3.create(), ray.origin, ray0.origin);
  return vec3.scaleAndAdd(moved, moved, ray.dir, -vec3.dot(moved, ray.dir));
}

// ---- spaces ------------------------------------------------------------------

/** A scene ray taken into the body's space under a given placement. */
export function toBody(ray: Ray, model: mat4): Ray {
  const inv = mat4.invert(mat4.create(), model) ?? mat4.create();
  const origin = vec3.transformMat4(vec3.create(), ray.origin, inv);
  const ahead = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), ray.origin, ray.dir), inv);
  return { origin, dir: vec3.normalize(vec3.create(), vec3.sub(ahead, ahead, origin)) };
}

/** A scene direction taken into the body's space under a given placement. */
export function toBodyDirection(d: vec3, model: mat4): vec3 {
  const inv = mat4.invert(mat4.create(), model) ?? mat4.create();
  const o = vec3.transformMat4(vec3.create(), [0, 0, 0], inv);
  const p = vec3.transformMat4(vec3.create(), d, inv);
  return vec3.normalize(p, vec3.sub(p, p, o));
}

/** A body direction taken into the scene under a given placement. */
export function toSceneDirection(d: vec3, model: mat4): vec3 {
  const o = vec3.transformMat4(vec3.create(), [0, 0, 0], model);
  const p = vec3.transformMat4(vec3.create(), d, model);
  return vec3.normalize(p, vec3.sub(p, p, o));
}

/** The middle of the body's box, in the body's space. */
export function bodyCentre(scene: Scene): vec3 {
  const body = scene.body;
  if (!body) return vec3.create();
  return vec3.lerp(vec3.create(), body.min, body.max, 0.5);
}

/** The middle of the body's box where the body is now, in the scene. */
export function bodyCentreInScene(scene: Scene): vec3 {
  return vec3.transformMat4(vec3.create(), bodyCentre(scene), scene.bodyModel);
}

/** The body's own axes in the scene, R, A and S, as it is placed now. */
export function bodyAxes(scene: Scene): vec3[] {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map((a) => toSceneDirection(a as vec3, scene.bodyModel));
}

/** The unit of size for handles: the pedestal's radius, a fifth of a metre or so. */
export function handleUnit(scene: Scene): number {
  return scene.pedestalShape()?.r ?? 100;
}

// ---- hits --------------------------------------------------------------------

/** How far a ray passes from a segment, where along the ray, and where on
 *  the segment (0 to 1). */
export function segmentDistance(ray: Ray, a: vec3, b: vec3): { dist: number; t: number; s: number } {
  const d = vec3.sub(vec3.create(), b, a);
  const w = vec3.sub(vec3.create(), a, ray.origin);
  const dd = vec3.dot(d, d);
  const dr = vec3.dot(d, ray.dir);
  const wd = vec3.dot(w, d);
  const wr = vec3.dot(w, ray.dir);
  const den = dd - dr * dr;
  let s = den > 1e-12 ? (dr * wr - wd) / den : 0;
  s = Math.max(0, Math.min(1, s));
  const p = vec3.scaleAndAdd(vec3.create(), a, d, s);
  const t = vec3.dot(vec3.sub(vec3.create(), p, ray.origin), ray.dir);
  const q = vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
  return { dist: vec3.distance(p, q), t, s };
}

/** How far a ray passes from a point, and where along the ray. */
export function pointDistance(ray: Ray, p: vec3): { dist: number; t: number } {
  const w = vec3.sub(vec3.create(), p, ray.origin);
  const t = vec3.dot(w, ray.dir);
  vec3.scaleAndAdd(w, w, ray.dir, -t);
  return { dist: vec3.length(w), t };
}

/** A point on the circle about `c` spanned by unit `e1` and `e2`. */
export function circlePoint(c: vec3, e1: vec3, e2: vec3, r: number, a: number): vec3 {
  const p = vec3.scaleAndAdd(vec3.create(), c, e1, Math.cos(a) * r);
  return vec3.scaleAndAdd(p, p, e2, Math.sin(a) * r);
}

/** How near a ray passes to a circle, and the circle's nearest point to it. */
export function ringDistance(
  ray: Ray,
  c: vec3,
  e1: vec3,
  e2: vec3,
  r: number,
  samples = 96,
): { dist: number; point: vec3; t: number } {
  let best = { dist: Infinity, point: vec3.clone(c), t: 0 };
  for (let i = 0; i < samples; i++) {
    const p = circlePoint(c, e1, e2, r, (i / samples) * Math.PI * 2);
    const { dist, t } = pointDistance(ray, p);
    if (dist < best.dist) best = { dist, point: p, t };
  }
  return best;
}

/** Two unit directions square to unit `n` and to each other, right-handed. */
export function across(n: vec3): [vec3, vec3] {
  const ref: vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), ref, n));
  const e2 = vec3.cross(vec3.create(), n, e1);
  return [e1, e2];
}

// ---- drawing -----------------------------------------------------------------

export type RGB = [number, number, number];

export const WHITE: RGB = [0.95, 0.96, 0.98];
export const AXIS_COLORS: RGB[] = [
  [0.96, 0.32, 0.3],
  [0.38, 0.86, 0.42],
  [0.4, 0.6, 1.0],
];
/** Handle widths in pixels, at rest and when offered or held. */
export const WIDTH = 3;
export const WIDTH_HOT = 5.5;

/** A brighter shade of a colour, for the handle under the pointer. */
export const lighter = (c: RGB, k = 0.35): RGB => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];

/** A curve as a tube of constant width whose far side fades, over everything. */
export function tube(
  segs: [vec3, vec3][],
  forward: vec3,
  color: RGB,
  hot: boolean,
  alpha = 0.85,
): LineBatch[] {
  return depthRibbon(segs, forward, color, {
    constantWidth: hot ? WIDTH_HOT : WIDTH,
    alphaScale: hot ? 1 : alpha,
    fog: false,
  }).map((b): LineBatch => ({ ...b, depth: 'off' }));
}

/** A circle as segments. */
export function circleSegs(c: vec3, e1: vec3, e2: vec3, r: number, n = 96, a0 = 0, a1 = Math.PI * 2): [vec3, vec3][] {
  const segs: [vec3, vec3][] = [];
  for (let i = 0; i < n; i++) {
    segs.push([circlePoint(c, e1, e2, r, a0 + ((a1 - a0) * i) / n), circlePoint(c, e1, e2, r, a0 + ((a1 - a0) * (i + 1)) / n)]);
  }
  return segs;
}

/** A dashed circle as segments, `dashes` dashes with gaps as long. */
export function dashedCircle(c: vec3, e1: vec3, e2: vec3, r: number, dashes = 36): [vec3, vec3][] {
  const segs: [vec3, vec3][] = [];
  const step = Math.PI / dashes;
  for (let k = 0; k < dashes; k++) {
    const a = 2 * k * step;
    for (let i = 0; i < 3; i++) {
      segs.push([circlePoint(c, e1, e2, r, a + (step * i) / 3), circlePoint(c, e1, e2, r, a + (step * (i + 1)) / 3)]);
    }
  }
  return segs;
}

/** A dashed line from `a` to `b` as segments. */
export function dashedLine(a: vec3, b: vec3, dashes = 12): [vec3, vec3][] {
  const segs: [vec3, vec3][] = [];
  const n = 2 * dashes - 1;
  for (let k = 0; k < dashes; k++) {
    segs.push([vec3.lerp(vec3.create(), a, b, (2 * k) / n), vec3.lerp(vec3.create(), a, b, (2 * k + 1) / n)]);
  }
  return segs;
}

/** A filled disc facing the camera, spanned by `right` and `up`. */
export function discBatch(c: vec3, right: vec3, up: vec3, r: number, color: RGB, alpha = 1): LineBatch {
  const verts: number[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const p = circlePoint(c, right, up, r, (i / n) * Math.PI * 2);
    verts.push(c[0], c[1], c[2], p[0], p[1], p[2]);
  }
  return { verts, color, width: 1, alpha, strip: true, depth: 'off' };
}

/**
 * An arrowhead: a flat triangle from `base` to `tip`, turned to face the
 * camera as well as it can. Seen end on it would vanish, so it is then a
 * little disc instead.
 */
export function arrowHead(base: vec3, tip: vec3, forward: vec3, halfWidth: number, color: RGB, alpha = 1): LineBatch {
  const d = vec3.sub(vec3.create(), tip, base);
  const side = vec3.cross(vec3.create(), d, forward);
  if (vec3.length(side) < 1e-6 * vec3.length(d) + 1e-9) {
    const [r, u] = across(forward);
    return discBatch(tip, r, u, halfWidth, color, alpha);
  }
  vec3.normalize(side, side);
  const b1 = vec3.scaleAndAdd(vec3.create(), base, side, halfWidth);
  const b2 = vec3.scaleAndAdd(vec3.create(), base, side, -halfWidth);
  return { verts: [...tip, ...b1, ...b2], color, width: 1, alpha, triangles: true, depth: 'off' };
}

/** A flat quad as two triangles. */
export function quadBatch(p: vec3[], color: RGB, alpha: number): LineBatch {
  const [a, b, c, d] = p;
  return { verts: [...a, ...b, ...c, ...a, ...c, ...d], color, width: 1, alpha, triangles: true, depth: 'off' };
}

/**
 * Batches at a fraction of their strength: on the way out, nothing stays
 * solid, so a handle that is going does not hide what is behind it.
 */
export function fadeBatches(batches: LineBatch[], shown: number): LineBatch[] {
  if (shown > 0.998) return batches;
  if (shown < 0.002) return [];
  return batches.map((b) => {
    if (b.ribbon) {
      // A ribbon's opacity is per vertex, the tenth float of each.
      const verts = b.verts.slice();
      for (let i = 9; i < verts.length; i += 11) verts[i] *= shown;
      return { ...b, verts };
    }
    return { ...b, alpha: (b.alpha ?? 1) * shown, depth: b.depth === 'write' ? 'test' : b.depth };
  });
}
