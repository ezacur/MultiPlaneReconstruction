/**
 * What the view shows and how: the choices of the panel's display section.
 * They change only the drawing, never the data or the gestures.
 */

/** How the body is drawn: its outline, a translucent shell, both, or not at all. */
export type BodyStyle = 'outline' | 'shell' | 'both' | 'none';
/** When the volume's box is drawn: while reading the slice, always, or never. */
export type BoxMode = 'hover' | 'always' | 'never';

export interface ViewOptions {
  bodyStyle: BodyStyle;
  /** The stretches of the outline hidden behind the body or the slice, faint. */
  hiddenLines: boolean;
  /** The outline's width, in pixels. */
  outlineWidth: number;
  /** The red line where the body crosses the slice. */
  contour: boolean;
  box: BoxMode;
  /** The R/A/S marker in the corner. */
  triad: boolean;
  /** The body's manipulators fade when not in use. */
  fadeHandles: boolean;
}

export const DEFAULT_VIEW: ViewOptions = {
  bodyStyle: 'outline',
  hiddenLines: true,
  outlineWidth: 2,
  contour: true,
  box: 'hover',
  triad: true,
  fadeHandles: true,
};

const KEY = 'mpr.view';

/** The options this viewer left last time, over the defaults. The browser's
 *  storage can be missing or refuse, and then the defaults stand. */
export function loadViewOptions(): ViewOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<ViewOptions>) };
  } catch {
    /* no storage */
  }
  return { ...DEFAULT_VIEW };
}

export function saveViewOptions(o: ViewOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* no storage */
  }
}
