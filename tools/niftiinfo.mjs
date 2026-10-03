import * as nifti from 'nifti-reader-js';
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  let buf = readFileSync(f); let ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (nifti.isCompressed(ab)) ab = nifti.decompress(ab);
  const h = nifti.readHeader(ab);
  const fmt = r => r.map(v => v.toFixed(2).padStart(8)).join(' ');
  console.log(`\n== ${f}: dims=${h.dims.slice(1,5)} pix=${h.pixDims.slice(1,4).map(v=>v.toFixed(2))} dtype=${h.datatypeCode} bits=${h.numBitsPerVoxel} slope=${h.scl_slope} inter=${h.scl_inter} q=${h.qform_code} s=${h.sform_code} LE=${h.littleEndian}`);
  h.affine.forEach(r => console.log('   ' + fmt(r)));
}
