import type { BodyMesh } from './scene';

/** For each edge of a mesh, its ends and the one or two triangles on it. */
export interface Edges {
  a: Uint16Array;
  b: Uint16Array;
  t0: Int32Array;
  /** -1 on the mesh's open border, such as the cut of the bust. */
  t1: Int32Array;
}

const cache = new WeakMap<BodyMesh, { edges: Edges; normals: Float32Array; border: Uint16Array }>();

/**
 * A mesh's edges, its triangles' normals and its open border, worked out once
 * per mesh: the border as pairs of corner indices.
 */
export function meshEdges(body: BodyMesh): { edges: Edges; normals: Float32Array; border: Uint16Array } {
  const cached = cache.get(body);
  if (cached) return cached;
  const I = body.indices;
  const P = body.positions;
  // Corners at the same place are one corner here: a texture seam splits
  // them in the model, and the seam would otherwise read as an open border.
  const weld = new Uint32Array(P.length / 3);
  const byPlace = new Map<string, number>();
  for (let i = 0; i < weld.length; i++) {
    const key = `${Math.round(P[i * 3] * 1000)},${Math.round(P[i * 3 + 1] * 1000)},${Math.round(P[i * 3 + 2] * 1000)}`;
    const first = byPlace.get(key);
    if (first === undefined) byPlace.set(key, i);
    weld[i] = first ?? i;
  }
  const map = new Map<number, number>();
  const a: number[] = [];
  const b: number[] = [];
  const t0: number[] = [];
  const t1: number[] = [];
  const normals = new Float32Array(I.length);
  for (let k = 0; k < I.length; k += 3) {
    const tri = k / 3;
    const i0 = I[k] * 3, i1 = I[k + 1] * 3, i2 = I[k + 2] * 3;
    const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
    const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[k] = nx / len;
    normals[k + 1] = ny / len;
    normals[k + 2] = nz / len;
    for (const [u, v] of [
      [I[k], I[k + 1]],
      [I[k + 1], I[k + 2]],
      [I[k + 2], I[k]],
    ]) {
      const wu = weld[u];
      const wv = weld[v];
      const key = Math.min(wu, wv) * 65536 + Math.max(wu, wv);
      const e = map.get(key);
      if (e === undefined) {
        map.set(key, a.length);
        a.push(u);
        b.push(v);
        t0.push(tri);
        t1.push(-1);
      } else t1[e] = tri;
    }
  }
  const border: number[] = [];
  for (let e = 0; e < a.length; e++) if (t1[e] < 0) border.push(a[e], b[e]);
  const out = {
    edges: { a: Uint16Array.from(a), b: Uint16Array.from(b), t0: Int32Array.from(t0), t1: Int32Array.from(t1) },
    normals,
    border: Uint16Array.from(border),
  };
  cache.set(body, out);
  return out;
}

/**
 * The body's outline seen along a direction, as line segments in the body's
 * space, flattened: where the surface turns from facing the eye to facing away.
 *
 * Taken edge by edge between front and back triangles, the outline of a mesh
 * this coarse zigzags along the triangles. It is taken instead where the
 * smooth surface the vertex normals describe turns edge on: in each triangle,
 * the line where the normal, interpolated across it, is square to the view,
 * between the two points of its edges where that crosses zero, the same as
 * the contour of the slice is taken. That gives smooth, joined curves. The
 * open border of the cut is added, as it is an outline of its own.
 *
 * `toEye` is the unit direction towards the eye, in the body's space.
 */
/** How far from edge on, as the cosine to the eye, a triangle may be and still
 *  carry the outline. */
const EDGE_ON = 0.5;

export function silhouette(body: BodyMesh, toEye: ArrayLike<number>): number[] {
  const P = body.positions;
  const N = body.normals;
  const I = body.indices;
  const count = P.length / 3;
  const g = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    g[i] = N[i * 3] * toEye[0] + N[i * 3 + 1] * toEye[1] + N[i * 3 + 2] * toEye[2];
  }
  const { normals: F } = meshEdges(body);
  const out: number[] = [];
  const cross = (u: number, v: number) => {
    const t = g[u] / (g[u] - g[v]);
    out.push(
      P[u * 3] + (P[v * 3] - P[u * 3]) * t,
      P[u * 3 + 1] + (P[v * 3 + 1] - P[u * 3 + 1]) * t,
      P[u * 3 + 2] + (P[v * 3 + 2] - P[u * 3 + 2]) * t,
    );
  };
  for (let k = 0; k < I.length; k += 3) {
    const v = [I[k], I[k + 1], I[k + 2]];
    // A corner exactly edge on counts as facing, so no crossing is taken twice.
    const front = v.map((i) => g[i] >= 0);
    if (front[0] === front[1] && front[1] === front[2]) continue;
    // The outline only runs through triangles seen nearly edge on. One that
    // plainly faces the eye, or away, crossing zero all the same, has vertex
    // normals at odds with its shape, as on a flat face whose corners share
    // the normals of a rounded edge, and would only scatter specks over it.
    const facing = F[k] * toEye[0] + F[k + 1] * toEye[1] + F[k + 2] * toEye[2];
    if (Math.abs(facing) > EDGE_ON) continue;
    let n = 0;
    for (let e = 0; e < 3; e++) {
      if (front[e] !== front[(e + 1) % 3]) {
        cross(v[e], v[(e + 1) % 3]);
        n++;
      }
    }
    if (n !== 2) out.length -= n * 3;
  }
  const { border } = meshEdges(body);
  for (let i = 0; i < border.length; i += 2) {
    const u = border[i] * 3;
    const w = border[i + 1] * 3;
    out.push(P[u], P[u + 1], P[u + 2], P[w], P[w + 1], P[w + 2]);
  }
  return out;
}
