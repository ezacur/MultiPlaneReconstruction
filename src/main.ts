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
  WORLD_PLANE_NAMES,
  type BoxFace,
  type PlaneSpace,
  type SlabMode,
} from './scene';
import { PlaneWidget } from './widget';

const SAMPLES = [
  { file: 'CT_pitch.nii.gz', label: 'TC craneo con gantry inclinado' },
  { file: 'CT_Abdo.nii.gz', label: 'TC abdomen' },
  { file: 'mni152.nii.gz', label: 'RM cerebro (plantilla MNI152)' },
];

const WL_PRESETS_CT = [
  { label: 'Abdomen', w: 400, l: 50 },
  { label: 'Pulmon', w: 1500, l: -600 },
  { label: 'Hueso', w: 1800, l: 400 },
  { label: 'Cerebro', w: 80, l: 40 },
];

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Falta el elemento ${sel} en el DOM`);
  return el;
};

const canvas = $<HTMLCanvasElement>('#gl');
const viewsRoot = $<HTMLElement>('#views');
const pane = $<HTMLElement>('#pane-3d');
const statusEl = $<HTMLElement>('#status');
const planeEl = $<HTMLElement>('#plane-info');
const probeEl = $<HTMLElement>('#probe-info');
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
const wlInfo = $<HTMLElement>('#wl-info');
const snapSlider = $<HTMLInputElement>('#snap');
const snapVal = $<HTMLElement>('#snap-val');
const slabSlider = $<HTMLInputElement>('#slab');
const slabVal = $<HTMLElement>('#slab-val');
const slabModeSel = $<HTMLSelectElement>('#slab-mode');
const wlPresetsEl = $<HTMLElement>('#wl-presets');
const gridPresetsEl = $<HTMLElement>('#grid-presets');
const worldPresetsEl = $<HTMLElement>('#world-presets');
const btnResetCamera = $<HTMLButtonElement>('#reset-camera');

const scene = new Scene();
const widget = new PlaneWidget(scene);
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
let faceHover: BoxFace | null = null;
let pending = false;

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
    // A plane transition needs frames back to back until it settles.
    const animating = scene.tickTransition(now);
    renderer.render(scene, widget, paneRect(), faceHover);
    updateOverlays();
    if (animating) requestRender();
  });
}

const fmt = (v: number, d = 1) => (Math.abs(v) < 5e-7 ? (0).toFixed(d) : v.toFixed(d));

const rgbToCss = (c: [number, number, number]) =>
  `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(' ')})`;

// ---- preset buttons --------------------------------------------------------

interface PresetButton {
  el: HTMLButtonElement;
  space: PlaneSpace;
  axis: number;
}
const presetButtons: PresetButton[] = [];

function buildPresets(): void {
  gridPresetsEl.textContent = '';
  worldPresetsEl.textContent = '';
  presetButtons.length = 0;

  // The acquisition plane is the one the last index steps through, so it is
  // listed last and selected by default.
  for (const axis of [0, 1, 2]) {
    const b = document.createElement('button');
    const others = [0, 1, 2].filter((i) => i !== axis).map((i) => GRID_AXIS_NAMES[i]);
    b.textContent = others.join('-');
    b.title = `Plano ${others.join('-')} de la rejilla: normal ${GRID_AXIS_NAMES[axis]}${
      axis === 2 ? ' (plano de adquisicion)' : ''
    }. Tecla ${GRID_AXIS_NAMES[axis]}`;
    b.addEventListener('click', () => goToPlane('grid', axis));
    gridPresetsEl.appendChild(b);
    presetButtons.push({ el: b, space: 'grid', axis });
  }

  for (const axis of [2, 1, 0]) {
    const b = document.createElement('button');
    b.textContent = WORLD_PLANE_NAMES[axis];
    b.title = `Tecla ${['S', 'C', 'A'][axis]}`;
    b.addEventListener('click', () => goToPlane('world', axis));
    worldPresetsEl.appendChild(b);
    presetButtons.push({ el: b, space: 'world', axis });
  }
}

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
  hintEl.textContent =
    st === null && faceHover
      ? `doble clic para el plano ${GRID_AXIS_NAMES[faceHover.axis]}`
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

  const n = scene.n;
  const lines = [
    `normal   ${fmt(n[0], 3)}, ${fmt(n[1], 3)}, ${fmt(n[2], 3)}`,
    `offset   ${fmt(scene.distance, 1)} mm`,
  ];
  const angles = [0, 1, 2].map((a) => scene.angleToGridAxis(a));
  if (angles.every((a) => a !== null)) {
    lines.push(
      `vs ejes  ${GRID_AXIS_NAMES.map((name, i) => `${name} ${(angles[i] as number).toFixed(0)}°`).join('  ')}`,
    );
  }
  planeEl.textContent = lines.join('\n');

  for (const b of presetButtons) {
    b.el.classList.toggle(
      'active',
      scene.preset !== null && scene.preset.space === b.space && scene.preset.axis === b.axis,
    );
  }

  const at = probe ?? scene.planePoint();
  const vx = scene.voxelAt(at);
  const val = scene.sampleWorld(at);
  probeEl.textContent = [
    `mundo  ${fmt(at[0])}, ${fmt(at[1])}, ${fmt(at[2])} mm (RAS)`,
    `voxel  ${fmt(vx[0], 1)}, ${fmt(vx[1], 1)}, ${fmt(vx[2], 1)}`,
    `valor  ${val === null ? 'fuera del volumen' : fmt(val, 2)}`,
    probe ? '(bajo el raton)' : '(centro del plano)',
  ].join('\n');

  wlInfo.textContent =
    `ventana ${fmt(scene.windowWidth)}   nivel ${fmt(scene.windowLevel)}`;
  // The needle only appears while actually reading a point of the slice, as in
  // the demo: parked on the plane centre it would just sit on top of a tick.
  colorbar.setProbe(probe ? val : null);
  colorbar.setLimits(scene.windowLo, scene.windowHi);
  colorbar.render();
  slabVal.textContent = scene.slabMm > 0 ? `${fmt(scene.slabMm)} mm` : 'corte fino';
  snapVal.textContent = scene.cartesianSnapDeg > 0 ? `${fmt(scene.cartesianSnapDeg, 1)}\u00b0` : 'sin snap';
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

function buildWlControls(vol: Volume): void {
  const span = Math.max(vol.max - vol.min, 1e-3);
  wlPresetsEl.textContent = '';
  const all = [
    ...(vol.looksLikeCT ? WL_PRESETS_CT : []),
    { label: 'Auto', w: vol.hi - vol.lo, l: (vol.hi + vol.lo) / 2 },
    { label: 'Completo', w: span, l: (vol.min + vol.max) / 2 },
  ];
  for (const p of all) {
    const b = document.createElement('button');
    b.textContent = p.label;
    // Through the bar, so the jump slides with its easing instead of landing.
    b.addEventListener('click', () => {
      const w = Math.max(1e-3, p.w);
      colorbar.animateTo(p.l - w / 2, p.l + w / 2);
    });
    wlPresetsEl.appendChild(b);
  }
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
  probe = null;

  const maxSlab = Math.max(10, Math.round(Math.min(...vol.dims.map((d, i) => d * vol.spacing[i])) / 2));
  slabSlider.max = String(maxSlab);
  slabSlider.value = '0';
  slabModeSel.value = '0';
  scene.slabMode = 0;

  buildWlControls(vol);
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
buildPresets();

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

btnResetCamera.addEventListener('click', resetCamera);

snapSlider.addEventListener('input', () => {
  scene.cartesianSnapDeg = Number(snapSlider.value);
  requestRender();
});

slabSlider.addEventListener('input', () => {
  scene.slabMm = Number(slabSlider.value);
  requestRender();
});
slabModeSel.addEventListener('change', () => {
  scene.slabMode = Number(slabModeSel.value) as SlabMode;
  requestRender();
});

attachInteraction(pane, scene, widget, {
  onChange: requestRender,
  onFaceHover: (face) => {
    faceHover = face;
    requestRender();
  },
  onProbe: (w) => {
    probe = w;
    requestRender();
  },
  onResetCamera: resetCamera,
  onPlane: goToPlane,
  onPinLevel: () => {
    if (probe) colorbar.pinLevel(scene.sampleWorld(probe));
  },
});

new ResizeObserver(() => requestRender()).observe(viewsRoot);
new ResizeObserver(() => colorbar.render()).observe($<HTMLElement>('#colorbar'));
window.addEventListener('resize', requestRender);

sampleSel.value = SAMPLES[0].file;
void guarded(() => loadUrl(`data/${SAMPLES[0].file}`, SAMPLES[0].file));
