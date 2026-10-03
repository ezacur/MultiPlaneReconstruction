import { vec3 } from 'gl-matrix';

/**
 * Snapping the plane normal onto the cartesian axes of the voxel grid.
 *
 * Within a couple of degrees of one of them the normal goes exactly onto it,
 * so the acquisition planes are easy to land on and, more to the point, easy to
 * stay on: without this a drag that merely passes near one leaves the plane a
 * fraction of a degree oblique, and the image never quite settles.
 *
 * The sign of the normal does not change the slice, so the test is on the
 * absolute value of the dot product and the winner is given the sign of the
 * direction asked for.
 *
 * Restricting the normal to a discrete cloud of directions beyond the snap was
 * tried and dropped: it made turning the plane feel notched. The bench that
 * measured it is `tools/quantise-lab.html`, kept because it is also the easiest
 * way to pick the snap angle.
 */

/** The axis `n` is within `toleranceDeg` of, signed to match it, or null. */
export function snapToAxes(n: vec3, axes: vec3[], toleranceDeg: number): vec3 | null {
  if (toleranceDeg <= 0) return null;
  let best: vec3 | null = null;
  let bestDot = Math.cos((toleranceDeg * Math.PI) / 180);
  for (const a of axes) {
    const d = vec3.dot(n, a);
    if (Math.abs(d) > bestDot) {
      bestDot = Math.abs(d);
      best = d < 0 ? vec3.negate(vec3.create(), a) : vec3.clone(a);
    }
  }
  return best;
}
