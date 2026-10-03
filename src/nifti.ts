import * as nifti from 'nifti-reader-js';
import { mat4 } from 'gl-matrix';

/**
 * A volume in memory, plus the geometry that relates voxel indices to world
 * coordinates.
 *
 * World coordinates are NIfTI's RAS+ convention, in millimetres:
 *   +x = Right, +y = Anterior, +z = Superior.
 *
 * `data` is stored with i fastest, then j, then k -- the NIfTI on-disk order,
 * which is also what `texImage3D` expects for a 3D texture.
 */
export interface Volume {
  name: string;
  dims: [number, number, number];
  /** Voxel size in mm along each voxel axis (derived from the affine). */
  spacing: [number, number, number];
  data: Float32Array;
  min: number;
  max: number;
  /** Robust display range (0.5% / 99.5% percentiles). */
  lo: number;
  hi: number;
  /** voxel index (continuous) -> world mm. Column-major, for WebGL. */
  voxelToWorld: mat4;
  worldToVoxel: mat4;
  datatype: string;
  /** Source of the geometry: 'sform', 'qform' or 'fallback'. */
  geometrySource: string;
  /** Number of volumes in the file; only the first is loaded. */
  timepoints: number;
  /** True when values look like Hounsfield units. */
  looksLikeCT: boolean;
}

const DATATYPES: Record<number, { name: string; ctor: new (b: ArrayBuffer) => ArrayLike<number>; bytes: number }> = {
  2: { name: 'uint8', ctor: Uint8Array, bytes: 1 },
  4: { name: 'int16', ctor: Int16Array, bytes: 2 },
  8: { name: 'int32', ctor: Int32Array, bytes: 4 },
  16: { name: 'float32', ctor: Float32Array, bytes: 4 },
  64: { name: 'float64', ctor: Float64Array, bytes: 8 },
  256: { name: 'int8', ctor: Int8Array, bytes: 1 },
  512: { name: 'uint16', ctor: Uint16Array, bytes: 2 },
  768: { name: 'uint32', ctor: Uint32Array, bytes: 4 },
};

function swapBytes(buf: ArrayBuffer, width: number): void {
  if (width < 2) return;
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += width) {
    for (let j = 0; j < width >> 1; j++) {
      const a = b[i + j];
      b[i + j] = b[i + width - 1 - j];
      b[i + width - 1 - j] = a;
    }
  }
}

/** Percentiles from a histogram, used for a sane default window/level. */
function robustRange(data: Float32Array, min: number, max: number): [number, number] {
  if (!(max > min)) return [min, max];
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = BINS / (max - min);
  for (let i = 0; i < data.length; i++) {
    let b = ((data[i] - min) * scale) | 0;
    if (b < 0) b = 0;
    else if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const loTarget = data.length * 0.005;
  const hiTarget = data.length * 0.995;
  let acc = 0;
  let lo = min;
  let hi = max;
  let gotLo = false;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (!gotLo && acc >= loTarget) {
      lo = min + (b / BINS) * (max - min);
      gotLo = true;
    }
    if (acc >= hiTarget) {
      hi = min + ((b + 1) / BINS) * (max - min);
      break;
    }
  }
  return lo < hi ? [lo, hi] : [min, max];
}

export function parseNifti(raw: ArrayBuffer, name: string): Volume {
  let buf = raw;
  if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
  if (!nifti.isNIFTI(buf)) throw new Error('El fichero no tiene una cabecera NIfTI valida.');

  const hdr = nifti.readHeader(buf);
  if (!hdr) throw new Error('No se pudo leer la cabecera NIfTI.');

  const nx = hdr.dims[1] | 0;
  const ny = hdr.dims[2] | 0;
  const nz = Math.max(1, hdr.dims[3] | 0);
  const nt = hdr.dims[0] >= 4 ? Math.max(1, hdr.dims[4] | 0) : 1;
  if (nx < 1 || ny < 1) throw new Error(`Dimensiones no validas: ${nx}x${ny}x${nz}`);

  const spec = DATATYPES[hdr.datatypeCode];
  if (!spec) throw new Error(`Tipo de dato NIfTI no soportado (codigo ${hdr.datatypeCode}).`);

  const voxels = nx * ny * nz;
  const imgBuf = nifti.readImage(hdr, buf) as ArrayBuffer;
  const needed = voxels * spec.bytes;
  if (imgBuf.byteLength < needed) {
    throw new Error(`Datos truncados: se esperaban ${needed} bytes y hay ${imgBuf.byteLength}.`);
  }
  // Only the first timepoint of a 4D file is loaded.
  const oneVol = imgBuf.byteLength > needed ? imgBuf.slice(0, needed) : imgBuf;
  if (!hdr.littleEndian) swapBytes(oneVol, spec.bytes);
  const src = new spec.ctor(oneVol);

  // scl_slope == 0 means "no scaling" per the NIfTI spec.
  const slope = hdr.scl_slope === 0 ? 1 : hdr.scl_slope;
  const inter = hdr.scl_inter || 0;

  const data = new Float32Array(voxels);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < voxels; i++) {
    const v = src[i] * slope + inter;
    data[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max)) {
    min = 0;
    max = 1;
  }

  // hdr.affine is row-major [row][col], voxel -> world mm (RAS+).
  const voxelToWorld = mat4.create();
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) voxelToWorld[c * 4 + r] = hdr.affine[r][c];

  const worldToVoxel = mat4.create();
  if (!mat4.invert(worldToVoxel, voxelToWorld)) {
    throw new Error('La matriz affine del NIfTI no es invertible.');
  }

  const colLen = (c: number) =>
    Math.hypot(voxelToWorld[c * 4], voxelToWorld[c * 4 + 1], voxelToWorld[c * 4 + 2]) || 1;

  const geometrySource =
    hdr.sform_code > 0 && hdr.sform_code >= hdr.qform_code
      ? 'sform'
      : hdr.qform_code > 0
        ? 'qform'
        : 'fallback (pixdim)';

  const [lo, hi] = robustRange(data, min, max);

  return {
    name,
    dims: [nx, ny, nz],
    spacing: [colLen(0), colLen(1), colLen(2)],
    data,
    min,
    max,
    lo,
    hi,
    voxelToWorld,
    worldToVoxel,
    datatype: spec.name,
    geometrySource,
    timepoints: nt,
    looksLikeCT: min < -300 && max > 100,
  };
}
