import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import type { Ray } from '../scene';
import type { LineBatch } from '../widget';
import {
  circleSegs,
  dashedLine,
  discBatch,
  inScene,
  pointDistance,
  toBodyDirection,
  tube,
  type Context,
  type Geometry,
  type Manipulator,
  type RGB,
} from './common';

/** One colour per pair, so the two points of a pair read as one. */
const PALETTE: RGB[] = [
  [0.96, 0.96, 0.96],
  [0.3, 0.9, 0.95],
  [0.95, 0.4, 0.9],
  [0.95, 0.92, 0.3],
  [0.55, 0.95, 0.45],
  [0.65, 0.6, 1.0],
];
/** A marker's radius, and how near the pointer takes it, in pixels. */
const MARK_PX = 6;
const HIT_PX = 9;

interface Pair {
  /** On the body, in its own space: it goes where the body goes. */
  body: vec3;
  /** In the volume, in the scene: it stays where the volume is. */
  vol: vec3 | null;
}

type Target = { kind: 'body' | 'vol'; index: number };

interface Drag {
  target: Target | null;
  /** Where the point held was at the press, to put it back. */
  from: vec3 | null;
}

export const landmarkColor = (i: number): RGB => PALETTE[i % PALETTE.length];

/**
 * Placing the body by matching points: a point on the body, then the point of
 * the image where it belongs. With every pair made, the body is eased to the
 * rigid placement that brings its points onto theirs as closely as they all
 * allow: one pair moves it, two also turn it to line them up, and three or
 * more fix it wholly, by least squares (Horn's closed form with quaternions).
 *
 * The points of the body are drawn as filled discs, those of the image as
 * rings of the same colour, and a dashed line joins each pair while they are
 * apart. Either can be dragged to adjust it: the body's along its surface,
 * the image's along the slice.
 */
export class Landmarks implements Manipulator {
  readonly id = 'landmarks';
  /** The points stay on show: they are the work in hand. */
  readonly fades = false;
  private ctx: Context;
  pairs: Pair[] = [];
  /** The mean distance left between the pairs after the last fit, in mm. */
  error: number | null = null;
  private hover: Target | 'next' | null = null;
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

  /** What the next click places: a point on the body, or its pair in the image. */
  private get expecting(): 'body' | 'vol' {
    const last = this.pairs[this.pairs.length - 1];
    return last && !last.vol ? 'vol' : 'body';
  }

  private bodyPoint(p: Pair): vec3 {
    return vec3.transformMat4(vec3.create(), p.body, this.ctx.scene.bodyModel);
  }

  /** The marker a ray takes, if any. */
  private markerAt(ray: Ray): Target | null {
    const tol = HIT_PX * this.ctx.pixel();
    let best: { target: Target; dist: number } | null = null;
    this.pairs.forEach((p, index) => {
      for (const kind of ['body', 'vol'] as const) {
        const at = kind === 'body' ? this.bodyPoint(p) : p.vol;
        if (!at) continue;
        const { dist } = pointDistance(ray, at);
        if (dist <= tol && (!best || dist < best.dist)) best = { target: { kind, index }, dist };
      }
    });
    return best ? (best as { target: Target }).target : null;
  }

  /** Where the next point would go under a ray, if it is on its target. */
  private nextAt(ray: Ray): vec3 | null {
    const scene = this.ctx.scene;
    if (this.expecting === 'body') return this.ctx.bodyHit(ray)?.body ?? null;
    if (this.ctx.widget.pick(ray) !== null) return null;
    const p = scene.intersectPlane(ray);
    return p && scene.insideVolume(p) ? p : null;
  }

  overHandle(ray: Ray | null): boolean {
    if (!ray || !this.ctx.scene.body) return false;
    return this.markerAt(ray) !== null || this.nextAt(ray) !== null;
  }

  setHover(ray: Ray | null): boolean {
    if (this.drag) return false;
    const next = ray ? (this.markerAt(ray) ?? (this.nextAt(ray) ? 'next' : null)) : null;
    const same =
      next === this.hover ||
      (typeof next === 'object' && next && typeof this.hover === 'object' && this.hover &&
        next.kind === this.hover.kind && next.index === this.hover.index);
    this.hover = next;
    return !same;
  }

  clearHover(): void {
    this.hover = null;
  }

  begin(ray: Ray, button: number): boolean {
    if (button !== 0 || !this.ctx.scene.body) return false;
    const marker = this.markerAt(ray);
    if (marker) {
      const p = this.pairs[marker.index];
      const at = marker.kind === 'body' ? p.body : p.vol;
      this.drag = { target: marker, from: at ? vec3.clone(at) : null };
      return true;
    }
    const at = this.nextAt(ray);
    if (!at) return false;
    if (this.expecting === 'body') this.pairs.push({ body: at, vol: null });
    else {
      this.pairs[this.pairs.length - 1].vol = at;
      this.fit();
    }
    this.drag = { target: null, from: null };
    this.ctx.changed();
    return true;
  }

  move(ray: Ray): void {
    const t = this.drag?.target;
    if (!t) return;
    const p = this.pairs[t.index];
    if (t.kind === 'body') {
      const hit = this.ctx.bodyHit(ray);
      if (hit) p.body = hit.body;
    } else {
      const scene = this.ctx.scene;
      const q = scene.intersectPlane(ray);
      if (q && scene.insideVolume(q)) p.vol = q;
    }
  }

  end(): void {
    const d = this.drag;
    this.drag = null;
    if (d?.target) {
      this.fit();
      this.ctx.changed();
    }
  }

  cancel(): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.target || !d.from) return;
    const p = this.pairs[d.target.index];
    if (d.target.kind === 'body') p.body = d.from;
    else p.vol = d.from;
  }

  /** Take back the last point placed. */
  undo(): void {
    const last = this.pairs[this.pairs.length - 1];
    if (!last) return;
    if (last.vol) {
      last.vol = null;
      this.fit();
    } else this.pairs.pop();
    this.ctx.changed();
  }

  clear(): void {
    this.pairs = [];
    this.error = null;
    this.drag = null;
    this.ctx.changed();
  }

  /** A line for the panel. */
  summary(): string {
    const done = this.pairs.filter((p) => p.vol).length;
    if (this.pairs.length === 0) return 'Sin puntos. Clic en el cuerpo para empezar.';
    const pending = this.expecting === 'vol' ? ' Falta la pareja del ultimo punto en la imagen.' : '';
    const err = this.error !== null && done > 0 ? ` Distancia media ${this.error.toFixed(1)} mm.` : '';
    return `${done} ${done === 1 ? 'pareja' : 'parejas'}.${err}${pending}`;
  }

  /**
   * Ease the body to the placement that brings its points closest to theirs.
   * One pair: a move. Two: the turn that lines the pairs up, the least turn
   * that does, and the move that puts their middles together. Three or more:
   * the least-squares rigid fit.
   */
  private fit(): void {
    const done = this.pairs.filter((p): p is Pair & { vol: vec3 } => p.vol !== null);
    if (done.length === 0) {
      this.error = null;
      return;
    }
    const model = this.ctx.scene.bodyModel;
    let target: mat4;
    if (done.length === 1) {
      const at = vec3.transformMat4(vec3.create(), done[0].body, model);
      target = inScene(model, mat4.fromTranslation(mat4.create(), vec3.sub(vec3.create(), done[0].vol, at)));
    } else if (done.length === 2) {
      const a0 = vec3.transformMat4(vec3.create(), done[0].body, model);
      const a1 = vec3.transformMat4(vec3.create(), done[1].body, model);
      const from = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), a1, a0));
      const to = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), done[1].vol, done[0].vol));
      const q = quat.rotationTo(quat.create(), from, to);
      const mid = vec3.lerp(vec3.create(), a0, a1, 0.5);
      const goal = vec3.lerp(vec3.create(), done[0].vol, done[1].vol, 0.5);
      // Turn about the middle of the body's pair, then carry it to theirs.
      const local = mat4.fromTranslation(mat4.create(), goal);
      mat4.mul(local, local, mat4.fromQuat(mat4.create(), q));
      mat4.translate(local, local, vec3.negate(vec3.create(), mid));
      target = inScene(model, local);
    } else {
      target = horn(
        done.map((p) => p.body),
        done.map((p) => p.vol),
      );
    }
    let sum = 0;
    for (const p of done) sum += vec3.distance(vec3.transformMat4(vec3.create(), p.body, target), p.vol);
    this.error = sum / done.length;
    this.ctx.animateTo(target);
  }

  hint(): string {
    const n = this.pairs.length;
    if (this.drag?.target) return 'moviendo el punto';
    if (this.hover && this.hover !== 'next') {
      return `arrastrar mueve el punto ${this.hover.index + 1} ${this.hover.kind === 'body' ? 'del cuerpo' : 'de la imagen'}`;
    }
    if (this.hover === 'next') {
      return this.expecting === 'body' ? `clic: punto ${n + 1} en el cuerpo` : `clic: pareja del punto ${n} en la imagen`;
    }
    return this.expecting === 'body' ? 'clic en el cuerpo para poner un punto' : `clic en la imagen para la pareja del punto ${n}`;
  }

  cursor(): string | null {
    if (this.drag?.target) return 'grabbing';
    if (this.hover === 'next') return 'crosshair';
    if (this.hover) return 'grab';
    return null;
  }

  geometry(): Geometry {
    const scene = this.ctx.scene;
    if (!scene.body) return { body: [], scene: [] };
    const { right, up, forward } = scene.cameraBasis();
    const px = this.ctx.pixel();
    const model = scene.bodyModel;
    const bodyRight = toBodyDirection(right, model);
    const bodyUp = toBodyDirection(up, model);
    const out: LineBatch[] = [];
    const onBody: LineBatch[] = [];
    const held = this.drag?.target ?? (this.hover !== 'next' ? this.hover : null);
    this.pairs.forEach((p, i) => {
      const color = landmarkColor(i);
      const hotBody = held?.index === i && held.kind === 'body';
      const hotVol = held?.index === i && held.kind === 'vol';
      // The body's point: a dark-rimmed disc, drawn in the body's space.
      const rb = MARK_PX * px * (hotBody ? 1.4 : 1);
      onBody.push(discBatch(p.body, bodyRight, bodyUp, rb * 1.35, [0.05, 0.05, 0.06], 0.9));
      onBody.push(discBatch(p.body, bodyRight, bodyUp, rb, color, 1));
      if (p.vol) {
        const rv = MARK_PX * px * (hotVol ? 1.5 : 1.15);
        out.push(...tube(circleSegs(p.vol, right, up, rv, 32), forward, color, hotVol, 1));
        out.push(discBatch(p.vol, right, up, px * 1.5, color, 1));
        const at = this.bodyPoint(p);
        if (vec3.distance(at, p.vol) > rv) out.push(...tube(dashedLine(at, p.vol, 10), forward, color, false, 0.55));
      }
    });
    return { body: onBody, scene: out };
  }
}

/**
 * The rigid placement that takes points `a` onto points `b` in the least
 * squares sense: Horn's closed form, whose turn is the eigenvector of the
 * largest eigenvalue of a 4 by 4 symmetric matrix built from the points'
 * cross covariance, found here by Jacobi sweeps.
 */
function horn(a: vec3[], b: vec3[]): mat4 {
  const n = a.length;
  const ca = vec3.create();
  const cb = vec3.create();
  for (let i = 0; i < n; i++) {
    vec3.add(ca, ca, a[i]);
    vec3.add(cb, cb, b[i]);
  }
  vec3.scale(ca, ca, 1 / n);
  vec3.scale(cb, cb, 1 / n);
  // S[j][k] = sum (a - ca)_j (b - cb)_k.
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const p = vec3.sub(vec3.create(), a[i], ca);
    const q = vec3.sub(vec3.create(), b[i], cb);
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) S[j][k] += p[j] * q[k];
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const { values, vectors } = jacobi4(N);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  // The eigenvector is (w, x, y, z); gl-matrix keeps quaternions as (x, y, z, w).
  const q = quat.fromValues(vectors[1][best], vectors[2][best], vectors[3][best], vectors[0][best]);
  quat.normalize(q, q);
  const R = mat3.fromQuat(mat3.create(), q);
  const rca = vec3.transformMat3(vec3.create(), ca, R);
  const t = vec3.sub(vec3.create(), cb, rca);
  return mat4.fromRotationTranslation(mat4.create(), q, t);
}

/** Eigenvalues and eigenvectors (as columns) of a symmetric 4 by 4 matrix. */
function jacobi4(A0: number[][]): { values: number[]; vectors: number[][] } {
  const A = A0.map((r) => r.slice());
  const V = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p][q] * A[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2], A[3][3]], vectors: V };
}
