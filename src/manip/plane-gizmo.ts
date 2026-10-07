import { vec3 } from 'gl-matrix';
import { bodyCentreInScene, handleUnit, WHITE } from './common';
import { HandleGizmo, type Frame } from './handles';

/** Arrow length, as a fraction of the handle unit; the ring and the square
 *  are sized from it. */
const LENGTH = 0.75;

/**
 * A gizmo anchored to the slice: it stands on the plane, where the body's
 * middle falls square onto it, and its axes are the plane's own rather than
 * the body's. The arrow along the normal carries the body through the slice;
 * the two white arrows and the square slide it along the plane; the ring, in
 * the plane, turns it within the image. So what each handle does to the red
 * outline on the slice is plain: it shifts it, grows and shrinks it, or turns
 * it.
 */
export class PlaneGizmo extends HandleGizmo {
  readonly id = 'plane';

  protected frame(): Frame | null {
    const scene = this.ctx.scene;
    if (!scene.body || !scene.vol) return null;
    const L = handleUnit(scene) * LENGTH;
    const n = vec3.clone(scene.n);
    // The normal's arrow points out of the image, towards the viewer.
    if (vec3.dot(n, scene.cameraBasis().forward) > 0) vec3.negate(n, n);
    const bc = bodyCentreInScene(scene);
    const p = scene.planePoint();
    const centre = vec3.scaleAndAdd(vec3.create(), bc, scene.n, -vec3.dot(vec3.sub(vec3.create(), bc, p), scene.n));
    const color = scene.normalColor();
    return {
      centre,
      handles: [
        {
          kind: 'arrow',
          axis: n,
          length: L,
          color,
          hint: 'arrastrar mueve el cuerpo a traves del corte',
          doing: 'moviendo el cuerpo a traves del corte',
        },
        {
          kind: 'arrow',
          axis: vec3.clone(scene.u),
          length: L,
          color: WHITE,
          hint: 'arrastrar desliza el cuerpo por el plano',
          doing: 'deslizando el cuerpo por el plano',
        },
        {
          kind: 'arrow',
          axis: vec3.clone(scene.v),
          length: L,
          color: WHITE,
          hint: 'arrastrar desliza el cuerpo por el plano',
          doing: 'deslizando el cuerpo por el plano',
        },
        {
          kind: 'square',
          axes: [vec3.clone(scene.u), vec3.clone(scene.v)],
          from: L * 0.28,
          to: L * 0.5,
          color: WHITE,
          hint: 'arrastrar mueve el cuerpo en el plano del corte',
          doing: 'moviendo el cuerpo en el plano del corte',
        },
        {
          kind: 'ring',
          axis: vec3.clone(scene.n),
          radius: L * 1.2,
          color,
          hint: 'arrastrar gira el cuerpo dentro de la imagen',
          doing: 'girando el cuerpo dentro de la imagen',
        },
        {
          kind: 'centre',
          radius: L * 0.07,
          hint: 'arrastrar mueve el cuerpo en el plano de la pantalla',
          doing: 'moviendo el cuerpo',
        },
      ],
    };
  }
}
