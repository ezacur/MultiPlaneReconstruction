// Converts the CesiumMan glTF sample into the body surface the viewer loads.
//
//   node tools/body-from-gltf.mjs CesiumMan.glb public/models/body.json
//
// CesiumMan.glb comes from the Khronos glTF sample assets:
//   https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan
// (c) 2017 Cesium, CC-BY 4.0. Only the geometry is kept: no texture (which
// carries the Cesium logo), no skin, no animation.
//
// The mesh is taken in its bind pose, as stored: Z up, facing +X (the toes
// point that way), 1.51 units tall, feet at z = 0. It is turned into the
// patient's RAS by a proper rotation, +X to anterior, +Z to superior and +Y to
// the left, and scaled to a 1700 mm stature, so it stands in the same space as
// the volumes.
//
// Then it is cut across at half its height and the legs are dropped: what is
// kept is a bust, trunk, arms and head, standing on its flat cut. Triangles
// that cross the cut are clipped to it, with new vertices on the cut, so the
// base is a clean edge. The cut is moved to S = 0.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node tools/body-from-gltf.mjs <CesiumMan.glb> <out.json>');
  process.exit(1);
}
const STATURE_MM = 1700;
/** Where the body is cut across, as a fraction of its height from the soles. */
const CUT = 0.5;

const glb = readFileSync(input);
if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a binary glTF');
const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
const binStart = 20 + jsonLength + 8;

/** The elements of an accessor, as arrays of `size` numbers. */
function read(index, size) {
  const acc = gltf.accessors[index];
  const view = gltf.bufferViews[acc.bufferView];
  const base = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const bytes = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[acc.componentType];
  const stride = view.byteStride ?? bytes * size;
  const get = {
    5126: (o) => glb.readFloatLE(o),
    5125: (o) => glb.readUInt32LE(o),
    5123: (o) => glb.readUInt16LE(o),
    5121: (o) => glb.readUInt8(o),
  }[acc.componentType];
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    for (let k = 0; k < size; k++) row.push(get(base + i * stride + k * bytes));
    out.push(row);
  }
  return out;
}

const prim = gltf.meshes[0].primitives[0];
const pos = read(prim.attributes.POSITION, 3);
const nor = read(prim.attributes.NORMAL, 3);
const idx = read(prim.indices, 1).map((r) => r[0]);

const height = Math.max(...pos.map((p) => p[2])) - Math.min(...pos.map((p) => p[2]));
const scale = STATURE_MM / height;
const zMin = Math.min(...pos.map((p) => p[2]));
// (x, y, z) in the mesh -> (R, A, S) = (-y, x, z): a rotation, not a mirror.
const toRas = ([x, y, z]) => [-y, x, z];
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

const P = pos.map((p) => toRas([p[0], p[1], p[2] - zMin]).map((v) => v * scale));
const N = nor.map((n) => toRas(n));

// Clip every triangle to the half-space above the cut, S >= cutS. A vertex on
// the cut is made where an edge crosses it, its normal blended the same way.
const cutS = STATURE_MM * CUT;
const outP = [...P];
const outN = [...N];
const outI = [];
const crossing = new Map();
const onCut = (a, b) => {
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (crossing.has(key)) return crossing.get(key);
  const t = (cutS - P[a][2]) / (P[b][2] - P[a][2]);
  const lerp = (u, v) => u.map((x, k) => x + (v[k] - x) * t);
  outP.push(lerp(P[a], P[b]));
  outN.push(lerp(N[a], N[b]));
  crossing.set(key, outP.length - 1);
  return outP.length - 1;
};
for (let i = 0; i < idx.length; i += 3) {
  const tri = [idx[i], idx[i + 1], idx[i + 2]];
  const keep = tri.map((v) => P[v][2] >= cutS);
  if (keep.every(Boolean)) {
    outI.push(...tri);
    continue;
  }
  if (!keep.some(Boolean)) continue;
  // Walk the triangle's edges in order, keeping the inside corners and the
  // crossings: one or two corners in, so a triangle or a quad comes out.
  const poly = [];
  for (let k = 0; k < 3; k++) {
    const a = tri[k];
    const b = tri[(k + 1) % 3];
    if (keep[k]) poly.push(a);
    if (keep[k] !== keep[(k + 1) % 3]) poly.push(onCut(a, b));
  }
  for (let k = 1; k + 1 < poly.length; k++) outI.push(poly[0], poly[k], poly[k + 1]);
}
// Keep only the vertices still in use, renumbered, with the cut at S = 0.
const used = [...new Set(outI)].sort((a, b) => a - b);
const renum = new Map(used.map((v, k) => [v, k]));
const positions = used.flatMap((v) => [outP[v][0], outP[v][1], outP[v][2] - cutS].map((x) => round(x, 1)));
const normals = used.flatMap((v) => {
  const n = outN[v];
  const len = Math.hypot(...n) || 1;
  return n.map((x) => round(x / len, 3));
});
const indices = outI.map((v) => renum.get(v));

writeFileSync(
  output,
  JSON.stringify({
    source:
      'CesiumMan, Khronos glTF sample assets. (c) 2017 Cesium, CC-BY 4.0. ' +
      'Geometry only, cut across at half its height (legs removed).',
    units: 'mm, RAS, the cut at S = 0',
    positions,
    normals,
    indices,
  }),
);
const top = Math.max(...positions.filter((_, k) => k % 3 === 2));
console.log(
  `${used.length} vertices, ${indices.length / 3} triangles, ${round(top, 0)} mm from the cut to the top -> ${output}`,
);
