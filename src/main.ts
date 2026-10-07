import { vec3 } from 'gl-matrix';
import { Colorbar } from './colorbar';
import { attachInteraction } from './interact';
import { contentBox } from './layout';
import { parseNifti, type Volume } from './nifti';
import { Renderer, type Rect } from './renderer';
import {
  directionLabel,
  GRID_AXIS_NAMES,
  Scene,
  type BodyMesh,
  type PlaneSpace,
} from './scene';
import { Pedestal } from './pedestal';
import { PlaneWidget } from './widget';

const SAMPLES = [
  { file: 'CT_pitch.nii.gz', label: 'TC craneo con gantry inclinado' },
  { file: 'CT_Abdo.nii.gz', label: 'TC abdomen' },
  { file: 'mni152.nii.gz', label: 'RM cerebro (plantilla MNI152)' },
];
/** The volume loaded on start. */
const DEFAULT_SAMPLE = 'CT_Abdo.nii.gz';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Falta el elemento ${sel} en el DOM`);
  return el;
};

const canvas = $<HTMLCanvasElement>('#gl');
const viewsRoot = $<HTMLElement>('#views');
const pane = $<HTMLElement>('#pane-3d');
const statusEl = $<HTMLElement>('#status');
const volEl = $<HTMLElement>('#vol-info');
const hintEl = $<HTMLElement>('#hint-3d');
const titleEl = pane.querySelector<HTMLElement>('.title')!;
const sliceEl = pane.querySelector<HTMLElement>('.slice')!;
const axisEls = ['R', 'A', 'S'].map((k, i) => {
  const el = $<HTMLElement>(`#axis-${i}`);
  el.textContent = k;
  return el;
});
const sampleSel = $<HTMLSelectElement>('#sample');
const fileInput = $<HTMLInputElement>('#file');

const scene = new Scene();
const widget = new PlaneWidget(scene);
const pedestal = new Pedestal(scene);
const colorbar = new Colorbar($<HTMLElement>('#colorbar'), {
  onLimits: (lo, hi) => {
    scene.windowWidth = Math.max(1e-6, hi - lo);
    scene.windowLevel = (lo + hi) / 2;
    requestRender();
  },
  onWarp: (knots) => {
    scene.warpKnots = knots;
    requestRender();
  },
  onSaturation: (under, over) => {
    scene.underColor = under;
    scene.overColor = over;
    requestRender();
  },
  onLevels: (live, pins, hot) => {
    scene.isoLive = live;
    scene.isoPins = pins;
    scene.isoHot = hot;
    requestRender();
  },
});
let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  statusEl.textContent = err instanceof Error ? err.message : String(err);
  statusEl.classList.add('err');
  throw err;
}

let probe: vec3 | null = null;
let pending = false;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isError);
}

/** The GL viewport, in CSS px relative to the canvas. */
function paneRect(): Rect {
  const cb = contentBox(canvas);
  const r = contentBox(pane);
  return { x: r.left - cb.left, y: r.top - cb.top, w: r.width, h: r.height };
}

function requestRender(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame((now) => {
    pending = false;
    // A plane transition or a camera swing needs frames back to back until it
    // settles. Both are ticked: neither may be skipped by the other.
    const plane = scene.tickTransition(now);
    const camera = scene.tickCamera(now);
    const ring = widget.tick(now, pedestal.active);
    const ped = pedestal.tick(now);
    const animating = plane || camera || ring || ped;
    renderer.render(scene, widget, paneRect(), pedestal.geometry());
    updateOverlays();
    if (animating) requestRender();
    else {
      // The pedestal held up after use: come back when its fade is due.
      const wait = pedestal.untilFade(now);
      if (wait !== null) {
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(requestRender, wait + 20);
      }
    }
  });
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 5e-7 ? (0).toFixed(d) : v.toFixed(d));

const rgbToCss = (c: [number, number, number]) =>
  `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(' ')})`;

// ---- overlays --------------------------------------------------------------

/** Park the R/A/S letters on the tips of the corner axis marker. */
function updateAxisLabels(): void {
  const r = contentBox(pane);
  if (r.width < 2 || r.height < 2) return;
  const triad = scene.orientationTriad(r.width / r.height);
  triad.axes.forEach((ax, i) => {
    const el = axisEls[i];
    // NDC to pane pixels; y is flipped because NDC grows upwards.
    el.style.left = `${((ax.tip[0] + 1) / 2) * r.width}px`;
    el.style.top = `${((1 - ax.tip[1]) / 2) * r.height}px`;
    el.style.color = rgbToCss(ax.color);
    // Fade an axis as it turns away from the viewer.
    el.style.opacity = String(1 - 0.55 * Math.max(0, ax.depth));
  });
}

function updateOverlays(): void {
  const vol = scene.vol;
  if (!vol) return;

  const thick = scene.slabMm > 0 ? `, espesor ${fmt(scene.slabMm)} mm` : '';
  titleEl.textContent = scene.planeName();
  sliceEl.textContent =
    `normal hacia ${directionLabel(scene.n)}, ${fmt(scene.distance)} mm del centro${thick}`;

  const st = widget.state;
  const pg = pedestal.gesture;
  const pz = pedestal.zone;
  const ring = pedestal.gizmoRing;
  const ringName = ring === null ? '' : ['R', 'A', 'S'][ring];
  const pedestalHint =
    pg === 'gizmo' && ring === 3 ? 'girando el cuerpo en el plano de la vista'
    : pg === 'gizmo' ? `girando el cuerpo sobre su eje ${ringName}`
    : pz === 'gizmo' && ring === 4 ? 'arrastrar mueve el cuerpo'
    : pz === 'gizmo' && ring === 3 ? 'arrastrar gira el cuerpo en el plano de la vista'
    : pz === 'gizmo' ? `arrastrar gira el cuerpo sobre su eje ${ringName}`
    : pg === 'tilt' ? 'inclinando el cuerpo'
    : pg === 'axial' ? 'desplazando el cuerpo por el eje del pedestal'
    : pg === 'spin' ? 'girando el cuerpo sobre el eje del pedestal'
    : pg === 'free' ? 'moviendo el cuerpo'
    : pg === 'planar' ? 'desplazando el cuerpo en el plano del pedestal'
    : pz === 'rim' ? 'izquierdo inclina el cuerpo; central lo desplaza por el eje'
    : pz === 'cap' ? 'arrastrar desplaza el cuerpo por el eje del pedestal'
    : pz === 'side' ? 'izquierdo gira el cuerpo; central lo mueve; derecho, en el plano del pedestal'
    : '';
  hintEl.textContent =
    pedestalHint ? pedestalHint
    : widget.hoveredMark !== null
      ? `doble clic: plano de normal ${GRID_AXIS_NAMES[widget.hoveredMark]}`
      : st === 'translate'
      ? 'deslizando por la normal'
      : st === 'rotate'
        ? 'inclinando el plano'
        : st === 'ring'
          ? 'arrastrar inclina el plano'
          : st === 'plane'
            ? 'arrastrar desliza el plano'
            : '';

  // Tie the caption to the plane's directional colour.
  titleEl.style.color = rgbToCss(scene.normalColor());

  updateAxisLabels();

  // Read off the slice under the pointer, for the bar's needle and level line.
  const val = probe ? scene.sampleWorld(probe) : null;

  // The needle only appears while actually reading a point of the slice, as in
  // the demo: parked on the plane centre it would just sit on top of a tick.
  colorbar.setProbe(val);
  colorbar.setLimits(scene.windowLo, scene.windowHi);
  colorbar.render();
}

function showVolumeInfo(vol: Volume): void {
  volEl.textContent = [
    `fichero   ${vol.name}`,
    `dims      ${vol.dims.join(' x ')}${vol.timepoints > 1 ? `  (${vol.timepoints} vols, se usa el 1o)` : ''}`,
    `espaciado ${vol.spacing.map((s) => fmt(s, 2)).join(' x ')} mm`,
    `tipo      ${vol.datatype} -> ${renderer.textureFormat}`,
    `rango     ${fmt(vol.min, 1)} .. ${fmt(vol.max, 1)}`,
    `geometria ${vol.geometrySource}`,
  ].join('\n');
}

function resetCamera(): void {
  scene.resetCamera();
  requestRender();
}

/** Animate the plane across to one of the cartesian planes. */
function goToPlane(space: PlaneSpace, axis: number): void {
  scene.animateToCartesian(space, axis);
  requestRender();
}

// ---- loading ---------------------------------------------------------------

async function loadBuffer(buf: ArrayBuffer, name: string): Promise<void> {
  setStatus(`Procesando ${name}...`);
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  const vol = parseNifti(buf, name);
  renderer.setVolume(vol);
  scene.setVolume(vol);
  colorbar.setVolume(vol);
  widget.clearHover();
  widget.reveal();
  pedestal.reveal();
  probe = null;

  showVolumeInfo(vol);
  requestRender();
  setStatus(`${name} cargado en ${Math.round(performance.now() - t0)} ms`);
}

async function loadUrl(url: string, name: string): Promise<void> {
  setStatus(`Descargando ${name}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${name} (HTTP ${res.status})`);
  await loadBuffer(await res.arrayBuffer(), name);
}

async function guarded(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    console.error(err);
  }
}

// ---- wiring ----------------------------------------------------------------

for (const s of SAMPLES) {
  const o = document.createElement('option');
  o.value = s.file;
  o.textContent = s.label;
  sampleSel.appendChild(o);
}

sampleSel.addEventListener('change', () => {
  const s = SAMPLES.find((x) => x.file === sampleSel.value);
  if (s) void guarded(() => loadUrl(`data/${s.file}`, s.file));
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void guarded(async () => loadBuffer(await f.arrayBuffer(), f.name));
});

for (const ev of ['dragenter', 'dragover'] as const) {
  viewsRoot.addEventListener(ev, (e) => {
    e.preventDefault();
    viewsRoot.classList.add('dragover');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  viewsRoot.addEventListener(ev, (e) => {
    e.preventDefault();
    viewsRoot.classList.remove('dragover');
  });
}
viewsRoot.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void guarded(async () => loadBuffer(await f.arrayBuffer(), f.name));
});

// The corner axis marker is a control: clicking an axis swings the camera
// round to look along it, that axis towards the viewer, and clicking it again
// goes round to the other side. The labels sit inside the pane, so their
// presses are kept from reaching the pane's own orbit and double click.
axisEls.forEach((el, i) => {
  el.title = `Mirar desde ${['R', 'A', 'S'][i]}; otra vez, desde ${['L', 'P', 'I'][i]}`;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('dblclick', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!scene.vol) return;
    scene.viewAlongAxis(i);
    requestRender();
  });
});

attachInteraction(pane, scene, widget, pedestal, {
  onChange: requestRender,
  onProbe: (w) => {
    probe = w;
    requestRender();
  },
  onResetCamera: resetCamera,
  onPlane: goToPlane,
  onPinLevel: () => {
    if (probe) colorbar.pinLevel(scene.sampleWorld(probe));
  },
  onFacePlane: () => {
    scene.facePlane();
    requestRender();
  },
  // The bar keeps its scale still while the window is dragged from the view,
  // and eases it to the new limits once the drag is over.
  onWindowGesture: (active) => {
    if (active) colorbar.holdScale();
    else colorbar.releaseScale();
  },
});

new ResizeObserver(() => requestRender()).observe(viewsRoot);
new ResizeObserver(() => colorbar.render()).observe($<HTMLElement>('#colorbar'));
window.addEventListener('resize', requestRender);

sampleSel.value = DEFAULT_SAMPLE;
void guarded(() => loadUrl(`data/${DEFAULT_SAMPLE}`, DEFAULT_SAMPLE));

/**
 * The body surface that stands beside the volume on its pedestal: loaded once,
 * on its own, so a missing or slow model never holds the volume up.
 */
async function loadBody(): Promise<void> {
  const res = await fetch('models/body.json');
  if (!res.ok) throw new Error(`No se pudo cargar el cuerpo (HTTP ${res.status})`);
  const j = (await res.json()) as { positions: number[]; normals: number[]; indices: number[] };
  const positions = Float32Array.from(j.positions);
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    const p = positions.subarray(i, i + 3) as unknown as vec3;
    vec3.min(min, min, p);
    vec3.max(max, max, p);
  }
  const mesh: BodyMesh = {
    positions,
    normals: Float32Array.from(j.normals),
    indices: Uint16Array.from(j.indices),
    min,
    max,
  };
  renderer.setBody(mesh);
  scene.setBody(mesh);
  pedestal.reveal();
  requestRender();
}
loadBody().catch((err) => console.error(err));
