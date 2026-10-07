import { mat4, quat, vec3 } from 'gl-matrix';
import { Pedestal } from '../pedestal';
import type { Ray, Scene } from '../scene';
import type { PlaneWidget } from '../widget';
import { Arrows } from './arrows';
import { fadeBatches, toBody, type Context, type Geometry, type ManipId, type Manipulator } from './common';
import { OrientationCube } from './cube';
import { Landmarks } from './landmarks';
import { PlaneGizmo } from './plane-gizmo';
import { Shadows } from './shadows';
import { SliceDrag } from './slice-drag';
import { Trackball } from './trackball';

/** The ways of placing the body, in the order the panel offers them. */
export const MANIPULATORS: { id: ManipId; label: string; help: string }[] = [
  {
    id: 'pedestal',
    label: 'Pedestal',
    help:
      'Tapa del pedestal: el centro lo desplaza por su eje y el borde lo inclina. ' +
      'Lateral: izquierdo gira, central mueve libre, derecho mueve en su plano.',
  },
  {
    id: 'orbit',
    label: 'Gizmo de orbita',
    help:
      'En el centro del cuerpo: los anillos R, A y S lo giran sobre sus ejes, el circulo blanco ' +
      'alrededor de la linea de vision, y el centro lo mueve en el plano de la pantalla.',
  },
  {
    id: 'plane',
    label: 'Gizmo anclado al plano de corte',
    help:
      'Sobre el corte, a la altura del cuerpo: la flecha de la normal mueve el cuerpo a traves ' +
      'del corte, las flechas blancas lo deslizan por el plano, el cuadrado lo mueve en el plano ' +
      'y el anillo lo gira dentro de la imagen.',
  },
  {
    id: 'slice',
    label: 'Arrastre sobre el corte',
    help:
      'Con el izquierdo sobre la imagen: dentro del contorno rojo traslada el cuerpo por el plano; ' +
      'fuera, lo gira alrededor de la normal. Alt + rueda lo mueve a traves del corte. ' +
      'Central y derecho siguen deslizando el plano.',
  },
  {
    id: 'landmarks',
    label: 'Alineacion por puntos',
    help:
      'Clic en el cuerpo para poner un punto y luego clic en la imagen del corte para su pareja. ' +
      'Con cada pareja el cuerpo se ajusta a todas a la vez. Los puntos se pueden arrastrar.',
  },
  {
    id: 'arrows',
    label: 'Flechas de traslacion',
    help:
      'Flechas R, A y S del espacio del volumen: mueven el cuerpo por ese eje. Los cuadrados ' +
      'lo mueven en el plano de dos ejes; el centro, en el plano de la pantalla.',
  },
  {
    id: 'trackball',
    label: 'Trackball',
    help:
      'Arrastrar dentro de la esfera la hace rodar y gira el cuerpo libremente; ' +
      'el borde lo gira alrededor de la linea de vision.',
  },
  {
    id: 'cube',
    label: 'Cubo de orientacion',
    help:
      'Clic en una cara: la pone de frente a la camara. Clic derecho: de frente al plano de corte. ' +
      'Arrastrar el cubo gira el cuerpo.',
  },
  {
    id: 'shadows',
    label: 'Sombras en las paredes',
    help:
      'La silueta del cuerpo en las tres paredes del fondo de la caja del volumen. ' +
      'Arrastrar una sombra mueve el cuerpo en el plano de esa pared.',
  },
];

/**
 * The manipulators shown on the body fade when they are not in use. They come
 * up fast once the pointer is on the body or one of them, stay for a while
 * after it leaves, and then sink away. In seconds.
 */
const FADE_IN_S = 0.25;
const HOLD_S = 5;
const FADE_OUT_S = 1.5;
/** How long the body takes to ease to a placement it is sent to. */
const ANIMATE_MS = 450;

interface Animation {
  from: mat4;
  to: mat4;
  start: number;
}

/**
 * The controls of the body: the manipulator chosen in the panel, and what
 * they all share, which is the fade, the snapping, the easing of the body to
 * a placement and the test of a ray against the body surface.
 */
export class BodyControls {
  private scene: Scene;
  private modes: Map<ManipId, Manipulator>;
  current: Manipulator;
  /** Snapping, from the panel; Shift during a drag turns it the other way. */
  snap = false;
  /** Told when something changes outside a drag, for the panel. */
  onChange: () => void = () => {};
  private overBodySurface = false;
  private presence = 1;
  private lastUse = performance.now();
  private lastTick = 0;
  private anim: Animation | null = null;
  private viewport = { w: 1, h: 1 };

  constructor(scene: Scene, widget: PlaneWidget) {
    this.scene = scene;
    const ctx: Context = {
      scene,
      widget,
      bodyHit: (ray) => this.bodyHit(ray),
      animateTo: (m) => this.animateTo(m),
      pixel: () => scene.pixelSize(this.viewport.w, this.viewport.h),
      changed: () => this.onChange(),
    };
    const list: Manipulator[] = [
      new Pedestal(scene),
      new Pedestal(scene, 'orbit'),
      new PlaneGizmo(ctx),
      new SliceDrag(ctx),
      new Landmarks(ctx),
      new Arrows(ctx),
      new Trackball(ctx),
      new OrientationCube(ctx),
      new Shadows(ctx),
    ];
    this.modes = new Map(list.map((m) => [m.id, m]));
    this.current = list[0];
  }

  /** The landmarks, for the panel's buttons. */
  get landmarks(): Landmarks {
    return this.modes.get('landmarks') as Landmarks;
  }

  setMode(id: ManipId): void {
    const next = this.modes.get(id);
    if (!next || next === this.current) return;
    this.current.cancel();
    this.current.clearHover();
    this.current = next;
    this.reveal();
  }

  /** The size of the view in CSS pixels, for handles sized on screen. */
  setViewport(w: number, h: number): void {
    this.viewport = { w: Math.max(1, w), h: Math.max(1, h) };
  }

  get active(): boolean {
    return this.current.active;
  }

  overHandle(ray: Ray | null): boolean {
    return this.scene.body !== null && this.current.overHandle(ray);
  }

  /** Note what is under the pointer; true if the drawing changes. */
  setHover(ray: Ray | null): boolean {
    if (!this.scene.body) return false;
    return this.current.setHover(ray);
  }

  /** Note whether the pointer is on the body surface; true if that changed. */
  setBodyHover(ray: Ray | null): boolean {
    const on = ray !== null && this.bodyHit(ray) !== null;
    const changed = on !== this.overBodySurface;
    this.overBodySurface = on;
    return changed;
  }

  clearHover(): void {
    this.overBodySurface = false;
    this.current.clearHover();
  }

  begin(ray: Ray, button: number): boolean {
    if (!this.scene.body) return false;
    this.anim = null;
    return this.current.begin(ray, button);
  }

  move(ray: Ray, shift: boolean): void {
    this.current.move(ray, this.snap !== shift);
  }

  end(): void {
    this.current.end();
  }

  cancel(): void {
    this.current.cancel();
  }

  wheel(ray: Ray, dir: number, shift: boolean): boolean {
    if (!this.scene.body || !this.current.wheel) return false;
    this.anim = null;
    return this.current.wheel(ray, dir, this.snap !== shift);
  }

  hint(): string {
    return this.current.hint();
  }

  cursor(): string | null {
    return this.current.cursor();
  }

  /** Put the body back where it stood at the start. */
  resetBody(): void {
    const from = mat4.clone(this.scene.bodyModel);
    this.scene.placeBody();
    const to = mat4.clone(this.scene.bodyModel);
    mat4.copy(this.scene.bodyModel, from);
    this.animateTo(to);
  }

  // ---- fade and easing ---------------------------------------------------------

  private get inUse(): boolean {
    return this.current.active || this.current.hovering || this.overBodySurface || this.anim !== null;
  }

  /** Whether the manipulators fade when unused; from the panel. */
  fadeEnabled = true;

  /** How shown the manipulator is, 0 to 1, eased. */
  get shown(): number {
    if (!this.current.fades || !this.fadeEnabled) return 1;
    const p = this.presence;
    return p * p * (3 - 2 * p);
  }

  /** Show it now, to hold and fade from there: on a new body or volume. */
  reveal(): void {
    this.presence = 1;
    this.lastUse = performance.now();
    this.lastTick = 0;
  }

  /**
   * Advance the fade and the easing to time `now`, in ms; true while either is
   * moving. While the manipulator is being held up after use, nothing moves:
   * see untilFade().
   */
  tick(now: number): boolean {
    const easing = this.tickAnimation(now);
    if (this.inUse) this.lastUse = now;
    const target = this.inUse || now - this.lastUse < HOLD_S * 1000 ? 1 : 0;
    // Capped, so a frame after a long pause does not jump the whole fade.
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (this.presence < target) this.presence = Math.min(target, this.presence + dt / FADE_IN_S);
    else if (this.presence > target) this.presence = Math.max(target, this.presence - dt / FADE_OUT_S);
    if (this.presence === target) {
      this.lastTick = 0;
      return easing;
    }
    return true;
  }

  /** Milliseconds until the fade out is due, while the manipulator is held up
   *  after use; null when no fade is pending. */
  untilFade(now: number): number | null {
    if (!this.current.fades || !this.fadeEnabled || this.inUse || this.presence === 0) return null;
    const left = this.lastUse + HOLD_S * 1000 - now;
    return left > 0 ? left : null;
  }

  /** Ease the body from where it is to a placement. */
  animateTo(target: mat4): void {
    this.anim = { from: mat4.clone(this.scene.bodyModel), to: mat4.clone(target), start: performance.now() };
    this.onChange();
  }

  private tickAnimation(now: number): boolean {
    const a = this.anim;
    if (!a) return false;
    const t = Math.min(1, Math.max(0, (now - a.start) / ANIMATE_MS));
    const e = t * t * (3 - 2 * t);
    const q0 = mat4.getRotation(quat.create(), a.from);
    const q1 = mat4.getRotation(quat.create(), a.to);
    // About the body's middle, so it turns in place rather than swinging round
    // the body's origin, down at the cut.
    const c = this.scene.body ? vec3.lerp(vec3.create(), this.scene.body.min, this.scene.body.max, 0.5) : vec3.create();
    const c0 = vec3.transformMat4(vec3.create(), c, a.from);
    const c1 = vec3.transformMat4(vec3.create(), c, a.to);
    const q = quat.slerp(quat.create(), q0, q1, e);
    const ct = vec3.lerp(vec3.create(), c0, c1, e);
    // The translation that puts the body's middle at ct under the turn q.
    const rc = vec3.transformQuat(vec3.create(), c, q);
    const tr = vec3.sub(vec3.create(), ct, rc);
    if (t >= 1) {
      mat4.copy(this.scene.bodyModel, a.to);
      this.anim = null;
      this.onChange();
      return false;
    }
    mat4.fromRotationTranslation(this.scene.bodyModel, q, tr);
    return true;
  }

  // ---- drawing -----------------------------------------------------------------

  geometry(): Geometry {
    if (!this.scene.body) return { body: [], scene: [] };
    const g = this.current.geometry();
    const shown = this.shown;
    return { body: fadeBatches(g.body, shown), scene: fadeBatches(g.scene, shown) };
  }

  // ---- the body surface ----------------------------------------------------------

  /**
   * Where a scene ray first meets the body surface, where the body is now: in
   * the body's space and the scene's, and how far along the ray. Every
   * triangle is tried in turn (Moller-Trumbore); a few thousand of them, cheap
   * enough on each pointer move.
   */
  bodyHit(ray: Ray): { body: vec3; scene: vec3; t: number } | null {
    const body = this.scene.body;
    if (!body) return null;
    const r = toBody(ray, this.scene.bodyModel);
    const P = body.positions;
    const I = body.indices;
    const o = r.origin;
    const d = r.dir;
    let best = Infinity;
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
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 0 && t < best) best = t;
    }
    if (!isFinite(best)) return null;
    const bp = vec3.scaleAndAdd(vec3.create(), o, d, best);
    const sp = vec3.transformMat4(vec3.create(), bp, this.scene.bodyModel);
    return { body: bp, scene: sp, t: vec3.distance(sp, ray.origin) };
  }
}
