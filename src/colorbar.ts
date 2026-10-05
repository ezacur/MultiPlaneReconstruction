import type { Volume } from './nifti';
import { MAX_KNOTS, MAX_PINS } from './renderer';

/**
 * Horizontal grayscale colour bar, after `icolorbar_demo.html` laid on its
 * side: values run left to right.
 *
 * The bar shows the transfer function itself: black below the low limit, the
 * ramp between the limits, white above the high one. Above it, a collapsible
 * read-only histogram of the volume says where the data actually is, so a
 * window can be placed on the tissue rather than guessed from two numbers.
 *
 * Two ideas are carried over from the demo and are what make it usable:
 *
 *  - **an elastic domain**. The bar does not show a fixed range. It always
 *    spans the data plus a margin, stretched to take in whatever the limits are
 *    doing. While a drag is in progress it can only open, never shrink, or the
 *    scale would rescale under the cursor mid-gesture; on release it eases back
 *    to its natural size.
 *  - **auto-advance**. Pulling a limit past the end of the bar keeps moving it
 *    without moving the mouse further. The law is on the range, not on pixels:
 *    the distance from the stationary limit to the one being dragged multiplies
 *    by alpha each second, and alpha grows with how far past the end the cursor
 *    is, measured as a fraction of the bar's length so the feel does not depend
 *    on the window size.
 */

/** Matches the CSS custom properties, which come from the demo's dark theme. */
const INK_2 = '#A3B1BA';
const LINE = '#3A4A55';

/** Heights of the three rows, top to bottom: histogram, bar, ticks. */
const HIST_H = 46;
const BAR_H = 16;
const TICKS_H = 32;
const HIST_BINS = 128;
/** Margin of the domain beyond the data range, as a fraction of it. */
const DOM_PAD = 0.025;
/** Margin the domain always keeps beyond the limits, as a fraction of itself. */
const DOM_CAP = 0.025;
/** The narrowest window, as a fraction of the domain. */
const MIN_SPAN = 1e-3;
/** Gain applied while Alt is held. */
const FINE_GAIN = 0.15;
/** Overflow worth one doubling per second, as a fraction of the bar's length. */
const AUTO_U2 = 0.15;
/** Ceiling on the auto-advance rate: 2^6 per second. */
const AUTO_CAP = 6;
/** How long the bar takes to reframe after a drag, in milliseconds. */
const DOM_ANIM_MS = 700;
/** How long an animated limit change takes. The reframe is deliberately
 *  slower: it is the background, and a background that runs as fast as the
 *  figure reads as a jerk. */
const LIM_ANIM_MS = 550;
/** A press has to move this far, in pixels, before it counts as a drag. */
const DRAG_SLOP = 3;
/** An axis tick this close to a limit box, in pixels, is dropped: the box is
 *  centred on its limit and about as wide as a five-figure number. */
const TICK_CLEARANCE = 42;
/** Bins used for the quantiles; finer than the drawn histogram. */
const QUANT_BINS = 4096;
/** The percentile stops the magnet snaps to while Ctrl is held. */
const PCTS = [0, 2, 5, 10, 25, 50, 75, 90, 95, 98, 100];
/** Two percentile labels closer than this, in pixels, cannot both show. */
const GUIDE_CLEARANCE = 30;
/** How long the histogram takes to fold or unfold, in milliseconds. */
const HIST_ANIM_MS = 550;
/** Below this height the percentile labels and the Ctrl guides do not fit, and
 *  are hidden; it is only ever crossed during the fold animation. */
const PCT_MIN = 30;
/** A double click this close to a handle, in pixels, counts as on it. */
const HANDLE_HIT = 8;

const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

type Limit = 'lo' | 'hi';

interface Drag {
  pointerId: number;
  kind: Limit | 'pan' | 'knot';
  /** Index of the knot being dragged, when kind is 'knot'. */
  knot?: number;
  /** Its x when the drag began, for the relative move and for Escape. */
  knotX0?: number;
  /** Cursor x at the last re-anchor, in client pixels. */
  x0: number;
  lo0: number;
  hi0: number;
  lastX: number;
  alt: boolean;
  /** False until the press has travelled past the dead zone. */
  moved: boolean;
  /** The limits when the gesture began, so Escape can put them back. */
  orig: { lo: number; hi: number };
}

function niceTicks(a: number, b: number, count: number): number[] {
  const span = b - a;
  if (!(span > 0)) return [a];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  // By index rather than accumulating v += step: the running sum drifts in
  // floating point, and a tick meant for 0 comes out as -5.6e-17.
  const out: number[] = [];
  for (let n = Math.ceil(a / step); n * step <= b + step * 1e-6; n++) out.push(n * step);
  return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Knots are kept this far from the ends of the window and from each other. */
const KNOT_MARGIN = 0.03;
const KNOT_GAP = 0.02;
/** A second right click within this many ms deletes a knot. */
const RCLICK_MS = 500;

/** Swatches offered for a saturation colour, as in the demo. */
const SWATCHES = ['#14181C', '#6B7278', '#FFFFFF', '#7A1FA2'];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface Knot {
  /** Position along the value axis inside the window, 0 to 1. */
  x: number;
  /** Position along the grey axis, 0 to 1. */
  y: number;
}

export interface ColorbarHooks {
  /** The limits changed; the caller owns the window and level. */
  onLimits(lo: number, hi: number): void;
  /** The warp of the ramp changed. */
  onWarp(knots: Knot[]): void;
  /** A saturation colour changed; null means "use the end of the ramp". */
  onSaturation(under: [number, number, number] | null, over: [number, number, number] | null): void;
  /**
   * The level lines changed: the live one (null when off), the pinned ones,
   * and the index of the highlighted pin, or -1.
   */
  onLevels(live: number | null, pins: number[], hot: number): void;
}

export class Colorbar {
  private hooks: ColorbarHooks;
  private root: HTMLElement;
  private track: HTMLElement;
  private histCanvas: HTMLCanvasElement;
  private barCanvas: HTMLCanvasElement;
  private histBtn: HTMLButtonElement;
  private ticksEl: HTMLElement;
  private needle: HTMLElement;
  private needleLabel: HTMLElement;
  private handles: Record<Limit, HTMLElement>;
  private limitEls: Record<Limit, HTMLInputElement>;
  private pctEls: Record<Limit, HTMLElement>;
  private dataMarks: Record<Limit, HTMLElement>;

  private vol: Volume | null = null;
  private counts = new Uint32Array(HIST_BINS);
  /** Reference count the bars are scaled against; the tallest bins saturate. */
  private countRef = 1;
  /** Cumulative of a much finer histogram, for percentiles and quantiles. */
  private fineCum = new Float64Array(QUANT_BINS + 1);
  private ctrlDown = false;
  private guideSig = '';

  private dataLo = 0;
  private dataHi = 1;
  private dom0 = 0;
  private dom1 = 1;
  /** While dragging the domain ratchets open and never closes. */
  private domHold: { d0: number; d1: number } | null = null;
  private domAnim: { d0: number; d1: number; start: number } | null = null;
  private limAnim: { lo0: number; hi0: number; lo1: number; hi1: number; start: number } | null = null;

  private lo = 0;
  private hi = 1;
  private probe: number | null = null;
  private drag: Drag | null = null;
  private autoT = 0;
  private raf = 0;
  private histOpen = true;

  /**
   * Caches, as in the demo. The host calls render() on every frame of the 3D
   * view, most of them for a pointer move that changes nothing here but the
   * needle, so everything else is redrawn only when its signature changes.
   */
  private renderSig = '';
  /** Length of the track; read once per render, since a read after the style
   *  writes of the same render forces a synchronous reflow. */
  private trackLen = 1;
  /** The bar's pixels, reused between frames instead of a fresh canvas each. */
  private barImg: ImageData | null = null;
  private barPx: Uint32Array | null = null;
  /** Read on every pointer move; dropped on resize, scroll and layout changes. */
  private trackRect: DOMRect | null = null;
  private barRect: DOMRect | null = null;

  /** Height of the histogram row, animated between HIST_H and 0. */
  private histH = HIST_H;
  private histAnim: { from: number; to: number; start: number } | null = null;

  /**
   * Level lines, as in the demo. Over the bar the pointer points at a level;
   * over the slice, the probe does. With Shift that level is drawn as a line
   * over the slice, and Shift+click pins it.
   */
  private hoverLevel: number | null = null;
  private shiftDown = false;
  private pins: number[] = [];
  private hotPin: number | null = null;
  private levelsSig = '';
  private pinsSig = '';

  /** Saturation colours as hex, or null for "the end of the ramp". */
  private knots: Knot[] = [];
  private rclick = { i: -1, t: -1e9 };
  private under: string | null = null;
  private over: string | null = null;
  private picker: HTMLElement;
  // Assigned inside buildPicker(), which the constructor calls.
  private pickerWho!: HTMLElement;
  private pickerSwatches!: HTMLElement;
  private pickerInput!: HTMLInputElement;
  private pickerWhich: 'under' | 'over' | null = null;

  constructor(root: HTMLElement, hooks: ColorbarHooks) {
    this.hooks = hooks;
    this.root = root;
    root.classList.add('cb');
    root.style.setProperty('--cb-hist', `${HIST_H}px`);
    root.style.setProperty('--cb-bar', `${BAR_H}px`);
    root.style.setProperty('--cb-ticks', `${TICKS_H}px`);

    const el = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      cls: string,
      parent: HTMLElement,
    ): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      parent.appendChild(node);
      return node;
    };

    this.track = el('div', 'cb-track', root);
    this.histCanvas = el('canvas', 'cb-hist', this.track);
    this.barCanvas = el('canvas', 'cb-bar', this.track);
    this.histBtn = el('button', 'cb-histbtn', this.track);
    this.histBtn.type = 'button';
    this.ticksEl = el('div', 'cb-ticks', this.track);
    this.needle = el('div', 'cb-needle', this.track);
    this.needleLabel = el('span', '', this.needle);

    const makeHandle = (which: Limit) => {
      const h = el('div', 'cb-hnd', this.track);
      h.dataset.w = which;
      h.title =
        which === 'hi'
          ? 'arrastra para el maximo, doble clic: al percentil 100, clic derecho: color de overflow'
          : 'arrastra para el minimo, doble clic: al percentil 0, clic derecho: color de underflow';
      return h;
    };
    // The limit boxes are the first and last tick of the scale: same place and
    // same mark as the others, but editable.
    const makeLimit = (which: Limit) => {
      const box = el('div', 'cb-lim', this.track);
      el('i', '', box);
      const input = el('input', 'cb-lim-in', box);
      input.type = 'text';
      input.spellcheck = false;
      input.title =
        which === 'hi'
          ? 'Limite superior, el ultimo tick de la escala, a la derecha'
          : 'Limite inferior, el primer tick de la escala, a la izquierda';
      input.inputMode = 'decimal';
      // Only `change`, so it commits on blur or Enter and not while typing.
      input.addEventListener('change', () => {
        const v = parseFloat(input.value.replace(',', '.'));
        if (!isFinite(v)) {
          input.value = this.fmt(which === 'hi' ? this.hi : this.lo);
          return;
        }
        const min = this.minWindow();
        if (which === 'hi') this.animLimits(this.lo, Math.max(this.lo + min, v));
        else this.animLimits(Math.min(this.hi - min, v), this.hi);
        this.schedule();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') {
          input.value = this.fmt(which === 'hi' ? this.hi : this.lo);
          input.blur();
        }
        e.stopPropagation();
      });
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      return input;
    };

    this.handles = { hi: makeHandle('hi'), lo: makeHandle('lo') };
    this.limitEls = { hi: makeLimit('hi'), lo: makeLimit('lo') };
    this.pctEls = { hi: el('div', 'cb-pct', this.track), lo: el('div', 'cb-pct', this.track) };
    this.dataMarks = {
      hi: el('div', 'cb-dmark', this.track),
      lo: el('div', 'cb-dmark', this.track),
    };

    this.picker = this.buildPicker();
    this.setHistOpen(true, false);
    this.attach();
  }

  /**
   * The saturation colour dialog: which side, a swatch for "none", a few fixed
   * ones and the system picker. Nothing else, no buttons and no text.
   */
  private buildPicker(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cb-pick';
    box.hidden = true;
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Color de saturacion');

    this.pickerWho = document.createElement('p');
    this.pickerWho.className = 'cb-pick-t';
    this.pickerSwatches = document.createElement('div');
    this.pickerSwatches.className = 'cb-sw';

    const none = document.createElement('button');
    none.type = 'button';
    none.dataset.c = '';
    none.className = 'cb-sw-ramp';
    none.title = 'ninguno, el extremo de la rampa';
    this.pickerSwatches.appendChild(none);
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.c = c;
      b.style.background = c;
      b.title = c;
      this.pickerSwatches.appendChild(b);
    }
    this.pickerInput = document.createElement('input');
    this.pickerInput.type = 'color';
    this.pickerInput.title = 'otro...';
    this.pickerSwatches.appendChild(this.pickerInput);

    box.append(this.pickerWho, this.pickerSwatches);
    document.body.appendChild(box);

    this.pickerSwatches.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      this.setSaturation(b.dataset.c || null);
      this.closePicker();
    });
    // Live preview while dragging in the system picker; confirming closes.
    this.pickerInput.addEventListener('input', () => this.setSaturation(this.pickerInput.value));
    this.pickerInput.addEventListener('change', () => this.closePicker());
    box.addEventListener('focusout', (e) => {
      if (box.hidden) return;
      const to = e.relatedTarget as Node | null;
      if (to && box.contains(to)) return;
      if (document.activeElement === this.pickerInput) return;
      this.closePicker();
    });
    return box;
  }

  private setSaturation(hex: string | null): void {
    if (this.pickerWhich === 'under') this.under = hex;
    else if (this.pickerWhich === 'over') this.over = hex;
    else return;
    this.markPicker();
    this.hooks.onSaturation(
      this.under ? hexToRgb(this.under) : null,
      this.over ? hexToRgb(this.over) : null,
    );
    this.render();
  }

  private markPicker(): void {
    const cur = (this.pickerWhich === 'under' ? this.under : this.over) || '';
    const ramp = this.pickerSwatches.firstElementChild as HTMLElement;
    // The "none" swatch shows what that end of the ramp actually is.
    ramp.style.background = this.pickerWhich === 'under' ? '#000000' : '#ffffff';
    for (const b of Array.from(this.pickerSwatches.querySelectorAll('button'))) {
      b.setAttribute('aria-pressed', String((b.dataset.c || '').toLowerCase() === cur.toLowerCase()));
    }
  }

  /** Place the dialog against the pointer, on whichever side fits. */
  private openPicker(which: 'under' | 'over', x: number, y: number): void {
    this.pickerWhich = which;
    this.pickerWho.textContent = which === 'under' ? 'underflow' : 'overflow';
    this.pickerInput.value = (which === 'under' ? this.under : this.over) || (which === 'under' ? '#14181C' : '#B3610A');
    this.picker.hidden = false;
    this.markPicker();
    const w = this.picker.offsetWidth;
    const h = this.picker.offsetHeight;
    let left = x - w - 10;
    if (left < 8) left = Math.min(window.innerWidth - w - 8, x + 10);
    this.picker.style.left = `${left}px`;
    this.picker.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y - h / 2))}px`;
    this.picker.focus({ preventScroll: true });
  }

  private closePicker(): void {
    this.picker.hidden = true;
    this.pickerWhich = null;
  }

  private getTrackRect(): DOMRect {
    return (this.trackRect ??= this.track.getBoundingClientRect());
  }

  private getBarRect(): DOMRect {
    return (this.barRect ??= this.barCanvas.getBoundingClientRect());
  }

  private invalidateRects = (): void => {
    this.trackRect = null;
    this.barRect = null;
  };

  // ---- data ---------------------------------------------------------------

  setVolume(vol: Volume): void {
    this.vol = vol;
    this.renderSig = '';
    this.dataLo = vol.min;
    this.dataHi = vol.max;
    this.domHold = null;
    this.domAnim = null;
    // Pinned levels belong to the volume they were read on.
    this.pins = [];
    this.hotPin = null;
    this.hoverLevel = null;
    this.emitLevels();
    const span = Math.max(vol.max - vol.min, 1e-6);

    this.counts.fill(0);
    const fine = new Uint32Array(QUANT_BINS);
    const scale = HIST_BINS / span;
    const fineScale = QUANT_BINS / span;
    for (let i = 0; i < vol.data.length; i++) {
      const x = vol.data[i] - vol.min;
      let b = (x * scale) | 0;
      if (b < 0) b = 0;
      else if (b >= HIST_BINS) b = HIST_BINS - 1;
      this.counts[b]++;
      let f = (x * fineScale) | 0;
      if (f < 0) f = 0;
      else if (f >= QUANT_BINS) f = QUANT_BINS - 1;
      fine[f]++;
    }
    // Quantiles come from the fine cumulative rather than from sorting every
    // voxel: a volume has millions of them and the bins are accurate to a few
    // hundredths of a percent of the range.
    let acc = 0;
    for (let i = 0; i < QUANT_BINS; i++) {
      this.fineCum[i] = acc;
      acc += fine[i];
    }
    this.fineCum[QUANT_BINS] = acc;

    // Scaling against the tallest bin would flatten everything, because air
    // outnumbers every tissue bin by orders of magnitude. Scaling against a
    // high percentile lets the few huge ones run off the end and keeps the
    // shape of the rest.
    const nonEmpty = Array.from(this.counts)
      .filter((c) => c > 0)
      .sort((a, b) => a - b);
    this.countRef = nonEmpty.length
      ? Math.max(1, nonEmpty[Math.min(nonEmpty.length - 1, Math.floor(nonEmpty.length * 0.92))])
      : 1;
  }

  setLimits(lo: number, hi: number): void {
    this.lo = lo;
    this.hi = hi;
  }

  setProbe(value: number | null): void {
    this.probe = value;
    this.emitLevels();
  }

  /**
   * A window gesture made elsewhere, such as Ctrl+drag over the view, is
   * starting: the bar freezes its visible scale for it, exactly as for a drag
   * of its own, so the limits move over a still scale. It can still open, to
   * keep a limit that goes past it on the bar.
   */
  holdScale(): void {
    if (!this.vol || this.domHold) return;
    this.domHold = { d0: this.dom0, d1: this.dom1 };
    this.domAnim = null;
  }

  /** The outside gesture is over: the scale eases to where the limits ended. */
  releaseScale(): void {
    if (!this.domHold || this.drag) return;
    this.domHold = null;
    this.domAnim = { d0: this.dom0, d1: this.dom1, start: performance.now() };
    this.schedule();
  }

  // ---- level lines --------------------------------------------------------

  /** The level being pointed at: over the bar the bar's, else the probe's. */
  private pointedLevel(): number | null {
    return this.hoverLevel ?? this.probe;
  }

  /** Tell the host about the level lines, only when they changed. */
  private emitLevels(): void {
    // Over a pinned line the pinned one rules, and the live one steps aside.
    const level = this.pointedLevel();
    const live = this.shiftDown && this.hotPin === null && level !== null ? level : null;
    const hot = this.hotPin ?? -1;
    const sig = `${live}|${this.pins.join(',')}|${hot}`;
    if (sig === this.levelsSig) return;
    this.levelsSig = sig;
    this.hooks.onLevels(live, [...this.pins], hot);
  }

  /** Pin a level as a line over the slice and a mark on the bar. */
  pinLevel(v: number | null): void {
    if (v === null || !this.vol || !isFinite(v)) return;
    if (this.pins.length >= MAX_PINS) return;
    const near = Math.max(this.dataHi - this.dataLo, 1e-6) * 1e-4;
    if (this.pins.some((p) => Math.abs(p - v) < near)) return;
    this.pins.push(v);
    this.pins.sort((a, b) => a - b);
    this.hotPin = null;
    this.emitLevels();
    this.schedule();
  }

  private removePin(i: number): void {
    if (i < 0 || i >= this.pins.length) return;
    this.pins.splice(i, 1);
    this.hotPin = null;
    this.emitLevels();
    this.schedule();
  }

  /** Highlight a pinned line, here and over the slice. */
  private setHot(i: number | null): void {
    if (this.hotPin === i) return;
    this.hotPin = i;
    for (const el of Array.from(this.track.querySelectorAll<HTMLElement>('.cb-pin'))) {
      el.classList.toggle('hot', Number(el.dataset.p) === i);
    }
    this.emitLevels();
    this.placeNeedle();
  }

  private setShift(on: boolean): void {
    if (this.shiftDown === on) return;
    this.shiftDown = on;
    this.emitLevels();
  }

  // ---- the elastic domain -------------------------------------------------

  /** Where the domain wants to be: the data, plus a margin past the limits. */
  private targetDomain(): [number, number] {
    const pad = Math.max(this.dataHi - this.dataLo, 1e-6) * DOM_PAD;
    let a = Math.min(this.dataLo - pad, this.lo);
    let b = Math.max(this.dataHi + pad, this.hi);
    // The cap is a fraction of the final span, so it settles by iterating.
    for (let i = 0; i < 3; i++) {
      const m = (b - a) * DOM_CAP;
      a = Math.min(a, this.lo - m);
      b = Math.max(b, this.hi + m);
    }
    return [a, b];
  }

  private syncDomain(now: number): void {
    const [t0, t1] = this.targetDomain();
    if (this.domHold) {
      // Ratchet. Comparing against the frozen value instead of remembering the
      // widest would snap the bar shut on the way back and jump the handle.
      this.domHold.d0 = Math.min(this.domHold.d0, t0);
      this.domHold.d1 = Math.max(this.domHold.d1, t1);
      this.dom0 = this.domHold.d0;
      this.dom1 = this.domHold.d1;
      return;
    }
    if (this.domAnim) {
      const s = (now - this.domAnim.start) / DOM_ANIM_MS;
      if (s >= 1) {
        this.domAnim = null;
      } else {
        // Ease-out, as in the demo: the reframe is the background, so it sets
        // off at once and settles slowly rather than lagging the gesture.
        const e = easeOut(s);
        this.dom0 = this.domAnim.d0 + (t0 - this.domAnim.d0) * e;
        this.dom1 = this.domAnim.d1 + (t1 - this.domAnim.d1) * e;
        return;
      }
    }
    this.dom0 = t0;
    this.dom1 = t1;
  }

  private get span(): number {
    return Math.max(this.dom1 - this.dom0, 1e-9);
  }

  /**
   * Fraction of the track at a client x, left being 0. Deliberately not
   * clamped: the auto-advance needs it to keep extrapolating outside the bar to
   * know which way the cursor is pushing.
   */
  private fracRawFromX(clientX: number): number {
    const r = this.getTrackRect();
    if (r.width < 1) return 0;
    return (clientX - r.left) / r.width;
  }

  private valueOfFrac(f: number): number {
    return this.dom0 + f * this.span;
  }

  private valueAtX(clientX: number): number {
    return this.valueOfFrac(clamp01(this.fracRawFromX(clientX)));
  }

  private xOfValue(v: number): number {
    return ((v - this.dom0) / this.span) * this.trackLen;
  }

  /** The transfer function: piecewise linear through the knots. */
  private warp(t: number): number {
    let px = 0;
    let py = 0;
    for (const k of this.knots) {
      if (t <= k.x) return py + ((t - px) * (k.y - py)) / Math.max(1e-9, k.x - px);
      px = k.x;
      py = k.y;
    }
    return py + ((t - px) * (1 - py)) / Math.max(1e-9, 1 - px);
  }

  private commitKnots(): void {
    this.knots.sort((a, b) => a.x - b.x);
    this.hooks.onWarp(this.knots.map((k) => ({ ...k })));
  }

  /** Add a knot where the ramp already passes, so it starts on the curve. */
  private addKnotAt(value: number): void {
    if (this.knots.length >= MAX_KNOTS) return;
    const t = (value - this.lo) / Math.max(this.hi - this.lo, 1e-9);
    const x = Math.min(1 - KNOT_MARGIN, Math.max(KNOT_MARGIN, t));
    if (this.knots.some((k) => Math.abs(k.x - x) < KNOT_MARGIN)) return;
    this.knots.push({ x, y: this.warp(x) });
    this.commitKnots();
  }

  private renderKnots(): void {
    for (const el of Array.from(this.track.querySelectorAll('.cb-knot'))) el.remove();
    const len = this.trackLen;
    this.knots.forEach((k, i) => {
      const x = this.xOfValue(this.lo + k.x * (this.hi - this.lo));
      if (x < -len * 0.02 || x > len * 1.02) return;
      const el = document.createElement('div');
      const active = this.drag?.kind === 'knot' && this.drag.knot === i;
      el.className = `cb-knot${active ? ' act' : ''}`;
      el.style.left = `${x}px`;
      el.dataset.k = String(i);
      // Up the bar the knot sits at the grey it carries; along it, at the value
      // it paints. The line joining them IS the transfer function.
      el.style.setProperty('--cb-ky', String(k.y));
      el.title = 'arrastra para deformar, doble clic derecho para borrar';
      this.track.appendChild(el);
    });
  }

  /** The transfer function drawn over the bar itself. */
  private drawCurve(g: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
    if (!this.knots.length) return;
    const pts: [number, number][] = [
      [0, this.lo],
      ...this.knots.map((k) => [k.y, this.lo + k.x * (this.hi - this.lo)] as [number, number]),
      [1, this.hi],
    ];
    g.beginPath();
    pts.forEach(([grey, value], i) => {
      const x = ((value - this.dom0) / this.span) * w;
      const y = (1 - grey) * h;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.lineWidth = 3 * dpr;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.lineWidth = 1.4 * dpr;
    g.stroke();
  }

  private fracOf(v: number): number {
    return (v - this.dom0) / this.span;
  }

  /**
   * Which row a page y lands in. Decided by geometry against the bar's own
   * rect, never by the event target, because the handles are drawn on top of
   * the bar and have to count as bar.
   */
  private zoneAt(y: number): 'hist' | 'bar' | 'ticks' {
    const rb = this.getBarRect();
    if (y < rb.top - 1) return 'hist';
    if (y > rb.bottom + 1) return 'ticks';
    return 'bar';
  }

  /**
   * The pan zone is the middle third of the span between the limits, inside
   * the ticks row: it leaves room beside each limit to read and edit it.
   */
  private inPanZone(x: number, y: number): boolean {
    if (this.zoneAt(y) !== 'ticks') return false;
    const r = this.getTrackRect();
    const a = r.left + clamp01(this.fracOf(this.lo)) * r.width;
    const b = r.left + clamp01(this.fracOf(this.hi)) * r.width;
    const third = (b - a) / 3;
    return x >= a + third && x <= b - third;
  }

  /**
   * A limit pins its end of the domain once it is past the data: it is what
   * sets the size of the bar, and its handle stays on the edge however far the
   * figure goes.
   */
  private isPinned(which: Limit): boolean {
    const pad = Math.max(this.dataHi - this.dataLo, 1e-6) * DOM_PAD;
    return which === 'hi' ? this.hi > this.dataHi + pad : this.lo < this.dataLo - pad;
  }

  /**
   * The handle a pointer event is on: by its target, or failing that by
   * distance, since the 16 px grab area is easy to leave between the two
   * clicks of a double click.
   */
  private handleAt(e: MouseEvent): Limit | null {
    const h = (e.target as HTMLElement).closest('.cb-hnd') as HTMLElement | null;
    if (h) return h.dataset.w as Limit;
    if (this.zoneAt(e.clientY) !== 'bar') return null;
    const x = e.clientX - this.getTrackRect().left;
    const xHi = Math.min(this.trackLen, Math.max(0, this.xOfValue(this.hi)));
    const xLo = Math.min(this.trackLen, Math.max(0, this.xOfValue(this.lo)));
    const dHi = Math.abs(x - xHi);
    const dLo = Math.abs(x - xLo);
    if (Math.min(dHi, dLo) > HANDLE_HIT) return null;
    return dHi <= dLo ? 'hi' : 'lo';
  }

  private minWindow(): number {
    return Math.max(this.dataHi - this.dataLo, 1e-6) * MIN_SPAN;
  }

  private commit(lo: number, hi: number): void {
    // A guard against the exponential auto-advance running away to infinity.
    const reach = Math.max(this.dataHi - this.dataLo, 1e-6) * 1e4;
    const mid = (this.dataLo + this.dataHi) / 2;
    const cap = (v: number) => Math.min(mid + reach, Math.max(mid - reach, v));
    const a = cap(lo);
    // Only `hi` is touched, and only when the window is too narrow. Rebuilding
    // it as lo + (hi - lo) does not give back exactly hi in floating point, and
    // then "to the data maximum" lands a hair past it and the label says out.
    let b = cap(hi);
    if (b - a < this.minWindow()) b = a + this.minWindow();
    this.limAnim = null;
    this.lo = a;
    this.hi = b;
    this.hooks.onLimits(a, b);
  }

  /**
   * An animated move of the limits, for anything that is not a drag: a typed
   * value, a double click on a handle. Ease-in-out, because the cubic ease-out
   * puts most of the travel in the first quarter and reads as a jolt.
   */
  private animLimits(lo: number, hi: number): void {
    if (hi - lo < this.minWindow()) hi = lo + this.minWindow();
    const scale = this.span;
    if (Math.abs(lo - this.lo) < scale * 1e-9 && Math.abs(hi - this.hi) < scale * 1e-9) {
      this.commit(lo, hi);
      return;
    }
    this.limAnim = { lo0: this.lo, hi0: this.hi, lo1: lo, hi1: hi, start: performance.now() };
    this.schedule();
  }

  /** Advance the limit animation; true while it is still running. */
  private stepLimAnim(now: number): boolean {
    const a = this.limAnim;
    if (!a) return false;
    const k = Math.min(1, (now - a.start) / LIM_ANIM_MS);
    if (k >= 1) {
      // The endpoint is stamped exactly, or a 1e-15 overshoot reads as "out".
      this.limAnim = null;
      this.lo = a.lo1;
      this.hi = a.hi1;
      this.hooks.onLimits(this.lo, this.hi);
      return false;
    }
    const e = easeInOut(k);
    this.lo = a.lo0 + (a.lo1 - a.lo0) * e;
    this.hi = a.hi0 + (a.hi1 - a.hi0) * e;
    this.hooks.onLimits(this.lo, this.hi);
    return true;
  }

  // ---- auto-advance -------------------------------------------------------

  /** One step of the auto-advance; true while it is still running. */
  private stepAuto(now: number): boolean {
    const d = this.drag;
    if (!d || d.kind === 'pan') {
      this.autoT = 0;
      return false;
    }
    const r = this.getTrackRect();
    const over = d.lastX < r.left ? r.left - d.lastX : d.lastX > r.right ? d.lastX - r.right : 0;
    if (over <= 0) {
      this.autoT = 0;
      return false;
    }
    const dt = this.autoT ? Math.min(0.05, (now - this.autoT) / 1000) : 0;
    this.autoT = now;
    if (dt > 0) {
      const u = over / Math.max(1, r.width);
      const alpha = Math.pow(2, Math.min(AUTO_CAP, u / AUTO_U2));
      const moving = d.kind === 'hi' ? this.hi : this.lo;
      const fixed = d.kind === 'hi' ? this.lo : this.hi;
      // Which way leaving by that edge pushes the VALUE is asked of the scale,
      // with two points, rather than assumed to be "right is more".
      const outward = Math.sign(this.valueOfFrac(this.fracRawFromX(d.lastX)) - this.valueOfFrac(0.5));
      const away = outward === Math.sign(moving - fixed);
      const k = Math.pow(alpha, away ? dt : -dt);
      const v = fixed + (moving - fixed) * k;
      if (d.kind === 'hi') this.commit(this.lo, v);
      else this.commit(v, this.hi);
      // Re-anchor, so coming back inside answers 1:1 straight away.
      d.x0 = d.lastX;
      d.lo0 = this.lo;
      d.hi0 = this.hi;
    }
    return true;
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    const auto = this.stepAuto(now);
    const lim = this.stepLimAnim(now);
    const hist = this.stepHistAnim(now);
    const more = auto || lim || hist || this.domAnim !== null;
    this.render(now);
    if (more) this.schedule();
  };

  // ---- interaction --------------------------------------------------------

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.autoT = 0;
    this.track.classList.remove('panning', 'dragging');
    this.handles.lo.classList.remove('act');
    this.handles.hi.classList.remove('act');
    // Let the body ease back to its natural size instead of snapping.
    this.domHold = null;
    this.domAnim = { d0: this.dom0, d1: this.dom1, start: performance.now() };
    this.schedule();
  }

  private setCtrl(on: boolean): void {
    if (this.ctrlDown === on) return;
    this.ctrlDown = on;
    this.renderGuides();
  }

  /**
   * While Ctrl is held, one tick per magnet stop. The figures are placed
   * without overlapping: first 0, 50 and 100, then the rest if they leave at
   * least 30 px clear; a stop that does not fit keeps its tick without a
   * number.
   */
  private renderGuides(): void {
    const len = this.trackLen;
    // The stops depend only on the data, the domain and the track length, and
    // during a drag the domain is frozen by the ratchet, so the signature does
    // not change and the DOM is left alone.
    const sig = this.ctrlDown ? `${this.dom0.toFixed(6)}|${this.dom1.toFixed(6)}|${len}` : 'off';
    if (sig === this.guideSig) return;
    this.guideSig = sig;
    for (const el of Array.from(this.track.querySelectorAll('.cb-gtick'))) el.remove();
    if (!this.ctrlDown || !this.vol) return;

    const stops = this.pctStops().map((s) => ({ ...s, x: Math.min(len, Math.max(0, this.xOfValue(s.v))) }));
    const placed: number[] = [];
    const fits = (x: number) => placed.every((g) => Math.abs(g - x) >= GUIDE_CLEARANCE);
    const numbered = new Set<number>();
    for (const p of [100, 50, 0]) {
      const s = stops.find((x) => x.p === p);
      if (s && fits(s.x)) {
        placed.push(s.x);
        numbered.add(p);
      }
    }
    for (const s of stops) {
      if (numbered.has(s.p)) continue;
      if (fits(s.x)) {
        placed.push(s.x);
        numbered.add(s.p);
      }
    }
    for (const s of stops) {
      const el = document.createElement('div');
      el.className = 'cb-gtick';
      el.style.left = `${s.x}px`;
      el.textContent = numbered.has(s.p) ? this.fmtPct(s.p) : '';
      this.track.appendChild(el);
    }
  }

  /**
   * Fold or unfold the histogram. The row height is animated here, frame by
   * frame with an ease-out, and the histogram is redrawn at each height, as in
   * the demo: a CSS transition would slide the rows while the canvas sat drawn
   * at its final size, which is what made it look wrong.
   */
  private setHistOpen(open: boolean, animate = true): void {
    this.histOpen = open;
    const to = open ? HIST_H : 0;
    if (animate) {
      // From wherever it is now, so a click mid-animation turns it round.
      this.histAnim = { from: this.histH, to, start: performance.now() };
      this.schedule();
    } else {
      this.histAnim = null;
      this.applyHistH(to);
    }
    // Open, the arrow points down, where the histogram would fold to; folded,
    // up, where it would open.
    this.histBtn.textContent = open ? '\u02c5' : '\u02c4';
    this.histBtn.title = open ? 'recoge el histograma' : 'despliega el histograma';
    this.histBtn.setAttribute('aria-expanded', String(open));
  }

  private applyHistH(h: number): void {
    this.histH = Math.round(Math.max(0, Math.min(HIST_H, h)));
    this.root.style.setProperty('--cb-hist', `${this.histH}px`);
    this.root.classList.toggle('nopct', this.histH < PCT_MIN);
    this.invalidateRects();
  }

  /** Advance the fold animation; true while it is still running. */
  private stepHistAnim(now: number): boolean {
    const a = this.histAnim;
    if (!a) return false;
    const k = Math.min(1, (now - a.start) / HIST_ANIM_MS);
    this.applyHistH(a.from + (a.to - a.from) * easeOut(k));
    if (k >= 1) {
      this.histAnim = null;
      return false;
    }
    return true;
  }

  private attach(): void {
    // The guides follow the key itself, so they appear before the drag starts.
    // Shift likewise: the live level line comes and goes with the key,
    // without having to move the mouse.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control') this.setCtrl(true);
      else if (e.key === 'Shift') this.setShift(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control') this.setCtrl(false);
      else if (e.key === 'Shift') this.setShift(false);
    });
    window.addEventListener('blur', () => {
      this.setCtrl(false);
      this.setShift(false);
    });

    // The cached rects go stale when anything moves the bar: the window, a
    // scroll, or the columns sliding as the histogram folds.
    window.addEventListener('resize', this.invalidateRects);
    window.addEventListener('scroll', this.invalidateRects, true);
    this.track.addEventListener('transitionend', this.invalidateRects);
    // A box left with text that did not change the limits keeps that text,
    // because the signature has not moved; redraw on leaving it.
    for (const input of Object.values(this.limitEls)) {
      input.addEventListener('blur', () => {
        this.renderSig = '';
        this.schedule();
      });
    }

    this.histBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setHistOpen(!this.histOpen);
    });

    this.track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.vol) return;
      const target = e.target as HTMLElement;
      // The boxes are text and the button serves itself.
      if (target.closest('.cb-lim') || target.closest('.cb-histbtn')) return;
      const handle = target.closest('.cb-hnd') as HTMLElement | null;
      const knotEl = !handle ? (target.closest('.cb-knot') as HTMLElement | null) : null;
      // Shift+click on the bar pins the level there. Not on a handle or a
      // knot, where the press is the start of a drag.
      if (e.shiftKey && !handle && !knotEl && this.zoneAt(e.clientY) === 'bar') {
        e.preventDefault();
        this.pinLevel(this.valueAtX(e.clientX));
        return;
      }
      const pan = !handle && !knotEl && this.inPanZone(e.clientX, e.clientY);
      // Neither the body of the bar nor the histogram drags anything: the
      // histogram is read-only and panning has its own zone in the ticks.
      if (!handle && !knotEl && !pan) return;
      e.preventDefault();
      // A handle captures the pointer itself, as in the demo. Captured on the
      // track, the click and the double click that follow would be aimed at
      // the track, and a double click on a handle would read as one on the
      // bar's body and drop a warp knot instead of sending the limit home.
      try {
        (handle ?? this.track).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.hoverLevel = null;
      const kind: Limit | 'pan' | 'knot' = handle
        ? (handle.dataset.w as Limit)
        : knotEl
          ? 'knot'
          : 'pan';
      const ki = knotEl ? Number(knotEl.dataset.k) : undefined;
      this.drag = {
        pointerId: e.pointerId,
        kind,
        knot: ki,
        knotX0: ki !== undefined ? this.knots[ki]?.x : undefined,
        x0: e.clientX,
        lo0: this.lo,
        hi0: this.hi,
        lastX: e.clientX,
        alt: e.altKey,
        moved: false,
        orig: { lo: this.lo, hi: this.hi },
      };
      // Freeze the bar's body for the gesture: if it shrank under the cursor
      // the scale, ticks and histogram would move mid-drag.
      this.domHold = { d0: this.dom0, d1: this.dom1 };
      this.domAnim = null;
      if (kind !== 'knot') this.track.classList.add(kind === 'pan' ? 'panning' : 'dragging');
      if (handle) handle.classList.add('act');
      this.render();
    });

    this.track.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) {
        if (!this.vol) return;
        this.setCtrl(e.ctrlKey);
        // Only the middle third of the ticks promises a grab. The cursor goes
        // on the track: the ticks row itself lets the pointer through.
        const pan = this.inPanZone(e.clientX, e.clientY);
        const cur = pan ? 'grab' : '';
        if (this.track.style.cursor !== cur) this.track.style.cursor = cur;
        // Over the bar the pointer reads a level, as over the slice; with
        // Shift that level is drawn as a line over the slice.
        const onBar =
          this.zoneAt(e.clientY) === 'bar' && !(e.target as HTMLElement).closest('.cb-histbtn');
        this.hoverLevel = onBar ? this.valueAtX(e.clientX) : null;
        this.shiftDown = e.shiftKey;
        this.emitLevels();
        this.placeNeedle();
        return;
      }
      if (d.pointerId !== e.pointerId || !this.vol) return;
      // A loose click must not move anything; the grab offset is then absorbed
      // in that first step instead of surviving the whole gesture.
      if (!d.moved) {
        if (Math.abs(e.clientX - d.x0) < DRAG_SLOP) return;
        d.moved = true;
        d.x0 = e.clientX;
        d.lo0 = this.lo;
        d.hi0 = this.hi;
      }

      // Dead zone. With the limit pinned on an edge and the cursor beyond it,
      // heading back towards the bar does not drag: it only closes the gap,
      // and the handle catches again once the cursor passes its level. Without
      // it every step out there put the limit on the edge of the domain, which
      // the ratchet then opened a little further, so the way back pushed out.
      if (d.kind === 'lo' || d.kind === 'hi') {
        const r = this.getTrackRect();
        const before = e.clientX < r.left;
        if (before || e.clientX > r.right) {
          const towardBar = before ? e.clientX > d.lastX : e.clientX < d.lastX;
          if (towardBar && this.isPinned(d.kind)) {
            d.lastX = e.clientX;
            // Re-anchor, so the Alt path also picks up from here.
            d.x0 = e.clientX;
            d.lo0 = this.lo;
            d.hi0 = this.hi;
            this.schedule();
            return;
          }
        }
      }

      d.lastX = e.clientX;
      d.alt = e.altKey;
      const fine = e.altKey ? FINE_GAIN : 1;

      if (d.kind === 'knot') {
        const k = this.knots[d.knot ?? -1];
        if (!k || d.knotX0 === undefined) return;
        const span = Math.max(this.hi - this.lo, 1e-9);
        const perPx = this.span / Math.max(1, this.trackLen);
        // Dragging moves the knot along the VALUE axis; the grey it carries
        // stays put, which is what deforms the ramp.
        const x = d.knotX0 + ((e.clientX - d.x0) * perPx * fine) / span;
        const i = d.knot as number;
        const lo = i > 0 ? this.knots[i - 1].x + KNOT_GAP : KNOT_GAP;
        const hi = i < this.knots.length - 1 ? this.knots[i + 1].x - KNOT_GAP : 1 - KNOT_GAP;
        k.x = Math.min(hi, Math.max(lo, x));
        this.hooks.onWarp(this.knots.map((n) => ({ ...n })));
        this.render();
        return;
      }

      if (d.kind === 'pan') {
        const dv = (this.valueAtX(e.clientX) - this.valueAtX(d.x0)) * fine;
        const width = d.hi0 - d.lo0;
        this.commit(d.lo0 + dv, d.lo0 + dv + width);
      } else {
        // Absolute: the limit goes where the cursor is. Alt makes it relative
        // and slow, the only way to place a limit inside a narrow peak.
        const v =
          fine === 1
            ? this.valueAtX(e.clientX)
            : (d.kind === 'hi' ? d.hi0 : d.lo0) +
              (this.valueAtX(e.clientX) - this.valueAtX(d.x0)) * fine;
        const snapped = this.applySnap(v, e.ctrlKey).v;
        if (d.kind === 'hi') this.commit(this.lo, snapped);
        else this.commit(snapped, this.hi);
      }
      this.setCtrl(e.ctrlKey);
      this.render();
      // Past the end of the bar the limit keeps going on its own.
      if (d.kind !== 'pan' && (e.clientX < this.getTrackRect().left ||
        e.clientX > this.getTrackRect().right)) {
        this.schedule();
      }
    });

    const end = (e: PointerEvent) => {
      if (!this.drag || this.drag.pointerId !== e.pointerId) return;
      // Whoever holds the capture, the track or a handle.
      const holder = e.target as Element;
      try {
        if (holder.hasPointerCapture(e.pointerId)) holder.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.endDrag();
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.track.addEventListener('pointerleave', () => {
      if (this.drag || this.hoverLevel === null) return;
      this.hoverLevel = null;
      this.emitLevels();
      this.placeNeedle();
    });
    // The net for Alt-Tab mid-gesture: without it the drag stays alive and the
    // auto-advance keeps running with the button already released.
    window.addEventListener('blur', () => this.endDrag());

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.drag) {
        const d = this.drag;
        if (d.kind === 'knot' && d.knot !== undefined && d.knotX0 !== undefined) {
          const k = this.knots[d.knot];
          if (k) k.x = d.knotX0;
          this.endDrag();
          this.commitKnots();
        } else {
          const { lo, hi } = d.orig;
          this.endDrag();
          this.commit(lo, hi);
        }
        this.render();
      }
      if (!this.picker.hidden) this.closePicker();
    });

    // Clicking away closes the dialog, but not onto a handle: right-clicking
    // the other one should reopen it rather than just dismiss this.
    window.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as HTMLElement;
        if (!this.picker.hidden && !this.picker.contains(t) && !t.closest('.cb-hnd')) {
          this.closePicker();
        }
      },
      true,
    );
    window.addEventListener('scroll', () => this.closePicker(), true);

    this.track.addEventListener(
      'wheel',
      (e) => {
        if (!this.vol) return;
        const target = e.target as HTMLElement;
        // Only over the body of the bar, and over what is drawn on it. Over
        // the ticks and the histogram the wheel scrolls the page as usual.
        if (
          target !== this.barCanvas &&
          !target.closest('.cb-hnd') &&
          !target.closest('.cb-knot') &&
          !target.closest('.cb-pin')
        ) return;
        e.preventDefault();
        e.stopPropagation();
        // Zoom about the value under the cursor, not about the window centre.
        const anchor = this.valueAtX(e.clientX);
        const span = this.hi - this.lo;
        const wMax = Math.max(this.dataHi - this.dataLo, 1e-6) * 10;
        let k = Math.exp((e.deltaY > 0 ? 1 : -1) * (e.altKey ? 0.04 : 0.12));
        // The bound only bites in the direction the gesture is going.
        if (k > 1) k = Math.min(k, Math.max(1, wMax / span));
        else k = Math.max(k, Math.min(1, this.minWindow() / span));
        if (k === 1) return;
        this.commit(anchor + (this.lo - anchor) * k, anchor + (this.hi - anchor) * k);
        this.render();
      },
      { passive: false },
    );

    this.track.addEventListener('contextmenu', (e) => {
      if (!this.vol) return;
      const target = e.target as HTMLElement;
      // Over a box or the button, the browser's own menu.
      if (target.closest('.cb-lim') || target.closest('.cb-histbtn')) return;
      // On a handle: the saturation colour of ITS side. The handle covers half
      // the tail, so without this a right click next to a limit would land on
      // it and open nothing.
      const handle = target.closest('.cb-hnd') as HTMLElement | null;
      if (handle) {
        e.preventDefault();
        this.openPicker(handle.dataset.w === 'hi' ? 'over' : 'under', e.clientX, e.clientY);
        return;
      }
      const knotEl = target.closest('.cb-knot') as HTMLElement | null;
      if (knotEl) {
        e.preventDefault();
        // Two right clicks, so a stray one never destroys work.
        const i = Number(knotEl.dataset.k);
        const now = performance.now();
        if (this.rclick.i === i && now - this.rclick.t < RCLICK_MS) {
          this.rclick = { i: -1, t: -1e9 };
          this.knots.splice(i, 1);
          this.commitKnots();
          this.render();
        } else {
          this.rclick = { i, t: now };
        }
        return;
      }
      // And on the saturated tail itself, which is where the colour shows.
      const v = this.valueAtX(e.clientX);
      if (v > this.hi) {
        e.preventDefault();
        this.openPicker('over', e.clientX, e.clientY);
      } else if (v < this.lo) {
        e.preventDefault();
        this.openPicker('under', e.clientX, e.clientY);
      }
    });

    this.track.addEventListener('dblclick', (e) => {
      const vol = this.vol;
      if (!vol) return;
      const target = e.target as HTMLElement;
      // In the box, a double click selects text.
      if (target.closest('.cb-lim') || target.closest('.cb-histbtn')) return;
      e.stopPropagation();
      // Two Shift+clicks in a row are two tries at pinning a level, not a
      // request for anything else.
      if (e.shiftKey) return;
      this.domHold = null;
      this.domAnim = { d0: this.dom0, d1: this.dom1, start: performance.now() };
      const which = this.handleAt(e);
      if (which) {
        // Each handle goes to its own end of the data, exactly: the data
        // maximum is p100 and the data minimum p0.
        if (which === 'hi') this.animLimits(this.lo, this.dataHi);
        else this.animLimits(this.dataLo, this.hi);
      } else if (target.closest('.cb-knot')) {
        // Nothing: a knot is removed with two right clicks, not here.
      } else if (this.zoneAt(e.clientY) === 'bar') {
        if (e.ctrlKey) {
          this.knots = [];
          this.commitKnots();
        } else {
          this.addKnotAt(this.valueAtX(e.clientX));
        }
      }
      this.schedule();
    });
  }

  // ---- drawing ------------------------------------------------------------

  /** The demo's formatter: as many decimals as the magnitude earns, no more. */
  private fmt(v: number): string {
    const a = Math.abs(v);
    if (!isFinite(v)) return '\u2014';
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a === 0) return '0';
    if (a < 0.01) return String(+v.toPrecision(2));
    return v.toFixed(a < 0.1 ? 3 : 2);
  }

  /**
   * One decimal only where it earns its place: at the ends it is needed so
   * 99.8 is not read as 100, but "100.0 %" and "2.0 %" are noise.
   */
  private fmtPct(p: number): string {
    let s = p < 10 || p > 99.5 ? p.toFixed(1) : p.toFixed(0);
    if (s.endsWith('.0')) s = s.slice(0, -2);
    return `${s} %`;
  }

  /**
   * The percentile of the data a limit leaves below it. Outside the range of
   * the data there is no percentile to give, so it says which way it went out.
   */
  private pctLabel(v: number): string {
    const eps = (this.dataHi - this.dataLo) * 1e-9;
    if (v < this.dataLo - eps) return '\u25c0 out';
    if (v > this.dataHi + eps) return 'out \u25b6';
    return this.fmtPct(this.fractionBelow(v) * 100);
  }

  /** Fraction of voxels below a value, from the fine cumulative. */
  private fractionBelow(v: number): number {
    const total = this.fineCum[QUANT_BINS];
    if (total <= 0) return 0;
    const x = ((v - this.dataLo) / Math.max(this.dataHi - this.dataLo, 1e-9)) * QUANT_BINS;
    if (x <= 0) return 0;
    if (x >= QUANT_BINS) return 1;
    const i = Math.floor(x);
    const c0 = this.fineCum[i];
    return (c0 + (this.fineCum[i + 1] - c0) * (x - i)) / total;
  }

  /** The value below which a fraction `p` of the data lies. */
  private quantile(p: number): number {
    const total = this.fineCum[QUANT_BINS];
    if (total <= 0) return this.dataLo;
    const target = Math.min(1, Math.max(0, p)) * total;
    let a = 0;
    let b = QUANT_BINS - 1;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.fineCum[m + 1] < target) a = m + 1;
      else b = m;
    }
    const c0 = this.fineCum[a];
    const c1 = this.fineCum[a + 1];
    const f = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    return this.dataLo + ((a + f) / QUANT_BINS) * Math.max(this.dataHi - this.dataLo, 1e-9);
  }

  private pctStops(): { p: number; v: number }[] {
    return PCTS.map((p) => ({ p, v: this.quantile(p / 100) }));
  }

  /** Nearest percentile stop; the magnet only bites while Ctrl is held. */
  private applySnap(v: number, on: boolean): { v: number; name: string | null } {
    if (!on) return { v, name: null };
    let best: { p: number; v: number } | null = null;
    let bestD = Infinity;
    for (const c of this.pctStops()) {
      const d = Math.abs(c.v - v);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best ? { v: best.v, name: `p${best.p}` } : { v, name: null };
  }

  render(now = performance.now()): void {
    if (!this.vol) return;
    this.syncDomain(now);
    const len = this.track.clientWidth;
    if (len < 8) return;
    this.trackLen = len;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Everything but the needle depends only on this. The knot being dragged
    // is in it because it is drawn highlighted.
    const sig = [
      this.lo, this.hi, this.dom0, this.dom1, len, dpr, this.histH, this.under, this.over,
      this.knots.map((k) => `${k.x},${k.y}`).join(';'),
      this.drag?.kind === 'knot' ? this.drag.knot : -1,
    ].join('|');
    if (sig !== this.renderSig) {
      this.renderSig = sig;
      this.drawBar(len, dpr);
      this.drawHist(len, dpr);
      this.drawTicks();
      this.placeMarkers();
      this.renderKnots();
    }
    this.renderPins();
    this.placeNeedle();
    this.renderGuides();
  }

  /** Size a canvas's buffer, only when it changed: assigning clears and reallocates it. */
  private fitCanvas(c: HTMLCanvasElement, w: number, h: number): void {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  private drawBar(len: number, dpr: number): void {
    const c = this.barCanvas;
    this.fitCanvas(c, Math.max(1, Math.round(len * dpr)), Math.max(1, Math.round(BAR_H * dpr)));
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width;
    const rows = c.height;
    if (!this.barImg || this.barImg.width !== W || this.barImg.height !== rows) {
      this.barImg = g.createImageData(W, rows);
      this.barPx = new Uint32Array(this.barImg.data.buffer);
    }
    const px = this.barPx as Uint32Array;
    // ABGR on a little-endian buffer: one write per pixel instead of four.
    const pack = (r: number, gr: number, b: number) =>
      ((255 << 24) | (Math.round(b) << 16) | (Math.round(gr) << 8) | Math.round(r)) >>> 0;
    const win = Math.max(this.hi - this.lo, 1e-9);
    const un = this.under ? hexToRgb(this.under) : null;
    const ov = this.over ? hexToRgb(this.over) : null;
    const unPx = un ? pack(un[0] * 255, un[1] * 255, un[2] * 255) : 0;
    const ovPx = ov ? pack(ov[0] * 255, ov[1] * 255, ov[2] * 255) : 0;
    // One row worked out column by column, left being the bottom of the
    // domain, then copied down the bar's height.
    for (let x = 0; x < W; x++) {
      const v = this.dom0 + (x / (W - 1 || 1)) * this.span;
      let p: number;
      if (v < this.lo && un) p = unPx;
      else if (v > this.hi && ov) p = ovPx;
      else {
        const grey = this.warp(clamp01((v - this.lo) / win)) * 255;
        p = pack(grey, grey, grey);
      }
      px[x] = p;
    }
    const row = px.subarray(0, W);
    for (let y = 1; y < rows; y++) px.set(row, y * W);
    g.putImageData(this.barImg, 0, 0);
    this.drawCurve(g, W, rows, dpr);
  }

  private drawHist(len: number, dpr: number): void {
    const c = this.histCanvas;
    // At the row's current height, so it grows and shrinks with the fold.
    this.fitCanvas(c, Math.max(1, Math.round(len * dpr)), Math.max(1, Math.round(this.histH * dpr)));
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    // Folded, or nearly: there is nowhere to draw it.
    if (this.histH < 12) return;
    // The bars stand on the colour bar, with no gap.
    const pad = Math.max(1, Math.round(dpr));
    const usable = c.height - pad - 2;
    const dataSpan = Math.max(this.dataHi - this.dataLo, 1e-9);
    for (let i = 0; i < HIST_BINS; i++) {
      if (this.counts[i] === 0) continue;
      const len = Math.sqrt(Math.min(1, this.counts[i] / this.countRef)) * usable;
      // The histogram is in data units, so it slides and scales with the domain.
      const v0 = this.dataLo + (i / HIST_BINS) * dataSpan;
      const v1 = this.dataLo + ((i + 1) / HIST_BINS) * dataSpan;
      const x0 = ((v0 - this.dom0) / this.span) * c.width;
      const x1 = ((v1 - this.dom0) / this.span) * c.width;
      if (x1 < 0 || x0 > c.width) continue;
      // What the window takes in is drawn in ink; what it clips recedes into
      // the frame colour. That is what makes the histogram show the window.
      const inside = (v0 + v1) / 2 >= this.lo && (v0 + v1) / 2 <= this.hi;
      g.fillStyle = inside ? INK_2 : LINE;
      g.globalAlpha = inside ? 0.85 : 0.9;
      const left = Math.max(0, x0);
      g.fillRect(left, c.height - pad - len, Math.max(1, Math.min(c.width, x1) - left), len);
    }
    g.globalAlpha = 1;
  }

  /**
   * The axis lives inside the window: past the limits there are no ticks, and
   * the first and last of the scale are the limit boxes themselves. A tick that
   * would land on top of one of them is dropped.
   */
  private drawTicks(): void {
    this.ticksEl.textContent = '';
    const len = this.trackLen;
    const xLo = this.xOfValue(this.lo);
    const xHi = this.xOfValue(this.hi);
    for (const v of niceTicks(this.lo, this.hi, 5)) {
      if (v <= this.lo || v >= this.hi) continue;
      const x = this.xOfValue(v);
      if (x < -1 || x > len + 1) continue;
      if (Math.abs(x - xLo) < TICK_CLEARANCE || Math.abs(x - xHi) < TICK_CLEARANCE) continue;
      const t = document.createElement('div');
      t.className = 'cb-tick';
      t.style.left = `${x}px`;
      const mark = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = this.fmt(v);
      t.append(mark, label);
      this.ticksEl.appendChild(t);
    }
  }

  private placeMarkers(): void {
    const len = this.trackLen;
    // Clamp: while the domain animates a limit can fall briefly outside it. The
    // handle waits at the edge and slides in, rather than leaving the bar.
    const clampX = (x: number) => Math.min(len, Math.max(0, x));

    for (const which of ['lo', 'hi'] as Limit[]) {
      const v = which === 'lo' ? this.lo : this.hi;
      const x = clampX(this.xOfValue(v));
      this.handles[which].style.left = `${x}px`;
      (this.limitEls[which].parentElement as HTMLElement).style.left = `${x}px`;
      // Never overwrite a box that is being typed into: a background render
      // from an animation would wipe out what has been entered so far.
      if (document.activeElement !== this.limitEls[which]) {
        this.limitEls[which].value = this.fmt(v);
      }
      const pct = this.pctEls[which];
      pct.style.left = `${x}px`;
      pct.textContent = this.pctLabel(v);
      // The data marks follow the domain, not the limits.
      const dv = which === 'lo' ? this.dataLo : this.dataHi;
      this.dataMarks[which].style.left = `${clampX(this.xOfValue(dv))}px`;
    }
  }

  /**
   * The probe needle, the one thing that changes on almost every frame. It is
   * placed apart from the rest so a pointer move over the slice costs a style
   * write here and nothing else.
   */
  private placeNeedle(): void {
    // The level being pointed at: on the bar, the bar's; else the probe's. Over
    // a pinned line it steps aside, since that mark carries its own value.
    const level = this.pointedLevel();
    if (level === null || this.hotPin !== null) {
      if (this.needle.style.display !== 'none') this.needle.style.display = 'none';
      return;
    }
    const len = this.trackLen;
    const f = (level - this.dom0) / this.span;
    const left = `${Math.min(len, Math.max(0, this.xOfValue(level)))}px`;
    const label =
      f > 1.001 ? `${this.fmt(level)} \u25b6` : f < -0.001 ? `\u25c0 ${this.fmt(level)}` : this.fmt(level);
    if (this.needle.style.display !== 'block') this.needle.style.display = 'block';
    if (this.needle.style.left !== left) this.needle.style.left = left;
    if (this.needleLabel.textContent !== label) this.needleLabel.textContent = label;
  }

  /**
   * A mark on the top half of the bar for each pinned level, with its value.
   * Rebuilt only when the levels or the domain move; the highlight is toggled
   * in place by setHot().
   */
  private renderPins(): void {
    const len = this.trackLen;
    const sig = `${this.pins.join(',')}|${this.dom0}|${this.dom1}|${len}`;
    if (sig === this.pinsSig) return;
    this.pinsSig = sig;
    for (const el of Array.from(this.track.querySelectorAll('.cb-pin'))) el.remove();
    this.pins.forEach((v, i) => {
      const x = this.xOfValue(v);
      if (x < -len * 0.02 || x > len * 1.02) return;
      const el = document.createElement('div');
      el.className = `cb-pin${i === this.hotPin ? ' hot' : ''}`;
      el.dataset.p = String(i);
      el.style.left = `${Math.min(len, Math.max(0, x))}px`;
      const label = document.createElement('span');
      label.textContent = this.fmt(v);
      el.appendChild(label);
      el.title = 'linea de nivel fijada, clic derecho para borrarla';
      el.addEventListener('pointerenter', () => this.setHot(i));
      el.addEventListener('pointerleave', () => this.setHot(null));
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.removePin(i);
      });
      this.track.appendChild(el);
    });
  }
}
