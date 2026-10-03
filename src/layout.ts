export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The padding box of an element, in CSS pixels relative to the viewport.
 * Borders are excluded so that hit-testing and the GL viewport agree.
 */
export function contentBox(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return {
    left: r.left + el.clientLeft,
    top: r.top + el.clientTop,
    width: el.clientWidth,
    height: el.clientHeight,
  };
}
