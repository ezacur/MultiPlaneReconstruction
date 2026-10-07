import { mat4, vec3 } from 'gl-matrix';
import { closestPointOnLine, type PedestalShape, type Ray, type Scene } from './scene';
import { depthRibbon, type LineBatch } from './widget';

/**
 * The pedestal: a cylinder the body surface stands on, and the handle that
 * moves the body in the scene.
 *
 * It lives in the body's own space, under the bust's cut, with its axis up the
 * body and its top, the cap, against the cut. The body goes wherever the pedestal is
 * put: the gestures here change `scene.bodyModel`, the rigid move that places
 * the body's space in the scene. The volume and its plane stay where they are,
 * so the body can be brought round them.
 *
 * The cap works like the plane's ring:
 *
 *  - **left drag on its rim** tilts the pedestal about an axis in the cap,
 *    through the cap's centre and across the grabbed radius. The centre of the
 *    turn is the cap's own, so it goes wherever the pedestal has gone;
 *  - **left drag inside the rim**, or a middle drag anywhere on the cap,
 *    slides the pedestal along its axis, along a dashed rail through the
 *    grabbed point that shows already while the pointer is over the cap.
 *
 * At the centre of the body stands a traditional rotation gizmo: three rings
 * across the body's own R, A and S axes, red, green and blue. A left drag on
 * a ring turns the body about that axis, through that centre. The rings come
 * before everything else under the pointer, the plane's ring and image
 * included: they are thin, and where they show they can be taken.
 *
 * The side, the cylindrical surface, moves it:
 *
 *  - **left drag** turns the pedestal about its own axis, carrying the grabbed
 *    point round with the pointer;
 *  - **middle drag** moves it freely, across the screen;
 *  - **right drag** moves it across the plane square to its axis.
 *
 * Every gesture is absolute: it is worked out from where the pedestal stood
 * when the drag began, so nothing drifts, and Escape puts it back there.
 */

export type PedestalZone = 'cap' | 'rim' | 'side' | 'gizmo';
export type PedestalGesture = 'tilt' | 'axial' | 'spin' | 'free' | 'planar' | 'gizmo';

/** The rim of the cap, the tilt handle, from this fraction of the radius out. */
const RIM_INNER = 0.6;
/** How far a single grab of the rim can tilt the pedestal, each way. */
const TILT_LIMIT = (60 * Math.PI) / 180;

/** Dashes on the tilt arc, each followed by a gap of the same length. */
const ARC_DASHES = 14;
/** The axial rail reaches this far each way from the grab, as a fraction of
 *  the body's height, in this many dashes. */
const RAIL_REACH = 0.25;
const RAIL_DASHES = 12;
const RAIL_COLOR: [number, number, number] = [0.5, 0.8, 1.0];
/** The spin track: a dashed circle round the side, a little outside it so it
 *  reads apart from the flutes, in this many dashes. */
const TRACK_OUT = 1.04;
const TRACK_DASHES = 36;
const SEGMENTS = 96;
/** Flutes round the side, alternately light and dark, so a turn about the
 *  axis can be seen. Must divide SEGMENTS. */
const FLUTES = 32;

/** A vivid light blue, so the pedestal stands apart from the volume, the
 *  ring and the body: sky blue rather than the pure blue of the K axis. */
const COLOR: [number, number, number] = [0.3, 0.66, 0.96];
const RIM_COLOR: [number, number, number] = [0.5, 0.8, 1.0];
/** The darker flutes, as a fraction of the lighter ones. */
const FLUTE_DARK = 0.78;

/**
 * The rotation gizmo at the centre of the body: three rings across the body's
 * own axes, R, A and S, red, green and blue as is the custom. Its radius as a
 * fraction of the pedestal's, and how close the pointer has to come to a ring,
 * as a fraction of the gizmo's radius, to take it.
 */
const GIZMO_RADIUS = 0.28;
const GIZMO_HIT = 0.08;
const GIZMO_COLORS: [number, number, number][] = [
  [0.96, 0.32, 0.3],
  [0.38, 0.86, 0.42],
  [0.4, 0.6, 1.0],
];
/** Ring widths in pixels, at rest and when offered or held. */
const GIZMO_WIDTH = 3;
const GIZMO_WIDTH_HOT = 5.5;
const GIZMO_SEGMENTS = 96;
/**
 * Beyond the three rings, the custom two more handles: an outer white ring
 * facing the camera, which turns the body about the line of sight, and a
 * centre that moves it across the screen. Ring indices 3 and 4.
 */
const VIEW_RING = 3;
const CENTRE = 4;
/** The outer ring's radius, and the centre's, as fractions of the rings'. */
const VIEW_RING_SCALE = 1.3;
const CENTRE_SCALE = 0.2;
const GIZMO_WHITE: [number, number, number] = [0.95, 0.96, 0.98];

/**
 * The pedestal and the gizmo fade when they are not in use. They come up fast
 * once the pointer is on the body, the pedestal or the gizmo, stay for a while
 * after it leaves, and then sink away. In seconds.
 */
const FADE_IN_S = 0.25;
const HOLD_S = 10;
const FADE_OUT_S = 1.5;
/** The shortest the screen image of a turn's tangent is taken to be, as a
 *  fraction of the radius, so a grab seen end on does not race. */
const TANGENT_FLOOR = 0.3;

type Shape = PedestalShape;

interface Hit {
  zone: PedestalZone;
  point: vec3;
  t: number;
  /** For the gizmo: which of its rings, 0, 1 or 2 for R, A or S. */
  ring?: number;
}

interface Drag {
  gesture: PedestalGesture;
  zone: PedestalZone;
  /** The pedestal's placement when the drag began. */
  model0: mat4;
  /** The grabbed point, in the body's space. */
  grab: vec3;
  shape: Shape;
  /** Tilt, and a gizmo ring: the axis of the turn. */
  axis?: vec3;
  /** Spin: the height of the grabbed circle. */
  height?: number;
  /** Free and planar moves: the plane the pointer is followed on. */
  normal?: vec3;
  /** Gizmo: the ring held, by the body axis it turns about. */
  ring?: number;
  /** Gizmo and spin: the pointer's ray at the press, in the body's space as
   *  it was then, to measure how far the pointer has gone since. */
  ray0?: Ray;
}

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
function tangentTurn(axis: vec3, centre: vec3, grab: vec3, ray0: Ray, ray: Ray): number {
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

/** A turn of `angle` about the line through `p` along unit `axis`. */
function turnAbout(p: vec3, axis: vec3, angle: number): mat4 {
  const m = mat4.fromTranslation(mat4.create(), p);
  mat4.rotate(m, m, angle, axis);
  return mat4.translate(m, m, vec3.negate(vec3.create(), p));
}

/** Where a ray meets the plane through `p` with unit normal `n`, if ahead. */
function onPlane(ray: Ray, p: vec3, n: vec3): vec3 | null {
  const denom = vec3.dot(ray.dir, n);
  if (Math.abs(denom) < 1e-6) return null;
  const t = vec3.dot(vec3.sub(vec3.create(), p, ray.origin), n) / denom;
  return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
}

export class Pedestal {
  private scene: Scene;
  private hover: PedestalZone | null = null;
  /** Where the pointer is on the pedestal, in the body's space, for the arc a
   *  tilt from the rim would follow. */
  private hoverPoint: vec3 | null = null;
  /** The gizmo ring under the pointer, or null. */
  private hoverRing: number | null = null;
  /** Whether the pointer is on the body surface itself. */
  private overBodySurface = false;
  /** How shown the pedestal and the gizmo are, 0 to 1, linear. */
  private presence = 1;
  /** When they were last in use, in ms; they hold until HOLD_S after it. */
  private lastUse = performance.now();
  private lastTick = 0;
  private drag: Drag | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  /** The zone under the pointer, or the one held by a drag. */
  get zone(): PedestalZone | null {
    return this.drag?.zone ?? this.hover;
  }

  get gesture(): PedestalGesture | null {
    return this.drag?.gesture ?? null;
  }

  /** The gizmo ring held or under the pointer: 0, 1 or 2 for R, A or S. */
  get gizmoRing(): number | null {
    if (this.drag) return this.drag.ring ?? null;
    return this.hoverRing;
  }

  /** The gizmo's rings: for each, its axis and two unit directions across it
   *  that span the ring's plane, right-handed. The three body axes, then the
   *  outer ring, which faces the camera as it is now. */
  private gizmoFrames(s: Shape): [vec3, vec3, vec3][] {
    const cam = this.scene.cameraBasis();
    const m = this.scene.bodyModel;
    return [
      [s.e1, s.e2, s.a],
      [s.e2, s.a, s.e1],
      [s.a, s.e1, s.e2],
      [
        this.toBodyDirection(cam.forward, m),
        this.toBodyDirection(cam.right, m),
        this.toBodyDirection(cam.up, m),
      ],
    ];
  }

  /** A ring's radius in the body's space. */
  private gizmoRadius(s: Shape, ring: number): number {
    return s.r * GIZMO_RADIUS * (ring === VIEW_RING ? VIEW_RING_SCALE : 1);
  }

  /** The gizmo's centre, in the body's space: the middle of the body's box. */
  private gizmoCentre(): vec3 {
    const body = this.scene.body;
    if (!body) return vec3.create();
    return vec3.lerp(vec3.create(), body.min, body.max, 0.5);
  }

  /** A point on one of the gizmo's rings, in the body's space. */
  private gizmoPoint(s: Shape, ring: number, angle: number): vec3 {
    const [, u, v] = this.gizmoFrames(s)[ring];
    const g = this.gizmoRadius(s, ring);
    const p = vec3.scaleAndAdd(vec3.create(), this.gizmoCentre(), u, Math.cos(angle) * g);
    return vec3.scaleAndAdd(p, p, v, Math.sin(angle) * g);
  }

  /** The gizmo ring a ray passes close enough to take, and where, or null. */
  private gizmoHit(ray: Ray, s: Shape): Hit | null {
    const tol = s.r * GIZMO_RADIUS * GIZMO_HIT;
    // The centre: within its little disc of the gizmo's middle.
    const centre = this.gizmoCentre();
    const wc = vec3.sub(vec3.create(), centre, ray.origin);
    const tc = vec3.dot(wc, ray.dir);
    vec3.scaleAndAdd(wc, wc, ray.dir, -tc);
    if (vec3.length(wc) <= s.r * GIZMO_RADIUS * CENTRE_SCALE) {
      return { zone: 'gizmo', point: centre, t: tc, ring: CENTRE };
    }
    let best: Hit | null = null;
    let bestD = tol;
    for (let ring = 0; ring <= VIEW_RING; ring++) {
      for (let i = 0; i < GIZMO_SEGMENTS; i++) {
        const p = this.gizmoPoint(s, ring, (i / GIZMO_SEGMENTS) * Math.PI * 2);
        const w = vec3.sub(vec3.create(), p, ray.origin);
        const t = vec3.dot(w, ray.dir);
        vec3.scaleAndAdd(w, w, ray.dir, -t);
        const dist = vec3.length(w);
        // The closest ring wins; between equals, the one in front.
        if (dist < bestD || (best && Math.abs(dist - bestD) < 1e-6 && t < best.t)) {
          bestD = dist;
          best = { zone: 'gizmo', point: p, t, ring };
        }
      }
    }
    return best;
  }

  /** The cylinder, in the body's space; the scene works it out, since the
   *  camera frames it too. */
  private shape(): Shape | null {
    return this.scene.pedestalShape();
  }

  /** A scene ray taken into the body's space under a given placement. */
  private toBody(ray: Ray, model: mat4): Ray {
    const inv = mat4.invert(mat4.create(), model) ?? mat4.create();
    const origin = vec3.transformMat4(vec3.create(), ray.origin, inv);
    const ahead = vec3.transformMat4(vec3.create(), vec3.add(vec3.create(), ray.origin, ray.dir), inv);
    return { origin, dir: vec3.normalize(vec3.create(), vec3.sub(ahead, ahead, origin)) };
  }

  /** A scene direction taken into the body's space under a given placement. */
  private toBodyDirection(d: vec3, model: mat4): vec3 {
    const inv = mat4.invert(mat4.create(), model) ?? mat4.create();
    const o = vec3.transformMat4(vec3.create(), [0, 0, 0], inv);
    const p = vec3.transformMat4(vec3.create(), d, inv);
    return vec3.normalize(p, vec3.sub(p, p, o));
  }

  /** The nearest part of the pedestal a ray in the body's space meets. */
  private hit(ray: Ray, s: Shape): Hit | null {
    // The gizmo sits inside the cap and the pedestal, and comes first.
    const g = this.gizmoHit(ray, s);
    if (g) return g;
    let best: Hit | null = null;
    // The cap: a disc across the axis at its centre.
    const denom = vec3.dot(ray.dir, s.a);
    if (Math.abs(denom) > 1e-9) {
      const t = vec3.dot(vec3.sub(vec3.create(), s.c, ray.origin), s.a) / denom;
      if (t > 0) {
        const p = vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
        const rho = vec3.distance(p, s.c);
        if (rho <= s.r) best = { zone: rho >= s.r * RIM_INNER ? 'rim' : 'cap', point: p, t };
      }
    }
    // The side: the cylinder of radius r about the axis, below the cap.
    const w = vec3.sub(vec3.create(), ray.origin, s.c);
    const dPerp = vec3.scaleAndAdd(vec3.create(), ray.dir, s.a, -vec3.dot(ray.dir, s.a));
    const wPerp = vec3.scaleAndAdd(vec3.create(), w, s.a, -vec3.dot(w, s.a));
    const A = vec3.dot(dPerp, dPerp);
    const B = 2 * vec3.dot(dPerp, wPerp);
    const C = vec3.dot(wPerp, wPerp) - s.r * s.r;
    const disc = B * B - 4 * A * C;
    if (A > 1e-12 && disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t <= 0 || (best && t >= best.t)) continue;
        const p = vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
        const height = vec3.dot(vec3.sub(vec3.create(), p, s.c), s.a);
        if (height <= 0 && height >= -s.h) {
          best = { zone: 'side', point: p, t };
          break;
        }
      }
    }
    return best;
  }

  /** Whether a scene ray takes one of the gizmo's rings. */
  overGizmo(ray: Ray | null): boolean {
    const s = this.shape();
    if (!s || !ray) return false;
    return this.gizmoHit(this.toBody(ray, this.scene.bodyModel), s) !== null;
  }

  /** The zone of the pedestal a scene ray lands on, or null. */
  pick(ray: Ray | null): PedestalZone | null {
    const s = this.shape();
    if (!s || !ray) return null;
    return this.hit(this.toBody(ray, this.scene.bodyModel), s)?.zone ?? null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const s = this.shape();
    const hit = s && ray ? this.hit(this.toBody(ray, this.scene.bodyModel), s) : null;
    const next = hit?.zone ?? null;
    const ring = hit?.ring ?? null;
    const changed = next !== this.hover || ring !== this.hoverRing;
    this.hover = next;
    this.hoverPoint = hit ? hit.point : null;
    this.hoverRing = ring;
    return changed;
  }

  /** Whether the pedestal and the gizmo are in use: held, or under the
   *  pointer, or the pointer on the body itself. */
  private get inUse(): boolean {
    return this.drag !== null || this.hover !== null || this.overBodySurface;
  }

  /** How shown the pedestal and the gizmo are, 0 to 1, eased. */
  get shown(): number {
    const p = this.presence;
    return p * p * (3 - 2 * p);
  }

  /** Show them now, to hold and fade from there: on a new body or volume. */
  reveal(): void {
    this.presence = 1;
    this.lastUse = performance.now();
    this.lastTick = 0;
  }

  /**
   * Advance the fade to time `now`, in ms; true while it is moving. While they
   * are being held up after use, nothing moves: see untilFade().
   */
  tick(now: number): boolean {
    if (this.inUse) this.lastUse = now;
    const target = this.inUse || now - this.lastUse < HOLD_S * 1000 ? 1 : 0;
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

  /** Milliseconds until the fade out is due, while they are being held up
   *  after use; null when no fade is pending. */
  untilFade(now: number): number | null {
    if (this.inUse || this.presence === 0) return null;
    const left = this.lastUse + HOLD_S * 1000 - now;
    return left > 0 ? left : null;
  }

  /**
   * Whether a scene ray meets the body surface: every triangle of the body,
   * where the pedestal has put it, tried in turn (Moller-Trumbore). A few
   * thousand triangles, cheap enough on each pointer move.
   */
  overBody(ray: Ray | null): boolean {
    const body = this.scene.body;
    if (!body || !ray) return false;
    const r = this.toBody(ray, this.scene.bodyModel);
    const P = body.positions;
    const I = body.indices;
    const o = r.origin;
    const d = r.dir;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3;
      const b = I[k + 1] * 3;
      const c = I[k + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det;
      const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) return true;
    }
    return false;
  }

  /** Note whether the pointer is on the body surface; true if that changed. */
  setBodyHover(on: boolean): boolean {
    const changed = on !== this.overBodySurface;
    this.overBodySurface = on;
    return changed;
  }

  clearHover(): void {
    this.overBodySurface = false;
    this.hover = null;
    this.hoverPoint = null;
    this.hoverRing = null;
  }

  /**
   * The track a spin carries the grabbed point round, as dashed segments in
   * the scene: the circle round the axis at the grab's height, just outside
   * the side. While spinning, it is fixed where the drag began; over the
   * side, it is the track a drag from there would follow.
   */
  private spinTrack(s: Shape): [vec3, vec3][] {
    const d = this.drag;
    let grab: vec3;
    let model: mat4;
    if (d && d.gesture === 'spin') {
      grab = d.grab;
      model = d.model0;
    } else if (!d && this.hover === 'side' && this.hoverPoint) {
      grab = this.hoverPoint;
      model = this.scene.bodyModel;
    } else {
      return [];
    }
    const height = vec3.dot(vec3.sub(vec3.create(), grab, s.c), s.a);
    const centre = vec3.scaleAndAdd(vec3.create(), s.c, s.a, height);
    const radius = s.r * TRACK_OUT;
    const point = (ang: number) => {
      const p = vec3.scaleAndAdd(vec3.create(), centre, s.e1, Math.cos(ang) * radius);
      vec3.scaleAndAdd(p, p, s.e2, Math.sin(ang) * radius);
      return vec3.transformMat4(p, p, model);
    };
    const segs: [vec3, vec3][] = [];
    const step = Math.PI / TRACK_DASHES;
    const SUB = 3;
    for (let k = 0; k < TRACK_DASHES; k++) {
      const a0 = 2 * k * step;
      for (let i = 0; i < SUB; i++) {
        segs.push([point(a0 + (step * i) / SUB), point(a0 + (step * (i + 1)) / SUB)]);
      }
    }
    return segs;
  }

  /**
   * The rail an axial slide runs along, as dashed segments in the scene: the
   * line through the grabbed point along the pedestal's axis. While sliding,
   * it is fixed where the drag began; over the cap, it is the rail a drag
   * from there would follow.
   */
  private axialRail(s: Shape): [vec3, vec3][] {
    const d = this.drag;
    let grab: vec3;
    let model: mat4;
    if (d && d.gesture === 'axial') {
      grab = d.grab;
      model = d.model0;
    } else if (!d && this.hover === 'cap' && this.hoverPoint) {
      grab = this.hoverPoint;
      model = this.scene.bodyModel;
    } else {
      return [];
    }
    const body = this.scene.body;
    const reach = (body ? body.max[2] - body.min[2] : s.r * 4) * RAIL_REACH;
    const point = (t: number) => {
      const p = vec3.scaleAndAdd(vec3.create(), grab, s.a, t);
      return vec3.transformMat4(p, p, model);
    };
    const segs: [vec3, vec3][] = [];
    const step = (2 * reach) / (2 * RAIL_DASHES - 1);
    for (let k = 0; k < RAIL_DASHES; k++) {
      const t0 = -reach + 2 * k * step;
      segs.push([point(t0), point(t0 + step)]);
    }
    return segs;
  }

  /**
   * The arc a tilt from the rim travels, as dashed segments in the scene: the
   * grabbed point swinging up to 60 degrees each way about the axis in the cap
   * across the grabbed radius. While tilting, it is the arc of the drag, fixed
   * where it was when the drag began; over the rim, the arc a drag from there
   * would follow.
   */
  private tiltArc(s: Shape): [vec3, vec3][] {
    const d = this.drag;
    let grab: vec3;
    let model: mat4;
    if (d && d.gesture === 'tilt') {
      grab = d.grab;
      model = d.model0;
    } else if (!d && this.hover === 'rim' && this.hoverPoint) {
      grab = this.hoverPoint;
      model = this.scene.bodyModel;
    } else {
      return [];
    }
    const radial = vec3.sub(vec3.create(), grab, s.c);
    const axis = vec3.cross(vec3.create(), radial, s.a);
    if (vec3.length(axis) < 1e-6) return [];
    vec3.normalize(axis, axis);
    const radius = vec3.length(radial);
    const arcX = vec3.normalize(vec3.create(), radial);
    const arcY = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, arcX));
    const point = (ang: number) => {
      const p = vec3.scaleAndAdd(vec3.create(), s.c, arcX, Math.cos(ang) * radius);
      vec3.scaleAndAdd(p, p, arcY, Math.sin(ang) * radius);
      return vec3.transformMat4(p, p, model);
    };
    const segs: [vec3, vec3][] = [];
    const step = (2 * TILT_LIMIT) / (2 * ARC_DASHES - 1);
    const SUB = 3;
    for (let k = 0; k < ARC_DASHES; k++) {
      const a0 = -TILT_LIMIT + 2 * k * step;
      for (let i = 0; i < SUB; i++) {
        segs.push([point(a0 + (step * i) / SUB), point(a0 + (step * (i + 1)) / SUB)]);
      }
    }
    return segs;
  }

  /** Start a drag from a scene ray with a mouse button; false if it misses. */
  begin(ray: Ray, button: number): boolean {
    const s = this.shape();
    if (!s) return false;
    const model0 = mat4.clone(this.scene.bodyModel);
    const hit = this.hit(this.toBody(ray, model0), s);
    if (!hit) return false;

    let gesture: PedestalGesture | null = null;
    if (hit.zone === 'gizmo') gesture = button === 0 ? (hit.ring === CENTRE ? 'free' : 'gizmo') : null;
    else if (hit.zone === 'rim') gesture = button === 0 ? 'tilt' : button === 1 ? 'axial' : null;
    else if (hit.zone === 'cap') gesture = button === 0 || button === 1 ? 'axial' : null;
    else gesture = button === 0 ? 'spin' : button === 1 ? 'free' : 'planar';
    if (!gesture) return false;

    const d: Drag = { gesture, zone: hit.zone, model0, grab: vec3.clone(hit.point), shape: s };
    if (gesture === 'gizmo' && hit.ring !== undefined) {
      d.ring = hit.ring;
      d.ray0 = this.toBody(ray, model0);
      // The ring's axis as it is at the press: the outer one follows the
      // camera, and the turn has to keep to one axis.
      d.axis = vec3.clone(this.gizmoFrames(s)[hit.ring][0]);
    } else if (gesture === 'free' && hit.ring === CENTRE) {
      // The centre: across the screen, as the side's middle button does.
      d.ring = CENTRE;
      d.normal = this.toBodyDirection(this.scene.cameraBasis().forward, model0);
    } else if (gesture === 'tilt') {
      // In the cap, through its centre, across the grabbed radius.
      const radial = vec3.sub(vec3.create(), hit.point, s.c);
      const axis = vec3.cross(vec3.create(), radial, s.a);
      if (vec3.length(axis) < 1e-6) return false;
      vec3.normalize(axis, axis);
      d.axis = axis;
      d.ray0 = this.toBody(ray, model0);
    } else if (gesture === 'spin') {
      const rel = vec3.sub(vec3.create(), hit.point, s.c);
      d.height = vec3.dot(rel, s.a);
      d.ray0 = this.toBody(ray, model0);
    } else if (gesture === 'free') {
      // Across the screen: the plane through the grab facing the camera.
      d.normal = this.toBodyDirection(this.scene.cameraBasis().forward, model0);
    } else if (gesture === 'planar') {
      d.normal = vec3.clone(s.a);
    }
    this.drag = d;
    return true;
  }

  move(ray: Ray): void {
    const d = this.drag;
    if (!d) return;
    const s = d.shape;
    // Always against the placement the drag began from, so it is absolute.
    const r = this.toBody(ray, d.model0);
    let local: mat4 | null = null;

    if (d.gesture === 'gizmo' && d.ring !== undefined && d.ray0 && d.axis) {
      // Turn about the held ring's axis, through the gizmo's centre, by the
      // pointer's travel along the grabbed point's tangent.
      const axis = d.axis;
      const centre = this.gizmoCentre();
      local = turnAbout(centre, axis, tangentTurn(axis, centre, d.grab, d.ray0, r));
    } else if (d.gesture === 'tilt' && d.axis && d.ray0) {
      // By the pointer's travel along the grabbed point's tangent, as the
      // gizmo and the spin: projecting the pointer onto the arc moved in
      // jumps, and seen edge on stood still and leapt by turns.
      const angle = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, tangentTurn(d.axis, s.c, d.grab, d.ray0, r)));
      local = turnAbout(s.c, d.axis, angle);
    } else if (d.gesture === 'axial') {
      const p = closestPointOnLine(d.grab, s.a, r.origin, r.dir);
      const along = vec3.dot(vec3.sub(vec3.create(), p, d.grab), s.a);
      local = mat4.fromTranslation(mat4.create(), vec3.scale(vec3.create(), s.a, along));
    } else if (d.gesture === 'spin' && d.height !== undefined && d.ray0) {
      // Round the axis by the pointer's travel along the grabbed point's
      // tangent, the same as the gizmo's rings: even at the silhouette, where
      // the ray grazes the side, and near the axis, where a reading of the
      // angle off the pointer's position would leap.
      const centre = vec3.scaleAndAdd(vec3.create(), s.c, s.a, d.height);
      local = turnAbout(s.c, s.a, tangentTurn(s.a, centre, d.grab, d.ray0, r));
    } else if ((d.gesture === 'free' || d.gesture === 'planar') && d.normal) {
      // Seen edge on, the plane gives no reading: hold still rather than leap.
      if (Math.abs(vec3.dot(r.dir, d.normal)) < 0.05) return;
      const p = onPlane(r, d.grab, d.normal);
      if (!p) return;
      local = mat4.fromTranslation(mat4.create(), vec3.sub(vec3.create(), p, d.grab));
    }
    if (local) mat4.mul(this.scene.bodyModel, d.model0, local);
  }

  end(): void {
    this.drag = null;
  }

  /** Put the pedestal back where the drag began. */
  cancel(): void {
    if (!this.drag) return;
    mat4.copy(this.scene.bodyModel, this.drag.model0);
    this.drag = null;
  }

  /**
   * The pedestal's geometry, in the body's space. At rest it is a faint,
   * translucent shape. Each of its three parts, the rim, the inside of the
   * cap and the side, turns solid and shaded on its own: while the pointer is
   * on it, as the ring comes forward when it is offered, so it is plain which
   * part a press would take, and while a drag holds it, so it is plain which
   * part is working. The rest stays faint. The side and the rim are
   * fluted, light and dark in turn, so a turn about the axis can be seen.
   */
  geometry(): LineBatch[] {
    const s = this.shape();
    if (!s) return [];
    const shown = this.shown;
    if (shown < 0.002) return [];
    const batches = this.geometryShown(s);
    if (shown > 0.998) return batches;
    // Fading: everything at that fraction of its strength, and nothing
    // solid, so a part on its way out does not hide what is behind it.
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

  /** The pedestal's and the gizmo's geometry at full strength. */
  private geometryShown(s: Shape): LineBatch[] {
    /** Whether a part is drawn solid: the one a drag holds, else the one
     *  under the pointer. */
    const solid = (z: PedestalZone) => (this.drag ? this.drag.zone === z : this.hover === z);
    const at = (a: number, height: number, radius = s.r) => {
      const p = vec3.scaleAndAdd(vec3.create(), s.c, s.a, height);
      vec3.scaleAndAdd(p, p, s.e1, Math.cos(a) * radius);
      return vec3.scaleAndAdd(p, p, s.e2, Math.sin(a) * radius);
    };
    const angle = (i: number) => (i / SEGMENTS) * Math.PI * 2;
    const push = (out: number[], p: vec3) => out.push(p[0], p[1], p[2]);
    const shade = (c: [number, number, number], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
    // Light from the eye: a face is as bright as it turns towards the camera.
    const toEye = vec3.negate(
      vec3.create(),
      this.toBodyDirection(this.scene.cameraBasis().forward, this.scene.bodyModel),
    );
    const lit = (normal: vec3) => 0.45 + 0.55 * Math.max(0, vec3.dot(normal, toEye));

    // The tilt arc, the same dashed, depth-cued tube as the plane's ring has.
    // It is worked out in the scene, so it stays put while the pedestal turns,
    // and taken back into the body's space as it is now, the space this
    // geometry is drawn in. It is drawn over everything: it rises from the
    // rim under the slice and dips into the pedestal, so tested for depth it
    // would be mostly hidden; the taper, fade and fog still say how far each
    // stretch of it is.
    // The axial rail and the spin track likewise, for a slide from the cap
    // and a spin from the side.
    const arcBatches: LineBatch[] = [];
    const inv = mat4.invert(mat4.create(), this.scene.bodyModel) ?? mat4.create();
    const back = (p: vec3) => vec3.transformMat4(vec3.create(), p, inv);
    const forward = this.toBodyDirection(this.scene.cameraBasis().forward, this.scene.bodyModel);
    for (const [guide, color] of [
      [this.tiltArc(s), RIM_COLOR],
      [this.axialRail(s), RAIL_COLOR],
      [this.spinTrack(s), RIM_COLOR],
    ] as [[vec3, vec3][], [number, number, number]][]) {
      if (!guide.length) continue;
      const local: [vec3, vec3][] = guide.map(([p, q]) => [back(p), back(q)]);
      arcBatches.push(...depthRibbon(local, forward, color).map((b): LineBatch => ({ ...b, depth: 'off' })));
    }
    // The gizmo's three rings: constant-width tubes whose far side fades,
    // drawn over everything, since half of each is inside the pedestal. The
    // ring offered or held is drawn thicker.
    const hotRing = this.gizmoRing;
    for (let ring = 0; ring < 3; ring++) {
      const segs: [vec3, vec3][] = [];
      for (let i = 0; i < GIZMO_SEGMENTS; i++) {
        segs.push([
          this.gizmoPoint(s, ring, (i / GIZMO_SEGMENTS) * Math.PI * 2),
          this.gizmoPoint(s, ring, ((i + 1) / GIZMO_SEGMENTS) * Math.PI * 2),
        ]);
      }
      const hot = hotRing === ring;
      arcBatches.push(
        ...depthRibbon(segs, forward, GIZMO_COLORS[ring], {
          constantWidth: hot ? GIZMO_WIDTH_HOT : GIZMO_WIDTH,
          alphaScale: hot ? 1 : 0.85,
          fog: false,
        }).map((b): LineBatch => ({ ...b, depth: 'off' })),
      );
    }

    // The outer ring, facing the camera: one depth all round, so a plain
    // white band of constant width.
    {
      const segs: [vec3, vec3][] = [];
      for (let i = 0; i < GIZMO_SEGMENTS; i++) {
        segs.push([
          this.gizmoPoint(s, VIEW_RING, (i / GIZMO_SEGMENTS) * Math.PI * 2),
          this.gizmoPoint(s, VIEW_RING, ((i + 1) / GIZMO_SEGMENTS) * Math.PI * 2),
        ]);
      }
      const hot = hotRing === VIEW_RING;
      arcBatches.push(
        ...depthRibbon(segs, forward, GIZMO_WHITE, {
          constantWidth: hot ? GIZMO_WIDTH_HOT : GIZMO_WIDTH,
          alphaScale: hot ? 1 : 0.8,
          fog: false,
        }).map((b): LineBatch => ({ ...b, depth: 'off' })),
      );
    }
    // The centre: a small white disc facing the camera, with four arrowheads
    // round it pointing out, the sign for moving.
    {
      const [, right, up] = this.gizmoFrames(s)[VIEW_RING];
      const centre = this.gizmoCentre();
      const rc = s.r * GIZMO_RADIUS * CENTRE_SCALE;
      const at = (x: number, y: number) => {
        const p = vec3.scaleAndAdd(vec3.create(), centre, right, x);
        return vec3.scaleAndAdd(p, p, up, y);
      };
      const hot = hotRing === CENTRE;
      const disc: number[] = [];
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const c0 = at(0, 0);
        const c1 = at(Math.cos(a) * rc * 0.55, Math.sin(a) * rc * 0.55);
        disc.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2]);
      }
      arcBatches.push({ verts: disc, color: GIZMO_WHITE, width: 1, alpha: hot ? 1 : 0.85, strip: true, depth: 'off' });
      const arrows: number[] = [];
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        // A small triangle pointing out along (dx, dy).
        const tip = at(dx * rc * 1.25, dy * rc * 1.25);
        const b1 = at(dx * rc * 0.8 - dy * rc * 0.28, dy * rc * 0.8 + dx * rc * 0.28);
        const b2 = at(dx * rc * 0.8 + dy * rc * 0.28, dy * rc * 0.8 - dx * rc * 0.28);
        arrows.push(...tip, ...b1, ...b2);
      }
      arcBatches.push({
        verts: arrows,
        color: GIZMO_WHITE,
        width: 1,
        alpha: hot ? 1 : 0.85,
        triangles: true,
        depth: 'off',
      });
    }

    const out: LineBatch[] = [];
    // Solid, a part writes depth and so hides what is behind it; faint, it
    // only tests, like the other scaffolding.
    const depth = (z: PedestalZone) => (solid(z) ? 'write' : 'test');

    // The side, one flute at a time, each in its own shade.
    const per = SEGMENTS / FLUTES;
    for (let f = 0; f < FLUTES; f++) {
      const verts: number[] = [];
      for (let i = f * per; i <= (f + 1) * per; i++) {
        push(verts, at(angle(i), 0));
        push(verts, at(angle(i), -s.h));
      }
      const mid = angle((f + 0.5) * per);
      const normal = vec3.add(
        vec3.create(),
        vec3.scale(vec3.create(), s.e1, Math.cos(mid)),
        vec3.scale(vec3.create(), s.e2, Math.sin(mid)),
      );
      const tone = (f % 2 === 0 ? 1 : FLUTE_DARK) * (solid('side') ? lit(normal) : 1);
      out.push({
        verts,
        color: shade(COLOR, tone),
        width: 1,
        alpha: solid('side') ? 1 : 0.1,
        strip: true,
        depth: depth('side'),
      });
    }

    // The cap's inside, and its rim.
    const capLight = lit(s.a);
    const cap: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      push(cap, s.c);
      push(cap, at(angle(i), 0, s.r * RIM_INNER));
    }
    out.push({
      verts: cap,
      color: shade(COLOR, solid('cap') ? capLight : 1),
      width: 1,
      alpha: solid('cap') ? 1 : 0.07,
      strip: true,
      depth: depth('cap'),
    });
    // The rim, plain: the side's flutes are what show a turn about the axis.
    const rim: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      push(rim, at(angle(i), 0, s.r * RIM_INNER));
      push(rim, at(angle(i), 0));
    }
    out.push({
      verts: rim,
      color: shade(RIM_COLOR, solid('rim') ? capLight : 1),
      width: 1,
      alpha: solid('rim') ? 1 : 0.16,
      strip: true,
      depth: depth('rim'),
    });
    return [...out, ...arcBatches];
  }
}
