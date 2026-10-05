import { vec3 } from 'gl-matrix';
import { RIBBON_STRIDE } from './renderer';
import { closestPointOnLine, directionColor, type Ray, type Scene } from './scene';

/**
 * The 3D plane manipulator: a band lying in the plane, concentric with it,
 * spanning from 0.85 to 1.0 of the widget radius.
 *
 * The band is the handle for tilting; sliding can be grabbed anywhere the plane
 * actually shows something, which is the image or the band itself. The gesture
 * is:
 *
 *  - **left drag on the band** tilts the plane about an in-plane axis through
 *    the pivot, perpendicular to the grabbed radius. The grabbed point travels
 *    along a visible arc, and the pointer ray is projected onto that arc to get
 *    the angle;
 *  - **drag on the image, or on the band with another button** slides the plane
 *    along its own normal. The pointer
 *    ray is projected onto the normal line through the grabbed point, so the
 *    plane tracks the pointer exactly instead of following raw mouse deltas.
 *
 * Both gestures are absolute: the angle and the offset are recomputed from the
 * frame captured at the start of the drag, so nothing drifts over a long drag.
 * Escape restores that captured state.
 *
 * Ported from `draggablePlaneWidget.m`.
 */

export type Gesture = 'rotate' | 'translate';

/** 'off' ignores depth, 'test' respects it, 'write' also contributes to it. */
export type DepthMode = 'off' | 'test' | 'write';

export interface LineBatch {
  verts: number[];
  color: [number, number, number];
  /** Apparent width in pixels; the renderer fakes it with offset passes. */
  width: number;
  /** Below 1 the batch is blended over what is already drawn. */
  alpha?: number;
  /** Draw as a triangle strip instead of separate line segments. */
  strip?: boolean;
  /** Draw as a screen-space ribbon; verts are packed at RIBBON_STRIDE floats. */
  ribbon?: boolean;
  depth?: DepthMode;
  /**
   * Shift the batch in depth by this many polygon-offset steps: negative pulls
   * it towards the camera, positive pushes it away. It settles who wins with
   * the slice a batch lies flat on, instead of a pixel-by-pixel fight.
   */
  nudge?: number;
}

/** How far round the arc a single grab can tilt the plane: 100 degrees each
 *  way, a little past the quarter turn so a plane can be carried through it. */
const ARC_MIN = (-100 * Math.PI) / 180;
const ARC_MAX = (100 * Math.PI) / 180;
/** The grab band, as fractions of the widget radius. */
const RING_INNER = 0.85;
/** Depth offset of the band against the slice it lies on, see LineBatch.nudge. */
const RING_NUDGE_REST = 2;
const RING_NUDGE_ENGAGED = -1;
/** The band fades in over this long once the pointer is over the image... */
const FADE_IN_S = 0.5;
/** ...and out over this long once it has left. */
const FADE_OUT_S = 2;
const RING_OUTER = 1.0;
/** The coloured grab windows run only along the band's outer rim. */
const WINDOW_INNER = 0.97;

const RING: [number, number, number] = [0.85, 0.87, 0.92];
const RAIL: [number, number, number] = [0.55, 0.58, 0.66];
const BEAD: [number, number, number] = [1, 1, 1];
const BEAD_RIM: [number, number, number] = [0.1, 0.11, 0.14];
/** The hollow marker on the arc where the plane lands on a grid plane. */
const STOP_R_IN = 0.026;
const STOP_R_OUT = 0.036;
/** The grab windows on the band are kept at least this wide, so they still
 *  show with the snap set very small. */
const WINDOW_MIN_HALF = (0.6 * Math.PI) / 180;
/** A mark is hit over the whole width of the band, and at least this far
 *  either side of its centre, so a thin one can still be aimed at. */
const MARK_HIT_HALF = (3 * Math.PI) / 180;

/** An angle brought into (-pi, pi]. */
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A coloured window on the band: where a tilt can land on a grid plane. */
interface GrabWindow {
  centre: number;
  half: number;
  axis: vec3;
  /** Which grid axis it leads to: 0 = I, 1 = J, 2 = K. */
  index: number;
}

/** Depth cue for the guide curves: near is thick and solid, far is thin and faint. */
const NEAR_WIDTH = 5.4;
const FAR_WIDTH = 1.1;
const NEAR_ALPHA = 1;
const FAR_ALPHA = 0.12;
/** How far the far end sinks towards the background colour. */
const FOG_AMOUNT = 0.75;

function pushSeg(out: number[], a: vec3, b: vec3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

const SEGMENTS = 128;
/** The slide rail is cut into this many steps, alternately dash and gap; the
 *  tilt arc borrows the same dash length. */
const RAIL_STEPS = 48;

function ringPoint(
  centre: vec3,
  e1: vec3,
  e2: vec3,
  radius: number,
  i: number,
): vec3 {
  const a = (i / SEGMENTS) * Math.PI * 2;
  const p = vec3.scaleAndAdd(vec3.create(), centre, e1, Math.cos(a) * radius);
  return vec3.scaleAndAdd(p, p, e2, Math.sin(a) * radius);
}

function circle(
  out: number[],
  centre: vec3,
  e1: vec3,
  e2: vec3,
  radius: number,
  segments = SEGMENTS,
): void {
  const at = (i: number) => {
    const a = (i / segments) * Math.PI * 2;
    const p = vec3.scaleAndAdd(vec3.create(), centre, e1, Math.cos(a) * radius);
    return vec3.scaleAndAdd(p, p, e2, Math.sin(a) * radius);
  };
  for (let i = 0; i < segments; i++) pushSeg(out, at(i), at(i + 1));
}

/**
 * A filled disc as a triangle strip, alternating centre and rim. Built on the
 * camera axes it is a billboard, and with no lighting in the scene that reads
 * exactly as a small sphere.
 */
function disc(
  out: number[],
  centre: vec3,
  e1: vec3,
  e2: vec3,
  radius: number,
  segments = 28,
): void {
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(centre[0], centre[1], centre[2]);
    const p = vec3.scaleAndAdd(vec3.create(), centre, e1, Math.cos(a) * radius);
    vec3.scaleAndAdd(p, p, e2, Math.sin(a) * radius);
    out.push(p[0], p[1], p[2]);
  }
}

/** A stretch of the band from angle a0 to a1, as a triangle strip. */
function arcBand(
  out: number[],
  centre: vec3,
  e1: vec3,
  e2: vec3,
  rIn: number,
  rOut: number,
  a0: number,
  a1: number,
): void {
  const n = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * SEGMENTS));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const r of [rIn, rOut]) {
      out.push(
        centre[0] + (e1[0] * c + e2[0] * s) * r,
        centre[1] + (e1[1] * c + e2[1] * s) * r,
        centre[2] + (e1[2] * c + e2[2] * s) * r,
      );
    }
  }
}

/** The grab band as a closed triangle strip, inner and outer edge alternating. */
function band(out: number[], centre: vec3, e1: vec3, e2: vec3, rIn: number, rOut: number): void {
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = ringPoint(centre, e1, e2, rIn, i);
    const b = ringPoint(centre, e1, e2, rOut, i);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

/** Where the grab sits on the ring, in the plane's own axes at drag start. */
interface GrabPoint {
  grabU: number;
  grabV: number;
}

/**
 * Turn segments into a screen-space tube whose width, opacity and fog follow
 * the distance to the camera, continuously. Together with real depth testing
 * and the cylindrical shading in the fragment stage, that is what makes a curve
 * looping in front of and behind the plane read as 3D.
 */
function depthRibbon(
  segments: [vec3, vec3][],
  forward: vec3,
  color: [number, number, number],
): LineBatch[] {
  if (segments.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of segments) {
    for (const p of [a, b]) {
      const d = vec3.dot(p, forward);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  const span = hi - lo;
  const at = (p: vec3): [number, number, number] => {
    const t = span > 1e-6 ? (vec3.dot(p, forward) - lo) / span : 0;
    // Smoothstep on the fade, so both ends hold and the change reads as depth
    // rather than as a linear ramp; the taper stays linear.
    const e = t * t * (3 - 2 * t);
    return [
      NEAR_WIDTH + (FAR_WIDTH - NEAR_WIDTH) * t,
      NEAR_ALPHA + (FAR_ALPHA - NEAR_ALPHA) * e,
      e * FOG_AMOUNT,
    ];
  };

  const verts: number[] = [];
  const vertex = (p: vec3, other: vec3, side: number, dirSign: number) => {
    const [w, a, fog] = at(p);
    verts.push(p[0], p[1], p[2], other[0], other[1], other[2], side, dirSign, w, a, fog);
  };
  for (const [a, b] of segments) {
    vertex(a, b, -1, 1);
    vertex(a, b, 1, 1);
    vertex(b, a, 1, -1);
    vertex(a, b, -1, 1);
    vertex(b, a, 1, -1);
    vertex(b, a, -1, -1);
  }
  if (verts.length < RIBBON_STRIDE * 3) return [];
  return [{ verts, color, width: 1, ribbon: true, depth: 'test' }];
}

interface RotateDrag extends GrabPoint {
  kind: 'rotate';
  axis: vec3;
  arcX: vec3;
  arcY: vec3;
  radius: number;
  frame0: { u: vec3; v: vec3; n: vec3 };
  angle: number;
  /** Dash length along the arc, in radians, fixed for the whole drag: worked
   *  out every frame from the turning plane, the dashes would crawl. */
  dashAngle: number;
}

interface TranslateDrag extends GrabPoint {
  kind: 'translate';
  grab: vec3;
  normal0: vec3;
  distance0: number;
}

type DragState = RotateDrag | TranslateDrag;

export class PlaneWidget {
  private scene: Scene;
  private drag: DragState | null = null;
  private hovering: 'ring' | 'plane' | null = null;
  /** The coloured mark under the pointer, by grid axis and angle, or null. */
  private hoverMark: { index: number; centre: number } | null = null;
  /**
   * How present the band is, 0 to 1. It comes up while the pointer is over the
   * image or the band, or a drag is on, and sinks away otherwise, so at rest
   * the slice is seen clean. Linear here; eased where it is drawn.
   */
  private presence = 1;
  private lastTick = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  /** What the manipulator is doing, or what it is offering under the pointer. */
  get state(): Gesture | 'ring' | 'plane' | null {
    if (this.drag) return this.drag.kind;
    return this.hovering;
  }

  /** Where a ray crosses the grab band, or null when it misses it. */
  pick(ray: Ray): vec3 | null {
    if (!this.scene.vol) return null;
    const hit = this.scene.intersectPlane(ray);
    if (!hit) return null;
    const R = this.scene.widgetRadius();
    const r = vec3.distance(hit, this.scene.planePoint());
    return r >= R * RING_INNER && r <= R * RING_OUTER ? hit : null;
  }

  /**
   * Where a ray crosses something grabbable on the plane: the image itself, or
   * the ring. The gap between them carries no image, so a drag there belongs to
   * the camera rather than to the plane. This is also the wheel's target.
   */
  overPlane(ray: Ray): vec3 | null {
    if (!this.scene.vol) return null;
    const hit = this.scene.intersectPlane(ray);
    if (!hit) return null;
    if (this.scene.insideVolume(hit)) return hit;
    const R = this.scene.widgetRadius();
    const r = vec3.distance(hit, this.scene.planePoint());
    return r >= R * RING_INNER && r <= R * RING_OUTER ? hit : null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const next = ray === null ? null : this.pick(ray) ? 'ring' : this.overPlane(ray) ? 'plane' : null;
    const mark = ray === null ? null : this.markAt(ray);
    const changed =
      next !== this.hovering ||
      (mark === null) !== (this.hoverMark === null) ||
      (mark !== null && this.hoverMark !== null && mark.index !== this.hoverMark.index);
    this.hovering = next;
    this.hoverMark = mark;
    return changed;
  }

  /** The grid axis of the coloured mark under the pointer, or null. */
  get hoveredMark(): number | null {
    return this.hoverMark?.index ?? null;
  }

  /**
   * The coloured mark a ray lands on, or null: anywhere across the band's
   * width within the mark's stretch of angle. A double click there takes the
   * plane to that mark's cartesian plane.
   */
  markAt(ray: Ray): { index: number; centre: number } | null {
    const s = this.scene;
    if (!s.vol || !this.pick(ray)) return null;
    const hit = s.intersectPlane(ray);
    if (!hit) return null;
    const rel = vec3.sub(vec3.create(), hit, s.planePoint());
    const a = Math.atan2(vec3.dot(rel, s.v), vec3.dot(rel, s.u));
    let best: { index: number; centre: number } | null = null;
    let bestD = Infinity;
    for (const w of this.grabWindows()) {
      const d = Math.abs(wrapAngle(a - w.centre));
      if (d <= Math.max(w.half, MARK_HIT_HALF) && d < bestD) {
        bestD = d;
        best = { index: w.index, centre: w.centre };
      }
    }
    return best;
  }

  /**
   * How shown the fading parts are, 0 to 1, eased: the band, and with it the
   * volume's bounding box, which the renderer fades along.
   */
  get shown(): number {
    const p = this.presence;
    return p * p * (3 - 2 * p);
  }

  /** Show the band at full strength, to fade from there: on a new volume. */
  reveal(): void {
    this.presence = 1;
    this.lastTick = 0;
  }

  /** Advance the fade to time `now`; true while it still has a way to go. */
  tick(now: number): boolean {
    const target = this.drag !== null || this.hovering !== null ? 1 : 0;
    // Capped, so a frame after a long pause does not jump the whole fade.
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (this.presence < target) this.presence = Math.min(target, this.presence + dt / FADE_IN_S);
    else if (this.presence > target) this.presence = Math.max(target, this.presence - dt / FADE_OUT_S);
    if (this.presence === target) {
      this.lastTick = 0;
      return false;
    }
    return true;
  }

  clearHover(): void {
    this.hovering = null;
    this.hoverMark = null;
  }

  /** Tilting must be grabbed on the band; sliding works anywhere on the plane. */
  begin(ray: Ray, gesture: Gesture): boolean {
    const grab = gesture === 'rotate' ? this.pick(ray) : this.overPlane(ray);
    if (!grab) return false;
    const s = this.scene;

    // The grab as in-plane coordinates, so it stays the same material point of
    // the ring however the plane then turns or slides.
    const rel = vec3.sub(vec3.create(), grab, s.planePoint());
    const grabU = vec3.dot(rel, s.u);
    const grabV = vec3.dot(rel, s.v);

    if (gesture === 'translate') {
      this.drag = {
        kind: 'translate',
        grab: vec3.clone(grab),
        normal0: vec3.clone(s.n),
        distance0: s.distance,
        grabU,
        grabV,
      };
      return true;
    }

    // Rotation axis: in the plane, through the pivot, across the grabbed radius.
    const radial = vec3.sub(vec3.create(), grab, s.pivot);
    const axis = vec3.cross(vec3.create(), radial, s.n);
    if (vec3.length(axis) < 1e-6) return false;
    vec3.normalize(axis, axis);
    const arcX = vec3.normalize(vec3.create(), radial);
    const arcY = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, arcX));
    // Dashes of the same length in space as the slide rail's, so the two
    // guides read as one family; at least four of them on the arc.
    const radius = vec3.length(radial);
    const [lo, hi] = s.distanceRange();
    const dash = Math.max((hi - lo) / RAIL_STEPS, 1e-6);
    const dashAngle = Math.min((ARC_MAX - ARC_MIN) / 8, dash / Math.max(radius, 1e-6));
    this.drag = {
      kind: 'rotate',
      axis,
      arcX,
      arcY,
      radius,
      frame0: s.frameSnapshot(),
      angle: 0,
      dashAngle,
      grabU,
      grabV,
    };
    return true;
  }

  move(ray: Ray): void {
    const d = this.drag;
    if (!d) return;
    const s = this.scene;

    if (d.kind === 'translate') {
      const p = closestPointOnLine(d.grab, d.normal0, ray.origin, ray.dir);
      s.setDistance(vec3.dot(vec3.sub(vec3.create(), p, s.pivot), d.normal0));
      return;
    }

    d.angle = this.closestAngleOnArc(d, ray);
    s.rotate(d.axis, d.angle, d.frame0);
  }

  end(): void {
    this.drag = null;
  }

  /** Put back the state captured when the drag began. */
  cancel(): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'translate') this.scene.setDistance(d.distance0);
    else this.scene.rotate(d.axis, 0, d.frame0);
    this.drag = null;
  }

  private arcPoint(d: RotateDrag, angle: number, out = vec3.create()): vec3 {
    vec3.scaleAndAdd(out, this.scene.pivot, d.arcX, Math.cos(angle) * d.radius);
    return vec3.scaleAndAdd(out, out, d.arcY, Math.sin(angle) * d.radius);
  }

  /**
   * The angles along the arc at which the plane lands on one of the grid's
   * cartesian planes, each with the grid axis it lands on.
   *
   * Turning about `axis` sweeps the normal round the great circle
   * n(t) = cos t n0 + sin t (axis x n0), since n0 is perpendicular to the axis.
   * Against a grid axis a that is A cos t + B sin t, closest at atan2(B, A),
   * where it is sqrt(A^2 + B^2) off. The stop counts when that is inside the
   * snap, which is what will pull the normal exactly onto a; the other sign of
   * a is the same plane half a turn away; every one of those that falls on the
   * arc is a stop.
   */
  private cartesianStops(d: RotateDrag): { angle: number; axis: vec3 }[] {
    const s = this.scene;
    const axes = s.gridAxes();
    if (!axes) return [];
    const n0 = d.frame0.n;
    const w = vec3.cross(vec3.create(), d.axis, n0);
    // With the snap off only an exact hit lands, which a drag never makes,
    // but an arc that runs through an axis still shows it.
    const tol = Math.max(s.cartesianSnapDeg, 1e-3);
    const minCos = Math.cos((tol * Math.PI) / 180);
    const out: { angle: number; axis: vec3 }[] = [];
    for (const a of axes) {
      const A = vec3.dot(a, n0);
      const B = vec3.dot(a, w);
      if (Math.hypot(A, B) <= minCos) continue;
      // The other sign of a is the same plane half a turn on. The arc spans
      // more than half a turn, so near its ends a plane can be on it twice.
      const t = Math.atan2(B, A);
      for (const k of [-2, -1, 0, 1, 2]) {
        const tk = t + k * Math.PI;
        if (tk >= ARC_MIN && tk <= ARC_MAX) out.push({ angle: tk, axis: a });
      }
    }
    return out;
  }

  /**
   * Where on the band a tilt can start that will land on a grid plane, as
   * windows of angle in the plane's (u, v) axes, each with its grid axis.
   *
   * Grabbing the band at angle p tilts about the in-plane axis
   * a(p) = sin p u - cos p v, which sweeps the normal round the circle
   * perpendicular to a(p). A grid axis g lies within the snap of that circle
   * when |g . a(p)| = L |sin(p - p0)| < sin(snap), where L and p0 are the
   * length and angle of g's projection onto the plane. So the window is
   * centred where that projection points, and on the opposite side, which
   * tilts the other way to the same plane. An axis the plane is already on
   * gets none: every tilt starts from it.
   */
  private grabWindows(): GrabWindow[] {
    const s = this.scene;
    const axes = s.gridAxes();
    if (!axes) return [];
    const sinTol = Math.sin((Math.max(s.cartesianSnapDeg, 1e-3) * Math.PI) / 180);
    const out: GrabWindow[] = [];
    axes.forEach((g, index) => {
      const gu = vec3.dot(g, s.u);
      const gv = vec3.dot(g, s.v);
      const L = Math.hypot(gu, gv);
      if (L <= sinTol) return;
      const half = Math.max(WINDOW_MIN_HALF, Math.asin(sinTol / L));
      const p0 = Math.atan2(gv, gu);
      out.push(
        { centre: p0, half, axis: g, index },
        { centre: wrapAngle(p0 + Math.PI), half, axis: g, index },
      );
    });
    return out;
  }

  /** The angle whose arc point lies nearest the pointer ray. */
  private closestAngleOnArc(d: RotateDrag, ray: Ray): number {
    const distTo = (angle: number): number => {
      const p = this.arcPoint(d, angle);
      const w = vec3.sub(vec3.create(), p, ray.origin);
      vec3.scaleAndAdd(w, w, ray.dir, -vec3.dot(w, ray.dir));
      return vec3.length(w);
    };
    let best = ARC_MIN;
    let bestD = Infinity;
    const COARSE = 96;
    for (let i = 0; i <= COARSE; i++) {
      const a = ARC_MIN + ((ARC_MAX - ARC_MIN) * i) / COARSE;
      const dist = distTo(a);
      if (dist < bestD) {
        bestD = dist;
        best = a;
      }
    }
    let span = (ARC_MAX - ARC_MIN) / COARSE;
    for (let pass = 0; pass < 20; pass++) {
      const lo = Math.max(ARC_MIN, best - span);
      const hi = Math.min(ARC_MAX, best + span);
      const dl = distTo(lo);
      const dh = distTo(hi);
      if (dl < bestD) {
        bestD = dl;
        best = lo;
      }
      if (dh < bestD) {
        bestD = dh;
        best = hi;
      }
      span *= 0.6;
    }
    return best;
  }

  /** Line geometry for the manipulator, in world coordinates. */
  geometry(): LineBatch[] {
    const s = this.scene;
    if (!s.vol) return [];
    const out: LineBatch[] = [];
    // Engaged is the band itself under the pointer, or held: then it is
    // highlighted and comes in front of the image. Over the image only, it
    // is merely shown.
    const engaged = this.drag !== null || this.hovering === 'ring';
    const shown = this.shown;
    const centre = s.planePoint();
    const R = s.widgetRadius();

    // The handle is a translucent band with no outline, so there is something
    // to aim at without drawing a hard edge over the scene. Faded right out
    // it is not drawn at all, and so writes no depth either.
    const bandFill: number[] = [];
    if (shown > 0.002) band(bandFill, centre, s.u, s.v, R * RING_INNER, R * RING_OUTER);
    out.push({
      verts: bandFill,
      color: RING,
      width: 1,
      alpha: (engaged ? 0.2 : 0.07) * shown,
      strip: true,
      // Writing depth is what lets the band occlude the guide curve behind it.
      depth: 'write',
      // It lies in the plane of the slice, and where the two overlap their
      // depths are equal up to rounding, which flickers as the plane turns.
      // So the tie is settled on purpose: at rest the image wins, and once
      // the band is offered or held it comes forward over the image.
      nudge: engaged ? RING_NUDGE_ENGAGED : RING_NUDGE_REST,
    });

    const d = this.drag;
    const forward = s.cameraBasis().forward;

    // Faint stretches of the band, in the colour of the plane they lead to,
    // where grabbing it starts a tilt that can land on a grid plane. They are
    // worked out from the plane as it is now, so during a drag they follow
    // the turn frame by frame.
    if (shown > 0.002) {
      const hm = this.hoverMark;
      for (const w of this.grabWindows()) {
        const fill: number[] = [];
        arcBand(fill, centre, s.u, s.v, R * WINDOW_INNER, R * RING_OUTER, w.centre - w.half, w.centre + w.half);
        const hot =
          hm !== null && !d && hm.index === w.index && Math.abs(wrapAngle(hm.centre - w.centre)) < 1e-6;
        if (hot) {
          // The mark under the pointer shows its border: a thin outline of the
          // coloured stretch itself, in its own colour at full strength. The
          // double click is still taken across the whole band.
          const a0 = w.centre - w.half;
          const a1 = w.centre + w.half;
          const rim: number[] = [];
          const at = (a: number, r: number) =>
            vec3.scaleAndAdd(
              vec3.create(),
              vec3.scaleAndAdd(vec3.create(), centre, s.u, Math.cos(a) * r),
              s.v,
              Math.sin(a) * r,
            );
          const n = Math.max(4, Math.ceil(((a1 - a0) / (Math.PI * 2)) * SEGMENTS * 2));
          for (const r of [R * WINDOW_INNER, R * RING_OUTER]) {
            for (let i = 0; i < n; i++) {
              pushSeg(rim, at(a0 + ((a1 - a0) * i) / n, r), at(a0 + ((a1 - a0) * (i + 1)) / n, r));
            }
          }
          pushSeg(rim, at(a0, R * WINDOW_INNER), at(a0, R * RING_OUTER));
          pushSeg(rim, at(a1, R * WINDOW_INNER), at(a1, R * RING_OUTER));
          out.push({ verts: rim, color: directionColor(w.axis), width: 1, depth: 'off' });
        }
        out.push({
          verts: fill,
          color: directionColor(w.axis),
          width: 1,
          alpha: (engaged ? 0.5 : 0.28) * shown,
          strip: true,
          // One step nearer than the band, so they sit on it, and on the same
          // side of the image as it: under the image at rest, over it engaged.
          depth: 'test',
          nudge: (engaged ? RING_NUDGE_ENGAGED : RING_NUDGE_REST) - 1,
        });
      }
    }

    if (d && d.kind === 'rotate') {
      // The path the grabbed point of the ring will travel, dashed like the
      // slide rail. The arc is fixed in space from the start of the drag, and
      // so is its dash length, so the dashes stand still while the plane
      // turns. Each dash is a few chords, to follow the curve.
      const dashAngle = d.dashAngle;
      const segs: [vec3, vec3][] = [];
      const SUB = 3;
      for (let a0 = ARC_MIN; a0 < ARC_MAX; a0 += 2 * dashAngle) {
        const a1 = Math.min(ARC_MAX, a0 + dashAngle);
        let prev = this.arcPoint(d, a0);
        for (let k = 1; k <= SUB; k++) {
          const next = this.arcPoint(d, a0 + ((a1 - a0) * k) / SUB);
          segs.push([prev, next]);
          prev = next;
        }
      }
      out.push(...depthRibbon(segs, forward, RING));

      // A hollow sphere on the arc wherever the turn lands on a grid plane, in
      // the colour the plane's border will take there. It is sized so the bead
      // sits inside it when the plane snaps on.
      const cam = s.cameraBasis();
      for (const stop of this.cartesianStops(d)) {
        const p = this.arcPoint(d, stop.angle);
        const shell: number[] = [];
        band(shell, p, cam.right, cam.up, R * STOP_R_IN, R * STOP_R_OUT);
        out.push({ verts: shell, color: directionColor(stop.axis), width: 1, strip: true, depth: 'test' });
        const rim: number[] = [];
        circle(rim, p, cam.right, cam.up, R * STOP_R_OUT, 48);
        circle(rim, p, cam.right, cam.up, R * STOP_R_IN, 48);
        out.push({ verts: rim, color: BEAD_RIM, width: 1, depth: 'test' });
      }
    } else if (d && d.kind === 'translate') {
      // The rail is the normal line through the grabbed point, which is fixed
      // in space: it is anchored to the offset the drag started from, not to
      // the offset the plane happens to have right now.
      const [lo, hi] = s.distanceRange();
      const base = vec3.scaleAndAdd(vec3.create(), d.grab, d.normal0, lo - d.distance0);
      const top = vec3.scaleAndAdd(vec3.create(), d.grab, d.normal0, hi - d.distance0);
      const segs: [vec3, vec3][] = [];
      for (let i = 0; i < RAIL_STEPS; i += 2) {
        segs.push([
          vec3.lerp(vec3.create(), base, top, i / RAIL_STEPS),
          vec3.lerp(vec3.create(), base, top, (i + 1) / RAIL_STEPS),
        ]);
      }
      out.push(...depthRibbon(segs, forward, RAIL));
    }

    if (d) {
      // A bead riding the ring at the point the drag started from.
      const at = vec3.scaleAndAdd(vec3.create(), centre, s.u, d.grabU);
      vec3.scaleAndAdd(at, at, s.v, d.grabV);
      const rBead = R * 0.016;
      const cam = s.cameraBasis();

      const fill: number[] = [];
      disc(fill, at, cam.right, cam.up, rBead);
      out.push({ verts: fill, color: BEAD, width: 1, strip: true, depth: 'off' });

      const rim: number[] = [];
      circle(rim, at, cam.right, cam.up, rBead, 28);
      out.push({ verts: rim, color: BEAD_RIM, width: 1, depth: 'off' });
    }

    return out;
  }
}
