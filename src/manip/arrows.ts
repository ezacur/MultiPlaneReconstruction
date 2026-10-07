import { vec3 } from 'gl-matrix';
import { AXIS_COLORS, bodyCentreInScene, handleUnit } from './common';
import { HandleGizmo, type Frame, type Handle } from './handles';

const LENGTH = 0.75;
const NAMES = ['R', 'A', 'S'];
const PAIRS = ['RA', 'RS', 'AS'];

/**
 * The classic move gizmo, at the body's middle: three arrows along the
 * volume's R, A and S axes, which move the body along one of them; three
 * squares between each two, which move it across their plane, each in the
 * colour of the axis it keeps still; and a centre that moves it across the
 * screen. The axes are the scene's, not the body's, so a move keeps to the
 * volume's own directions however the body has been turned.
 */
export class Arrows extends HandleGizmo {
  readonly id = 'arrows';

  protected frame(): Frame | null {
    const scene = this.ctx.scene;
    if (!scene.body) return null;
    const L = handleUnit(scene) * LENGTH;
    const axes: vec3[] = [vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)];
    const handles: Handle[] = axes.map((axis, i) => ({
      kind: 'arrow',
      axis,
      length: L,
      color: AXIS_COLORS[i],
      hint: `arrastrar mueve el cuerpo por el eje ${NAMES[i]}`,
      doing: `moviendo el cuerpo por el eje ${NAMES[i]}`,
    }));
    // Each square keeps one axis still and wears its colour.
    ([[0, 1, 2], [0, 2, 1], [1, 2, 0]] as const).forEach(([a, b, still], k) => {
      handles.push({
        kind: 'square',
        axes: [axes[a], axes[b]],
        from: L * 0.28,
        to: L * 0.5,
        color: AXIS_COLORS[still],
        hint: `arrastrar mueve el cuerpo en el plano ${PAIRS[k]}`,
        doing: `moviendo el cuerpo en el plano ${PAIRS[k]}`,
      });
    });
    handles.push({
      kind: 'centre',
      radius: L * 0.07,
      hint: 'arrastrar mueve el cuerpo en el plano de la pantalla',
      doing: 'moviendo el cuerpo',
    });
    return { centre: bodyCentreInScene(scene), handles };
  }
}
