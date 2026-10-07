import { mat4, quat, vec3 } from 'gl-matrix';
import type { Ray } from '../scene';
import { depthRibbon, type LineBatch } from '../widget';
import {
  bodyAxes,
  bodyCentreInScene,
  across,
  circleSegs,
  discBatch,
  inScene,
  pointDistance,
  quatAbout,
  snapAngle,
  snapQuat,
  tube,
  turnAbout,
  WHITE,
  type Context,
  type Geometry,
  type Manipulator,
} from './common';

/** The ball's radius, as a fraction of the body's height: round the chest. */
const RADIUS = 0.4;
/** How near the rim, in pixels, the pointer takes the rim instead of the ball. */
const RIM_PX = 9;
const MERIDIAN: [number, number, number] = [0.62, 0.68, 0.8];

type Part = 'ball' | 'rim';

interface Drag {
  part: Part;
  model0: mat4;
  centre: vec3;
  right: vec3;
  up: vec3;
  /** Towards the viewer. */
  back: vec3;
  /** Where the pointer was on the ball, or its angle round the rim. */
  from: vec3;
  angle0: number;
}

/**
 * A trackball round the body: a sphere about its middle that the pointer
 * rolls. Dragging inside it turns the body as if rolling the ball under the
 * hand, about the axis square to the pointer's travel; the rim turns it about
 * the line of sight. Three great circles on the body's own axes turn with it,
 * so the roll can be seen.
 *
 * The pointer is put on the ball as in Bell's trackball: on the sphere near
 * the middle and on a hyperbolic sheet further out, so the turn keeps going
 * smoothly as the pointer crosses the edge.
 */
export class Trackball implements Manipulator {
  readonly id = 'trackball';
  readonly fades = true;
  private ctx: Context;
  private hover: Part | null = null;
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

  private radius(): number {
    const body = this.ctx.scene.body;
    return body ? (body.max[2] - body.min[2]) * RADIUS : 100;
  }

  private part(ray: Ray): Part | null {
    if (!this.ctx.scene.body) return null;
    const { dist } = pointDistance(ray, bodyCentreInScene(this.ctx.scene));
    const R = this.radius();
    const tol = RIM_PX * this.ctx.pixel();
    if (Math.abs(dist - R) <= tol) return 'rim';
    // Inside, it yields to the plane's ring, which is a handle of its own.
    if (dist < R && this.ctx.widget.pick(ray) === null) return 'ball';
    return null;
  }

  overHandle(ray: Ray | null): boolean {
    return ray !== null && this.part(ray) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const next = ray ? this.part(ray) : null;
    const changed = next !== this.hover;
    this.hover = next;
    return changed;
  }

  clearHover(): void {
    this.hover = null;
  }

  /** The pointer's place on the screen, about the centre, in its axes. */
  private screen(d: { centre: vec3; right: vec3; up: vec3 }, ray: Ray): [number, number] {
    const rel = vec3.sub(vec3.create(), ray.origin, d.centre);
    return [vec3.dot(rel, d.right), vec3.dot(rel, d.up)];
  }

  /** The pointer put on the ball, in the scene, as a unit direction. */
  private onBall(d: Drag, ray: Ray): vec3 {
    const R = this.radius();
    const [x, y] = this.screen(d, ray);
    const r2 = x * x + y * y;
    const z = r2 <= (R * R) / 2 ? Math.sqrt(R * R - r2) : (R * R) / 2 / Math.sqrt(r2);
    const p = vec3.scale(vec3.create(), d.right, x);
    vec3.scaleAndAdd(p, p, d.up, y);
    vec3.scaleAndAdd(p, p, d.back, z);
    return vec3.normalize(p, p);
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0) return false;
    const part = this.part(ray);
    if (!part) return false;
    const cam = this.ctx.scene.cameraBasis();
    const d: Drag = {
      part,
      model0: mat4.clone(this.ctx.scene.bodyModel),
      centre: bodyCentreInScene(this.ctx.scene),
      right: cam.right,
      up: cam.up,
      back: vec3.negate(vec3.create(), cam.forward),
      from: vec3.create(),
      angle0: 0,
    };
    if (part === 'ball') d.from = this.onBall(d, ray);
    else {
      const [x, y] = this.screen(d, ray);
      d.angle0 = Math.atan2(y, x);
    }
    this.drag = d;
    this.hover = part;
    return true;
  }

  move(ray: Ray, snap: boolean): void {
    const d = this.drag;
    if (!d) return;
    let local: mat4;
    if (d.part === 'ball') {
      const q = quat.rotationTo(quat.create(), d.from, this.onBall(d, ray));
      local = quatAbout(d.centre, snapQuat(q, snap));
    } else {
      // Counterclockwise on the screen is a turn about the line towards the viewer.
      const [x, y] = this.screen(d, ray);
      local = turnAbout(d.centre, d.back, snapAngle(Math.atan2(y, x) - d.angle0, snap));
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

  hint(): string {
    const p = this.drag?.part ?? this.hover;
    if (this.drag) return p === 'rim' ? 'girando el cuerpo alrededor de la linea de vision' : 'girando el cuerpo';
    if (p === 'rim') return 'arrastrar gira el cuerpo alrededor de la linea de vision';
    if (p === 'ball') return 'arrastrar hace rodar la esfera y gira el cuerpo';
    return '';
  }

  cursor(): string | null {
    if (this.drag) return 'grabbing';
    if (this.hover === 'rim') return 'pointer';
    if (this.hover === 'ball') return 'grab';
    return null;
  }

  geometry(): Geometry {
    const scene = this.ctx.scene;
    if (!scene.body) return { body: [], scene: [] };
    const { right, up, forward } = scene.cameraBasis();
    const c = bodyCentreInScene(scene);
    const R = this.radius();
    const part = this.drag?.part ?? this.hover;
    const out: LineBatch[] = [];
    out.push(discBatch(c, right, up, R, [0.55, 0.62, 0.78], part === 'ball' ? 0.1 : 0.05));
    // The great circles on the body's own axes: they turn with it.
    for (const axis of bodyAxes(scene)) {
      const [e1, e2] = across(axis);
      out.push(
        ...depthRibbon(circleSegs(c, e1, e2, R), forward, MERIDIAN, {
          constantWidth: part === 'ball' ? 2 : 1.4,
          alphaScale: part === 'ball' ? 0.75 : 0.5,
          fog: false,
        }).map((b): LineBatch => ({ ...b, depth: 'off' })),
      );
    }
    out.push(...tube(circleSegs(c, right, up, R), forward, WHITE, part === 'rim', 0.8));
    return { body: [], scene: out };
  }
}
