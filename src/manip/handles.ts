import { mat4, vec3 } from 'gl-matrix';
import { closestPointOnLine, type Ray } from '../scene';
import type { LineBatch } from '../widget';
import {
  across,
  arrowHead,
  circleSegs,
  dashedLine,
  discBatch,
  inScene,
  lighter,
  onPlane,
  pointDistance,
  quadBatch,
  ringDistance,
  segmentDistance,
  snapAngle,
  snapLength,
  snapMove,
  tangentTurn,
  tube,
  turnAbout,
  type Context,
  type Geometry,
  type ManipId,
  type Manipulator,
  type RGB,
} from './common';

/**
 * One handle of a gizmo built of arrows, squares, rings and a centre, the
 * pieces of the classic editor gizmos. All in the scene.
 *
 *  - an **arrow** moves the body along its axis;
 *  - a **square** moves it across the plane of its two axes;
 *  - a **ring** turns it about its axis, through the gizmo's centre;
 *  - the **centre** moves it across the screen.
 */
export type Handle =
  | { kind: 'arrow'; axis: vec3; length: number; color: RGB; hint: string; doing: string }
  | { kind: 'square'; axes: [vec3, vec3]; from: number; to: number; color: RGB; hint: string; doing: string }
  | { kind: 'ring'; axis: vec3; radius: number; color: RGB; hint: string; doing: string }
  | { kind: 'centre'; radius: number; hint: string; doing: string };

export interface Frame {
  centre: vec3;
  handles: Handle[];
}

/** How close the pointer has to come to a handle to take it, in pixels. */
const HIT_PX = 8;
/** An arrow's shaft starts this far out, as a fraction of its length, to
 *  leave the centre to the centre handle. */
const SHAFT_START = 0.16;
const HEAD_LENGTH = 0.2;
const SQUARE_ALPHA = 0.28;

interface Drag {
  index: number;
  handle: Handle;
  centre: vec3;
  model0: mat4;
  grab: vec3;
  ray0: Ray;
  /** The centre handle: the screen's axes at the press. */
  right?: vec3;
  up?: vec3;
  forward?: vec3;
}

export abstract class HandleGizmo implements Manipulator {
  abstract readonly id: ManipId;
  readonly fades: boolean = true;
  protected ctx: Context;
  private hover: number | null = null;
  private drag: Drag | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** The gizmo as it stands now, or null when there is nothing to place. */
  protected abstract frame(): Frame | null;

  get active(): boolean {
    return this.drag !== null;
  }

  get hovering(): boolean {
    return this.hover !== null;
  }

  /** The handle a ray takes, by index, and where. */
  private hit(ray: Ray, f: Frame): { index: number; point: vec3 } | null {
    const tol = HIT_PX * this.ctx.pixel();
    let best: { index: number; point: vec3; dist: number } | null = null;
    const offer = (index: number, point: vec3, dist: number) => {
      if (dist <= tol && (!best || dist < best.dist)) best = { index, point, dist };
    };
    f.handles.forEach((h, index) => {
      if (h.kind === 'arrow') {
        const a = vec3.scaleAndAdd(vec3.create(), f.centre, h.axis, h.length * SHAFT_START);
        const b = vec3.scaleAndAdd(vec3.create(), f.centre, h.axis, h.length);
        const { dist, s } = segmentDistance(ray, a, b);
        offer(index, vec3.lerp(vec3.create(), a, b, s), dist);
      } else if (h.kind === 'square') {
        const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), h.axes[0], h.axes[1]));
        const p = onPlane(ray, f.centre, n);
        if (!p) return;
        const rel = vec3.sub(vec3.create(), p, f.centre);
        const x = vec3.dot(rel, h.axes[0]);
        const y = vec3.dot(rel, h.axes[1]);
        if (x >= h.from && x <= h.to && y >= h.from && y <= h.to) offer(index, p, tol * 0.5);
      } else if (h.kind === 'ring') {
        const [e1, e2] = across(h.axis);
        const { dist, point } = ringDistance(ray, f.centre, e1, e2, h.radius);
        offer(index, point, dist);
      } else {
        const { dist } = pointDistance(ray, f.centre);
        if (dist <= h.radius + tol * 0.5) offer(index, vec3.clone(f.centre), Math.max(0, dist - h.radius));
      }
    });
    return best;
  }

  overHandle(ray: Ray | null): boolean {
    const f = this.frame();
    return f !== null && ray !== null && this.hit(ray, f) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const f = this.frame();
    const next = f && ray ? (this.hit(ray, f)?.index ?? null) : null;
    const changed = next !== this.hover;
    this.hover = next;
    return changed;
  }

  clearHover(): void {
    this.hover = null;
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0) return false;
    const f = this.frame();
    if (!f) return false;
    const h = this.hit(ray, f);
    if (!h) return false;
    const handle = f.handles[h.index];
    const d: Drag = {
      index: h.index,
      handle,
      centre: vec3.clone(f.centre),
      model0: mat4.clone(this.ctx.scene.bodyModel),
      grab: h.point,
      ray0: { origin: vec3.clone(ray.origin), dir: vec3.clone(ray.dir) },
    };
    if (handle.kind === 'centre') {
      const cam = this.ctx.scene.cameraBasis();
      d.right = cam.right;
      d.up = cam.up;
      d.forward = cam.forward;
    }
    this.drag = d;
    this.hover = h.index;
    return true;
  }

  move(ray: Ray, snap: boolean): void {
    const d = this.drag;
    if (!d) return;
    const h = d.handle;
    let local: mat4 | null = null;
    if (h.kind === 'arrow') {
      // Seen end on, an arrow gives no reading: hold still rather than leap.
      if (Math.abs(vec3.dot(ray.dir, h.axis)) > 0.985) return;
      const p = closestPointOnLine(d.grab, h.axis, ray.origin, ray.dir);
      const along = snapLength(vec3.dot(vec3.sub(vec3.create(), p, d.grab), h.axis), snap);
      local = mat4.fromTranslation(mat4.create(), vec3.scale(vec3.create(), h.axis, along));
    } else if (h.kind === 'square') {
      const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), h.axes[0], h.axes[1]));
      if (Math.abs(vec3.dot(ray.dir, n)) < 0.05) return;
      const p = onPlane(ray, d.grab, n);
      if (!p) return;
      const moved = snapMove(vec3.sub(vec3.create(), p, d.grab), h.axes, snap);
      local = mat4.fromTranslation(mat4.create(), moved);
    } else if (h.kind === 'ring') {
      const angle = snapAngle(tangentTurn(h.axis, d.centre, d.grab, d.ray0, ray), snap);
      local = turnAbout(d.centre, h.axis, angle);
    } else if (d.forward && d.right && d.up) {
      const p = onPlane(ray, d.grab, d.forward);
      if (!p) return;
      const moved = snapMove(vec3.sub(vec3.create(), p, d.grab), [d.right, d.up], snap);
      local = mat4.fromTranslation(mat4.create(), moved);
    }
    if (local) mat4.copy(this.ctx.scene.bodyModel, inScene(d.model0, local));
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
    if (this.drag) return this.drag.handle.doing;
    if (this.hover === null) return '';
    return this.frame()?.handles[this.hover]?.hint ?? '';
  }

  cursor(): string | null {
    const index = this.drag?.index ?? this.hover;
    if (index === null) return null;
    const h = this.drag?.handle ?? this.frame()?.handles[index];
    if (!h) return null;
    if (h.kind === 'ring') return this.drag ? 'grabbing' : 'pointer';
    return 'move';
  }

  geometry(): Geometry {
    const f = this.frame();
    if (!f) return { body: [], scene: [] };
    const scene = this.ctx.scene;
    const { forward, right, up } = scene.cameraBasis();
    const hot = this.drag?.index ?? this.hover;
    const out: LineBatch[] = [];
    // The rail of the arrow held, through where it was taken.
    if (this.drag && this.drag.handle.kind === 'arrow') {
      const h = this.drag.handle;
      const reach = h.length * 2;
      const a = vec3.scaleAndAdd(vec3.create(), this.drag.grab, h.axis, -reach);
      const b = vec3.scaleAndAdd(vec3.create(), this.drag.grab, h.axis, reach);
      out.push(...tube(dashedLine(a, b, 16), forward, h.color, false, 0.45));
    }
    f.handles.forEach((h, i) => {
      const isHot = hot === i;
      if (h.kind === 'arrow') {
        const color = isHot ? lighter(h.color) : h.color;
        const a = vec3.scaleAndAdd(vec3.create(), f.centre, h.axis, h.length * SHAFT_START);
        const base = vec3.scaleAndAdd(vec3.create(), f.centre, h.axis, h.length * (1 - HEAD_LENGTH));
        const tip = vec3.scaleAndAdd(vec3.create(), f.centre, h.axis, h.length);
        out.push(...tube([[a, base]], forward, color, isHot, 0.9));
        out.push(arrowHead(base, tip, forward, h.length * HEAD_LENGTH * (isHot ? 0.5 : 0.4), color, isHot ? 1 : 0.9));
      } else if (h.kind === 'square') {
        const [x, y] = h.axes;
        const at = (s: number, t: number) => {
          const p = vec3.scaleAndAdd(vec3.create(), f.centre, x, s);
          return vec3.scaleAndAdd(p, p, y, t);
        };
        out.push(
          quadBatch([at(h.from, h.from), at(h.to, h.from), at(h.to, h.to), at(h.from, h.to)], h.color, isHot ? 0.7 : SQUARE_ALPHA),
        );
      } else if (h.kind === 'ring') {
        const [e1, e2] = across(h.axis);
        out.push(...tube(circleSegs(f.centre, e1, e2, h.radius), forward, isHot ? lighter(h.color) : h.color, isHot));
      } else {
        out.push(discBatch(f.centre, right, up, h.radius * (isHot ? 1.25 : 1), [0.95, 0.96, 0.98], isHot ? 1 : 0.85));
      }
    });
    return { body: [], scene: out };
  }
}
