import type { vec3 } from 'gl-matrix';
import { contentBox } from './layout';
import { ELEVATION_LIMIT, type BoxFace, type PlaneSpace, type Ray, type Scene } from './scene';
import type { PlaneWidget } from './widget';

type Mode = 'widget' | 'orbit' | 'wl';

interface Drag {
  pointerId: number;
  lastX: number;
  lastY: number;
  mode: Mode;
}

export interface InteractionHooks {
  onChange(): void;
  /** Which box face is under the pointer, or null. */
  onFaceHover(face: BoxFace | null): void;
  /** Pointer over the plane; world position, or null when it is off it. */
  onProbe(world: vec3 | null): void;
  /** Put the camera back to its default framing. */
  onResetCamera(): void;
  /** Swing the plane across to one of the cartesian planes. */
  onPlane(space: PlaneSpace, axis: number): void;
  /** Pin the level under the pointer as a level line. */
  onPinLevel(): void;
  /** Turn the camera to face the slice square on. */
  onFacePlane(): void;
  /** A window / level drag starts (true) or ends (false). */
  onWindowGesture(active: boolean): void;
}

/** Two right presses this close in time and space make a right double click. */
const RIGHT_DOUBLE_MS = 400;
const RIGHT_DOUBLE_PX = 6;

export function attachInteraction(
  pane: HTMLElement,
  scene: Scene,
  widget: PlaneWidget,
  hooks: InteractionHooks,
): void {
  let drag: Drag | null = null;
  // The browser has no double click for the right button, so it is timed here.
  let lastRight = { t: -Infinity, x: 0, y: 0 };

  const rayAt = (e: MouseEvent): Ray | null => {
    const r = contentBox(pane);
    if (r.width < 2 || r.height < 2) return null;
    const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - r.top) / r.height) * 2;
    const { mvp } = scene.cameraMatrix(r.width / r.height);
    return scene.rayAt(mvp, ndcX, ndcY);
  };

  const faceAt = (e: MouseEvent): BoxFace | null => {
    const ray = rayAt(e);
    return ray ? scene.pickBoxFace(ray) : null;
  };

  const cursorFor = (): string => {
    if (drag?.mode === 'wl') return 'ew-resize';
    const st = widget.state;
    if (st === 'translate' || st === 'plane') return 'ns-resize';
    if (st === 'rotate') return 'grabbing';
    if (st === 'ring') return 'pointer';
    return 'grab';
  };

  /** Report the point under the pointer on the plane, for the value readout. */
  const probeAt = (e: PointerEvent): void => {
    const ray = rayAt(e);
    const hit = ray ? scene.intersectPlane(ray) : null;
    hooks.onProbe(hit && scene.insideVolume(hit) ? hit : null);
  };

  pane.addEventListener('contextmenu', (e) => e.preventDefault());

  pane.addEventListener('pointerdown', (e) => {
    if (!scene.vol) return;
    e.preventDefault();
    // Capture can be refused for a pointer the browser no longer tracks; the
    // drag still works from the element's own events.
    try {
      pane.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const ray = rayAt(e);
    const onRing = ray !== null && widget.pick(ray) !== null;
    const onPlane = ray !== null && widget.overPlane(ray) !== null;
    const slideButton = e.button === 0 || e.button === 1 || e.button === 2;

    // A right double click on the image turns the camera to face it. The
    // second press is taken by it, rather than starting another slide.
    if (e.button === 2 && onPlane && !onRing) {
      const now = performance.now();
      const near =
        Math.hypot(e.clientX - lastRight.x, e.clientY - lastRight.y) <= RIGHT_DOUBLE_PX;
      if (now - lastRight.t <= RIGHT_DOUBLE_MS && near) {
        lastRight = { t: -Infinity, x: 0, y: 0 };
        hooks.onFacePlane();
        return;
      }
      lastRight = { t: now, x: e.clientX, y: e.clientY };
    }

    // Shift+click on the image pins the level under the pointer, as on the
    // bar. It is a click, not the start of a drag.
    if (e.shiftKey && e.button === 0 && onPlane && !onRing) {
      probeAt(e);
      hooks.onPinLevel();
      return;
    }

    let mode: Mode;
    if (e.ctrlKey || e.metaKey) {
      mode = 'wl';
    } else if (onRing && ray && e.button === 0) {
      // The band is the tilt handle.
      mode = widget.begin(ray, 'rotate') ? 'widget' : 'orbit';
    } else if (onPlane && ray && slideButton) {
      // Anywhere else on the plane, and the band under any other button, slides.
      mode = widget.begin(ray, 'translate') ? 'widget' : 'orbit';
    } else if (e.button === 1) {
      mode = 'wl';
    } else {
      mode = 'orbit';
    }

    drag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, mode };
    if (mode === 'wl') hooks.onWindowGesture(true);
    pane.style.cursor = cursorFor();
    hooks.onChange();
  });

  pane.addEventListener('pointermove', (e) => {
    if (!scene.vol) return;

    if (!drag) {
      const zoneChanged = widget.setHover(rayAt(e));
      hooks.onFaceHover(faceAt(e));
      probeAt(e);
      if (zoneChanged) pane.style.cursor = cursorFor();
      hooks.onChange();
      return;
    }
    if (drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    switch (drag.mode) {
      case 'widget': {
        const ray = rayAt(e);
        if (ray) widget.move(ray);
        break;
      }
      case 'wl': {
        const span = Math.max(1e-3, (scene.vol.max - scene.vol.min) / 400);
        scene.windowWidth = Math.max(1e-3, scene.windowWidth + dx * span);
        scene.windowLevel += dy * span;
        break;
      }
      case 'orbit':
        scene.stopCameraMove();
        scene.camera.azimuth -= dx * 0.008;
        scene.camera.elevation = Math.max(
          -ELEVATION_LIMIT,
          Math.min(ELEVATION_LIMIT, scene.camera.elevation + dy * 0.008),
        );
        break;
    }
    hooks.onChange();
  });

  pane.addEventListener(
    'wheel',
    (e) => {
      if (!scene.vol) return;
      e.preventDefault();
      // Shift turns the wheel horizontal in some browsers, so deltaY is 0 then.
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      const dir = Math.sign(delta);
      const ray = rayAt(e);
      // Over the plane the wheel belongs to the plane; off it, to the camera.
      if (ray && widget.overPlane(ray)) {
        scene.scrollSlices(-dir * (e.shiftKey ? 5 : 1));
      } else {
        scene.camera.zoom = Math.max(0.35, Math.min(5, scene.camera.zoom * (dir > 0 ? 1.1 : 1 / 1.1)));
      }
      hooks.onChange();
    },
    { passive: false },
  );

  pane.addEventListener('pointerleave', () => {
    if (drag) return;
    widget.clearHover();
    hooks.onFaceHover(null);
    hooks.onProbe(null);
    hooks.onChange();
  });

  pane.addEventListener('dblclick', (e) => {
    if (!scene.vol) return;
    // On the volume box, ask for the cartesian plane parallel to that face;
    // out in the open, reframe the camera.
    const face = faceAt(e);
    if (face) hooks.onPlane('grid', face.axis);
    else hooks.onResetCamera();
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === 'widget') widget.end();
    if (drag.mode === 'wl') hooks.onWindowGesture(false);
    drag = null;
    try {
      if (pane.hasPointerCapture(e.pointerId)) pane.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    widget.setHover(rayAt(e));
    pane.style.cursor = cursorFor();
    hooks.onChange();
  };
  pane.addEventListener('pointerup', endDrag);
  pane.addEventListener('pointercancel', endDrag);

  // The only key of the view: Escape puts back what the drag in progress
  // changed. Everything else is done with the mouse.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !scene.vol || !widget.active) return;
    widget.cancel();
    drag = null;
    hooks.onChange();
  });
}
