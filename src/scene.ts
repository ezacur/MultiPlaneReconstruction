import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import type { Volume } from './nifti';
import { snapToAxes } from './quantise';

/**
 * Geometry of the viewer.
 *
 * There is exactly one plane. Its state is:
 *
 *  - an orthonormal right-handed frame (u, v, n) of world directions, where u
 *    is screen right and v is screen up in the 2D view, and n = u x v is the
 *    plane normal;
 *  - a `pivot` point, which rotations turn about. It is fixed at the centre of
 *    the volume for the life of the volume, as in `draggablePlaneWidget.m`;
 *  - a `distance`, the offset of the plane from the pivot along n.
 *
 * The plane therefore sits at `pivot + n * distance`. "Oblique" is not a
 * special case: it is just a frame that is not aligned with the voxel grid or
 * the world axes.
 *
 * World coordinates are NIfTI's RAS+ convention, in millimetres.
 */

export type PlaneSpace = 'grid' | 'world';
export type SlabMode = 0 | 1 | 2; // 0 = MIP, 1 = mean, 2 = MinIP

/** Names of the voxel axes, in the order the NIfTI array is indexed. */
export const GRID_AXIS_NAMES = ['I', 'J', 'K'];
export const WORLD_PLANE_NAMES = ['Sagital', 'Coronal', 'Axial'];

export interface Ray {
  origin: vec3;
  dir: vec3;
}

/** One arm of the corner axis marker, in normalised device coordinates. */
export interface TriadAxis {
  label: string;
  tip: [number, number];
  /** Positive when the axis points away from the viewer. */
  depth: number;
  color: [number, number, number];
}

/** A face of the volume box, named by the voxel axis normal to it. */
export interface BoxFace {
  /** Voxel axis index: 0 = I, 1 = J, 2 = K. */
  axis: number;
  /** +1 for the far face along that axis, -1 for the near one. */
  sign: number;
  /** The four corners, in world mm. */
  corners: vec3[];
  color: [number, number, number];
}

/** Size of the corner axis marker, as a fraction of the pane's half-height. */
const TRIAD_RADIUS = 0.13;

/** An orthonormal right-handed plane frame. */
export interface Frame {
  u: vec3;
  v: vec3;
  n: vec3;
}

/** An in-flight animated move from one plane to another. */
interface Transition {
  q0: quat;
  q1: quat;
  d0: number;
  d1: number;
  start: number;
  duration: number;
}

/** Default length of a plane transition, in milliseconds. */
export const TRANSITION_MS = 420;

const RAS_LETTERS: ReadonlyArray<readonly [string, string]> = [
  ['L', 'R'],
  ['P', 'A'],
  ['I', 'S'],
];

const WORLD_R = vec3.fromValues(1, 0, 0);
const WORLD_A = vec3.fromValues(0, 1, 0);
const WORLD_S = vec3.fromValues(0, 0, 1);

function dominantAxis(d: vec3): number {
  let axis = 0;
  let best = Math.abs(d[0]);
  for (let i = 1; i < 3; i++) {
    const m = Math.abs(d[i]);
    if (m > best) {
      best = m;
      axis = i;
    }
  }
  return axis;
}

/** The anatomical letter a world direction points towards. */
export function directionLabel(d: vec3): string {
  const axis = dominantAxis(d);
  return RAS_LETTERS[axis][d[axis] >= 0 ? 1 : 0];
}

/**
 * Colour of a world direction: x to red, y to green, z to blue, scaled so the
 * dominant axis is at full strength. An axis-aligned direction gets a pure hue
 * and an oblique one blends between them.
 */
export function directionColor(d: vec3): [number, number, number] {
  const c: [number, number, number] = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  // A small floor keeps a pure blue or red from going too dark to see.
  return [0.12 + (0.88 * c[0]) / m, 0.12 + (0.88 * c[1]) / m, 0.12 + (0.88 * c[2]) / m];
}

/** Rotation of `angle` radians about a unit `axis`, as a mat4. */
export function rotationAbout(axis: vec3, angle: number): mat4 {
  return mat4.fromRotation(mat4.create(), angle, axis) ?? mat4.create();
}

export class Scene {
  vol: Volume | null = null;

  u: vec3 = vec3.fromValues(1, 0, 0);
  v: vec3 = vec3.fromValues(0, 1, 0);
  n: vec3 = vec3.fromValues(0, 0, 1);

  /** Fixed at the volume centre; rotations turn about it. */
  readonly pivot: vec3 = vec3.create();
  distance = 0;

  windowWidth = 400;
  windowLevel = 40;

  slabMm = 0;
  slabMode: SlabMode = 0;

  /**
   * Saturation colours. When set, voxels the window clips are painted in these
   * instead of in flat black or white, so what is being thrown away is visible
   * rather than merged into the ends of the ramp.
   */
  underColor: [number, number, number] | null = null;
  overColor: [number, number, number] | null = null;

  /**
   * Warp knots of the grey ramp, sorted by x. `x` is the position along the
   * value axis inside the window, `y` the position along the grey axis, both
   * normalised. With none, the ramp is the straight line from (0,0) to (1,1).
   */
  warpKnots: { x: number; y: number }[] = [];

  /**
   * Within this angle of a grid axis the normal goes exactly onto it. Outside
   * the snap it stays continuous.
   */
  cartesianSnapDeg = 2.5;

  camera = { azimuth: -0.7, elevation: 0.62, zoom: 1.15 };

  /** Which preset the plane currently matches, or null once freely rotated. */
  preset: { space: PlaneSpace; axis: number } | null = null;

  private transition: Transition | null = null;

  setVolume(vol: Volume): void {
    this.vol = vol;
    this.windowWidth = Math.max(vol.hi - vol.lo, 1e-3);
    this.windowLevel = (vol.hi + vol.lo) / 2;
    this.slabMm = 0;
    this.resetCamera();
    this.volumeCentre(this.pivot);
    this.distance = 0;
    // The acquisition plane: the one the K index steps through.
    this.setCartesianPlane('grid', 2);
  }

  // ---- volume geometry -----------------------------------------------------

  volumeCentre(out: vec3 = vec3.create()): vec3 {
    const vol = this.vol;
    if (!vol) return vec3.set(out, 0, 0, 0);
    const c = vec3.fromValues((vol.dims[0] - 1) / 2, (vol.dims[1] - 1) / 2, (vol.dims[2] - 1) / 2);
    return vec3.transformMat4(out, c, vol.voxelToWorld);
  }

  /** The eight corners of the volume, in world mm. */
  corners(): vec3[] {
    const vol = this.vol;
    if (!vol) return [];
    const out: vec3[] = [];
    for (let k = 0; k < 2; k++) {
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const p = vec3.fromValues(
            i ? vol.dims[0] - 0.5 : -0.5,
            j ? vol.dims[1] - 0.5 : -0.5,
            k ? vol.dims[2] - 0.5 : -0.5,
          );
          out.push(vec3.transformMat4(p, p, vol.voxelToWorld));
        }
      }
    }
    return out;
  }

  /** Radius of the sphere enclosing the volume. */
  radius(): number {
    const c = this.volumeCentre();
    let r = 1;
    for (const p of this.corners()) r = Math.max(r, vec3.distance(p, c));
    return r;
  }

  /** Radius of the grab ring of the 3D manipulator. */
  widgetRadius(): number {
    return this.radius() * 0.85;
  }

  /** Directional colour of the plane, from the coordinates of its normal. */
  normalColor(): [number, number, number] {
    return directionColor(this.n);
  }

  // ---- the plane -----------------------------------------------------------

  planePoint(out: vec3 = vec3.create()): vec3 {
    return vec3.scaleAndAdd(out, this.pivot, this.n, this.distance);
  }

  /** The world directions of the voxel axes, orthonormalised and right-handed. */
  gridAxes(): vec3[] | null {
    const vol = this.vol;
    if (!vol) return null;
    const m = vol.voxelToWorld;
    const cols = [0, 1, 2].map((c) => vec3.fromValues(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]));
    // Gram-Schmidt: sform matrices may carry a small shear.
    const a0 = vec3.normalize(vec3.create(), cols[0]);
    const a1 = vec3.scaleAndAdd(vec3.create(), cols[1], a0, -vec3.dot(cols[1], a0));
    vec3.normalize(a1, a1);
    const a2 = vec3.cross(vec3.create(), a0, a1);
    // Keep a2 pointing the way the K index actually advances.
    if (vec3.dot(a2, cols[2]) < 0) {
      vec3.negate(a2, a2);
      vec3.negate(a1, a1); // stay right-handed
    }
    return [a0, a1, a2];
  }

  worldAxes(): vec3[] {
    return [vec3.clone(WORLD_R), vec3.clone(WORLD_A), vec3.clone(WORLD_S)];
  }

  /**
   * The frame of one of the three cartesian planes of a coordinate frame.
   * `axis` is the index of the axis that becomes the normal, so for the voxel
   * grid axis 2 is the acquisition plane: the one the K index steps through.
   */
  cartesianFrame(space: PlaneSpace, axis: number): Frame | null {
    const axes = space === 'grid' ? this.gridAxes() : this.worldAxes();
    if (!axes) return null;
    const n = vec3.clone(axes[axis]);
    // The other two axes, in the order that keeps n = u x v.
    const p = axes[(axis + 1) % 3];
    const q = axes[(axis + 2) % 3];

    // Screen up: whichever of the two points most nearly superior; for a plane
    // that is already near-axial, whichever points most nearly anterior.
    const score = (d: vec3) => Math.abs(vec3.dot(d, WORLD_S));
    let up = score(p) >= score(q) ? vec3.clone(p) : vec3.clone(q);
    let ref = WORLD_S;
    if (Math.max(score(p), score(q)) < 0.35) {
      ref = WORLD_A;
      const s2 = (d: vec3) => Math.abs(vec3.dot(d, WORLD_A));
      up = s2(p) >= s2(q) ? vec3.clone(p) : vec3.clone(q);
    }
    if (vec3.dot(up, ref) < 0) vec3.negate(up, up);

    const u = vec3.cross(vec3.create(), up, n);
    // For world planes the sign of the normal is free, so choose the one that
    // puts the patient's right on the right of the image.
    if (space === 'world' && vec3.dot(u, WORLD_R) < -0.2) {
      vec3.negate(n, n);
      vec3.negate(u, u);
    }
    return orthonormalised({ u, v: up, n });
  }

  /** Jump straight to a cartesian plane, with no animation. */
  setCartesianPlane(space: PlaneSpace, axis: number): void {
    const f = this.cartesianFrame(space, axis);
    if (!f) return;
    this.transition = null;
    this.setFrame(f);
    this.preset = { space, axis };
    this.distance = 0;
  }

  // ---- animated transitions ------------------------------------------------

  /**
   * Swing the plane across to a cartesian plane over `duration` ms.
   *
   * What is on screen is the slice, and the slice depends only on the plane,
   * not on which way its normal points nor on how the in-plane axes are turned
   * within it. So the destination is not one particular frame but a whole
   * family of equivalent ones, and the move aims for the nearest member: the
   * minimal rotation that lands the current normal on the target axis, taking
   * whichever of its two directions is closer. That turn is never more than 90
   * degrees, where slerping to a fixed frame could have gone the long way round
   * or added an in-plane spin that changes nothing.
   */
  animateToCartesian(space: PlaneSpace, axis: number, duration = TRANSITION_MS): void {
    const target = this.cartesianFrame(space, axis);
    if (!target) return;
    // Declaring the destination up front keeps the button highlight honest
    // about where the plane is heading.
    this.preset = { space, axis };

    const goal = vec3.clone(target.n);
    if (vec3.dot(this.n, goal) < 0) vec3.negate(goal, goal);
    const q0 = this.frameQuat();
    // gl-matrix multiplies as "b first, then a", so this applies the world turn
    // after the frame's own orientation.
    const q1 = quat.mul(quat.create(), quat.rotationTo(quat.create(), this.n, goal), q0);
    quat.normalize(q1, q1);

    if (duration <= 0) {
      this.transition = null;
      this.setFrameFromQuat(q1);
      this.distance = 0;
      return;
    }
    this.transition = { q0, q1, d0: this.distance, d1: 0, start: performance.now(), duration };
  }

  get animating(): boolean {
    return this.transition !== null;
  }

  /** Advance the animation to time `now`; true while it is still running. */
  tickTransition(now: number): boolean {
    const t = this.transition;
    if (!t) return false;
    const raw = t.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - t.start) / t.duration));
    // Ease in and out, so the plane starts and settles gently.
    const s = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    this.setFrameFromQuat(quat.slerp(quat.create(), t.q0, t.q1, s));
    this.distance = t.d0 + (t.d1 - t.d0) * s;
    if (raw >= 1) {
      this.transition = null;
      return false;
    }
    return true;
  }

  private setFrame(f: Frame): void {
    this.u = vec3.clone(f.u);
    this.v = vec3.clone(f.v);
    this.n = vec3.clone(f.n);
  }

  frameQuat(): quat {
    return frameToQuat({ u: this.u, v: this.v, n: this.n });
  }

  private setFrameFromQuat(q: quat): void {
    vec3.transformQuat(this.u, WORLD_R, q);
    vec3.transformQuat(this.v, WORLD_A, q);
    vec3.transformQuat(this.n, WORLD_S, q);
    this.orthonormalise();
  }

  /**
   * Pull the normal onto a grid axis when it is close enough, and rebuild the
   * in-plane axes around it. Called after every manual turn, never during an
   * animated transition: there the move should read as continuous and the
   * destination is exact anyway.
   */
  private snapFrame(): void {
    if (this.cartesianSnapDeg <= 0) return;
    const axes = this.gridAxes();
    if (!axes) return;
    const snapped = snapToAxes(this.n, axes, this.cartesianSnapDeg);
    if (!snapped || vec3.dot(snapped, this.n) > 1 - 1e-12) return;
    vec3.copy(this.n, snapped);
    // orthonormalise() rebuilds u and v around the new normal, keeping the
    // in-plane orientation as close to what it was as it can.
    this.orthonormalise();
  }

  /** Turn the frame by `angle` radians about a unit `axis` through the pivot. */
  rotate(axis: vec3, angle: number, from?: Frame): void {
    this.transition = null;
    const base = from ?? { u: this.u, v: this.v, n: this.n };
    const r = rotationAbout(axis, angle);
    this.u = vec3.transformMat4(vec3.create(), base.u, r);
    this.v = vec3.transformMat4(vec3.create(), base.v, r);
    this.n = vec3.transformMat4(vec3.create(), base.n, r);
    this.orthonormalise();
    this.snapFrame();
    this.preset = null;
  }

  /**
   * Trackball rotation driven from the 2D view: near the centre of the view it
   * tilts the plane, near the edges it spins it in place.
   */
  arcball(from: [number, number], to: [number, number]): void {
    const ball = (p: [number, number]): vec3 => {
      const d = p[0] * p[0] + p[1] * p[1];
      if (d <= 1) return vec3.fromValues(p[0], p[1], Math.sqrt(1 - d));
      const s = 1 / Math.sqrt(d);
      return vec3.fromValues(p[0] * s, p[1] * s, 0);
    };
    const a = ball(from);
    const b = ball(to);
    const local = vec3.cross(vec3.create(), a, b);
    const len = vec3.length(local);
    if (len < 1e-9) return;
    const angle = Math.atan2(len, vec3.dot(a, b));
    vec3.scale(local, local, 1 / len);
    // Local axes are (u, v, n); take the axis back to world coordinates.
    const axis = vec3.create();
    vec3.scaleAndAdd(axis, axis, this.u, local[0]);
    vec3.scaleAndAdd(axis, axis, this.v, local[1]);
    vec3.scaleAndAdd(axis, axis, this.n, local[2]);
    vec3.normalize(axis, axis);
    this.rotate(axis, angle);
  }

  frameSnapshot(): Frame {
    return { u: vec3.clone(this.u), v: vec3.clone(this.v), n: vec3.clone(this.n) };
  }

  /** Repeated rotations drift; re-orthonormalise to keep the frame square. */
  private orthonormalise(): void {
    vec3.normalize(this.n, this.n);
    vec3.scaleAndAdd(this.u, this.u, this.n, -vec3.dot(this.u, this.n));
    vec3.normalize(this.u, this.u);
    vec3.cross(this.v, this.n, this.u);
    vec3.normalize(this.v, this.v);
  }

  /**
   * How far to move, in mm, to advance one voxel along the normal. Derived
   * from the voxel grid, so it stays right for anisotropic and oblique data.
   */
  stepAlongNormal(): number {
    const vol = this.vol;
    if (!vol) return 1;
    const m = vol.worldToVoxel;
    let maxRate = 0;
    for (let r = 0; r < 3; r++) {
      const rate = Math.abs(m[r] * this.n[0] + m[4 + r] * this.n[1] + m[8 + r] * this.n[2]);
      if (rate > maxRate) maxRate = rate;
    }
    return maxRate > 1e-9 ? 1 / maxRate : 1;
  }

  /** The range of `distance` over which the plane still meets the volume. */
  distanceRange(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of this.corners()) {
      const d = vec3.dot(vec3.sub(vec3.create(), c, this.pivot), this.n);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return isFinite(lo) ? [lo, hi] : [-1, 1];
  }

  setDistance(d: number): void {
    this.transition = null;
    const [lo, hi] = this.distanceRange();
    this.distance = Math.min(Math.max(d, lo), hi);
  }

  scrollSlices(slices: number): void {
    this.setDistance(this.distance + this.stepAlongNormal() * slices);
  }

  // ---- sampling ------------------------------------------------------------

  voxelAt(world: vec3): vec3 {
    const vol = this.vol;
    if (!vol) return vec3.create();
    return vec3.transformMat4(vec3.create(), world, vol.worldToVoxel);
  }

  insideVolume(world: vec3): boolean {
    const vol = this.vol;
    if (!vol) return false;
    const p = this.voxelAt(world);
    for (let i = 0; i < 3; i++) if (p[i] < -0.5 || p[i] > vol.dims[i] - 0.5) return false;
    return true;
  }

  clampToVolume(world: vec3): vec3 {
    const vol = this.vol;
    if (!vol) return world;
    const p = this.voxelAt(world);
    for (let i = 0; i < 3; i++) p[i] = Math.min(Math.max(p[i], -0.5), vol.dims[i] - 0.5);
    return vec3.transformMat4(world, p, vol.voxelToWorld);
  }

  /** Trilinear sample at a world point; null when outside the volume. */
  sampleWorld(world: vec3): number | null {
    const vol = this.vol;
    if (!vol) return null;
    const p = this.voxelAt(world);
    const [nx, ny, nz] = vol.dims;
    if (p[0] < -0.5 || p[1] < -0.5 || p[2] < -0.5) return null;
    if (p[0] > nx - 0.5 || p[1] > ny - 0.5 || p[2] > nz - 0.5) return null;
    const cl = (x: number, hi: number) => Math.min(Math.max(x, 0), hi);
    const x = cl(p[0], nx - 1);
    const y = cl(p[1], ny - 1);
    const z = cl(p[2], nz - 1);
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const k0 = Math.floor(z);
    const i1 = Math.min(i0 + 1, nx - 1);
    const j1 = Math.min(j0 + 1, ny - 1);
    const k1 = Math.min(k0 + 1, nz - 1);
    const fx = x - i0;
    const fy = y - j0;
    const fz = z - k0;
    const d = vol.data;
    const at = (i: number, j: number, k: number) => d[i + nx * (j + ny * k)];
    const c00 = at(i0, j0, k0) * (1 - fx) + at(i1, j0, k0) * fx;
    const c10 = at(i0, j1, k0) * (1 - fx) + at(i1, j1, k0) * fx;
    const c01 = at(i0, j0, k1) * (1 - fx) + at(i1, j0, k1) * fx;
    const c11 = at(i0, j1, k1) * (1 - fx) + at(i1, j1, k1) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    return c0 * (1 - fz) + c1 * fz;
  }

  // ---- outlines and framing ------------------------------------------------

  /**
   * The polygon where the plane cuts the volume, in world mm. Clipping runs in
   * voxel space, where the volume is an axis-aligned box, so it is six
   * half-space clips of a quad. Empty when the plane misses the box.
   */
  planeOutline(): vec3[] {
    const vol = this.vol;
    if (!vol) return [];
    const centre = this.planePoint();
    const ext = this.radius() * 2;
    let poly = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([su, sv]) => {
      const p = vec3.scaleAndAdd(vec3.create(), centre, this.u, su * ext);
      vec3.scaleAndAdd(p, p, this.v, sv * ext);
      return vec3.transformMat4(p, p, vol.worldToVoxel);
    });

    for (let axis = 0; axis < 3 && poly.length > 0; axis++) {
      for (const keepGreater of [true, false]) {
        const limit = keepGreater ? -0.5 : vol.dims[axis] - 0.5;
        const inside = (p: vec3) => (keepGreater ? p[axis] >= limit : p[axis] <= limit);
        const next: vec3[] = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          const ia = inside(a);
          if (ia) next.push(a);
          if (ia !== inside(b)) {
            const denom = b[axis] - a[axis];
            if (Math.abs(denom) > 1e-12) {
              next.push(vec3.lerp(vec3.create(), a, b, (limit - a[axis]) / denom));
            }
          }
        }
        poly = next;
        if (poly.length === 0) break;
      }
    }
    return poly.map((p) => vec3.transformMat4(p, p, vol.voxelToWorld));
  }

  /** A human name for the current plane, with the obliquity called out. */
  planeName(): string {
    const axis = dominantAxis(this.n);
    const cos = Math.min(1, Math.abs(this.n[axis]));
    const deg = (Math.acos(cos) * 180) / Math.PI;
    const base = WORLD_PLANE_NAMES[axis];
    return deg < 1 ? base : `${base} ${deg.toFixed(0)}° obl.`;
  }

  /**
   * True when the plane lies on one of the voxel grid's cartesian planes, I-J,
   * J-K or I-K. Tested on the geometry rather than on the preset, so a free
   * rotation that happens to land on one counts too.
   */
  alignedToGrid(toleranceDeg = 1): boolean {
    const axes = this.gridAxes();
    if (!axes) return false;
    return axes.some((a) => {
      const c = Math.min(1, Math.abs(vec3.dot(this.n, a)));
      return (Math.acos(c) * 180) / Math.PI < toleranceDeg;
    });
  }

  /** Angle in degrees between the plane normal and a grid axis. */
  angleToGridAxis(axis: number): number | null {
    const axes = this.gridAxes();
    if (!axes) return null;
    const c = Math.min(1, Math.abs(vec3.dot(this.n, axes[axis])));
    return (Math.acos(c) * 180) / Math.PI;
  }

  // ---- 3D camera and picking ----------------------------------------------

  resetCamera(): void {
    this.camera = { azimuth: -0.7, elevation: 0.62, zoom: 1.15 };
  }

  /** Camera axes in world coordinates: screen right, screen up, and forward. */
  cameraBasis(): { right: vec3; up: vec3; forward: vec3 } {
    const { azimuth: az, elevation: el } = this.camera;
    const forward = vec3.fromValues(
      -Math.cos(el) * Math.sin(az),
      Math.cos(el) * Math.cos(az),
      -Math.sin(el),
    );
    vec3.normalize(forward, forward);
    const right = vec3.cross(vec3.create(), forward, WORLD_S);
    if (vec3.length(right) < 1e-6) vec3.set(right, 1, 0, 0);
    vec3.normalize(right, right);
    const up = vec3.cross(vec3.create(), right, forward);
    vec3.normalize(up, up);
    return { right, up, forward };
  }

  /**
   * The RAS axis marker for the corner of the 3D view, in normalised device
   * coordinates. It is what tells the viewer which way the patient is facing.
   */
  orientationTriad(aspect: number): { origin: [number, number]; axes: TriadAxis[] } {
    const a = Math.max(aspect, 1e-3);
    const rx = TRIAD_RADIUS / a;
    const ry = TRIAD_RADIUS;
    const origin: [number, number] = [-1 + rx + 0.05 / a, -1 + ry + 0.05];
    const { right, up, forward } = this.cameraBasis();
    const dirs: [string, vec3][] = [
      ['R', WORLD_R],
      ['A', WORLD_A],
      ['S', WORLD_S],
    ];
    return {
      origin,
      axes: dirs.map(([label, d]) => ({
        label,
        tip: [origin[0] + vec3.dot(d, right) * rx, origin[1] + vec3.dot(d, up) * ry] as [number, number],
        depth: vec3.dot(d, forward),
        color: directionColor(d),
      })),
    };
  }

  /**
   * The face of the volume box a ray enters through. Its normal is a voxel
   * axis, so clicking a face is a way of asking for that cartesian plane.
   */
  pickBoxFace(ray: Ray): BoxFace | null {
    const vol = this.vol;
    if (!vol) return null;
    // Work in voxel space, where the box is axis aligned.
    const o = vec3.transformMat4(vec3.create(), ray.origin, vol.worldToVoxel);
    const ahead = vec3.add(vec3.create(), ray.origin, ray.dir);
    const d = vec3.sub(
      vec3.create(),
      vec3.transformMat4(vec3.create(), ahead, vol.worldToVoxel),
      o,
    );
    const lo = [-0.5, -0.5, -0.5];
    const hi = [vol.dims[0] - 0.5, vol.dims[1] - 0.5, vol.dims[2] - 0.5];

    let tMin = -Infinity;
    let tMax = Infinity;
    let axis = -1;
    let sign = -1;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < lo[i] || o[i] > hi[i]) return null;
        continue;
      }
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      let s = -1;
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        s = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        axis = i;
        sign = s;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
    if (axis < 0 || tMin < 0) return null;

    const j = (axis + 1) % 3;
    const k = (axis + 2) % 3;
    const corner = (a: boolean, b: boolean): vec3 => {
      const p = vec3.create();
      p[axis] = sign > 0 ? hi[axis] : lo[axis];
      p[j] = a ? hi[j] : lo[j];
      p[k] = b ? hi[k] : lo[k];
      return vec3.transformMat4(p, p, vol.voxelToWorld);
    };
    const axes = this.gridAxes();
    return {
      axis,
      sign,
      corners: [corner(false, false), corner(true, false), corner(true, true), corner(false, true)],
      color: axes ? directionColor(axes[axis]) : [1, 1, 1],
    };
  }

  cameraMatrix(aspect: number): { mvp: mat4; eye: vec3 } {
    const target = this.volumeCentre();
    const radius = this.radius();
    const a = Math.max(aspect, 1e-3);
    // Orthographic: the half-height that just fits the bounding sphere in
    // whichever of the two directions is tighter, so a narrow pane still frames
    // the volume. Scale, not distance, is what the zoom changes.
    const halfH = Math.max(radius, radius / a) * this.camera.zoom;
    const dist = radius * 6;
    const { azimuth: az, elevation: el } = this.camera;
    const eye = vec3.fromValues(
      target[0] + dist * Math.cos(el) * Math.sin(az),
      target[1] - dist * Math.cos(el) * Math.cos(az),
      target[2] + dist * Math.sin(el),
    );
    const view = mat4.lookAt(mat4.create(), eye, target, [0, 0, 1]);
    const proj = mat4.ortho(
      mat4.create(),
      -halfH * a,
      halfH * a,
      -halfH,
      halfH,
      radius * 0.5,
      radius * 12,
    );
    return { mvp: mat4.mul(mat4.create(), proj, view), eye };
  }

  /** Ray through a point given in normalised device coordinates. */
  rayAt(mvp: mat4, ndcX: number, ndcY: number): Ray | null {
    const inv = mat4.invert(mat4.create(), mvp);
    if (!inv) return null;
    const near = vec3.transformMat4(vec3.create(), vec3.fromValues(ndcX, ndcY, -1), inv);
    const far = vec3.transformMat4(vec3.create(), vec3.fromValues(ndcX, ndcY, 1), inv);
    const dir = vec3.sub(vec3.create(), far, near);
    if (vec3.length(dir) < 1e-9) return null;
    vec3.normalize(dir, dir);
    return { origin: near, dir };
  }

  /** Where a ray meets the plane, or null when it runs parallel to it. */
  intersectPlane(ray: Ray): vec3 | null {
    const denom = vec3.dot(ray.dir, this.n);
    if (Math.abs(denom) < 1e-9) return null;
    const centre = this.planePoint();
    const t = vec3.dot(vec3.sub(vec3.create(), centre, ray.origin), this.n) / denom;
    if (t <= 0) return null;
    return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.dir, t);
  }

  get windowLo(): number {
    return this.windowLevel - this.windowWidth / 2;
  }

  get windowHi(): number {
    return this.windowLevel + this.windowWidth / 2;
  }
}

/** Gram-Schmidt a frame back to orthonormal and right-handed, in place. */
function orthonormalised(f: Frame): Frame {
  vec3.normalize(f.n, f.n);
  vec3.scaleAndAdd(f.u, f.u, f.n, -vec3.dot(f.u, f.n));
  vec3.normalize(f.u, f.u);
  vec3.cross(f.v, f.n, f.u);
  vec3.normalize(f.v, f.v);
  return f;
}

/** The rotation that takes the world axes onto a frame's (u, v, n). */
function frameToQuat(f: Frame): quat {
  const m = mat3.fromValues(f.u[0], f.u[1], f.u[2], f.v[0], f.v[1], f.v[2], f.n[0], f.n[1], f.n[2]);
  const q = quat.fromMat3(quat.create(), m);
  return quat.normalize(q, q);
}

/** The point on line A (through a0 along da) closest to line B. */
export function closestPointOnLine(a0: vec3, da: vec3, b0: vec3, db: vec3): vec3 {
  const w0 = vec3.sub(vec3.create(), a0, b0);
  const a = vec3.dot(da, da);
  const b = vec3.dot(da, db);
  const c = vec3.dot(db, db);
  const d = vec3.dot(da, w0);
  const e = vec3.dot(db, w0);
  const delta = a * c - b * b;
  if (Math.abs(delta) < 1e-10) return vec3.clone(a0);
  const t = (b * e - c * d) / delta;
  return vec3.scaleAndAdd(vec3.create(), a0, da, t);
}
