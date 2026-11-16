import type { PageSize, PrintOptions } from './types.ts';

/** A4 in PDF points. */
export const A4: Readonly<PageSize> = Object.freeze({ w: 595.28, h: 841.89 });

export interface Cell {
  /** Index into the selected-pages array passed to layoutSheets. */
  page: number;
  /** Bottom-left origin, PDF points, box the rotated page occupies on the sheet side. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise rotation applied to the page's displayed orientation. */
  rotate: 0 | 90 | 180 | 270;
}

export interface SheetSide {
  landscape: boolean;
  width: number;
  height: number;
  cells: Cell[];
}

const GRIDS: Record<number, [long: number, short: number]> = {
  1: [1, 1],
  2: [2, 1],
  4: [2, 2],
  6: [3, 2],
  9: [3, 3],
};

const isLandscape = (s: PageSize) => s.w > s.h;

/**
 * Computes how selected pages land on A4 sheet sides. Pure and shared by the browser
 * preview and the server renderer so the preview matches the printed output.
 *
 * @param pages displayed sizes (after any intrinsic /Rotate) of the selected pages, in order
 * @param margin inner padding per cell in points; images use a margin, PDFs at 1-up do not
 */
export function layoutSheets(pages: readonly PageSize[], opts: PrintOptions, margin = 0): SheetSide[] {
  const n = opts.pagesPerSheet;
  const [long, short] = GRIDS[n] ?? [1, 1];
  const sides: SheetSide[] = [];

  for (let start = 0; start < pages.length; start += n) {
    const group = pages.slice(start, start + n);
    const first = group[0]!;
    const userRot = opts.rotation === 'auto' ? 0 : opts.rotation;
    const firstLandscape = isLandscape(first) !== (userRot % 180 !== 0);

    let landscape: boolean;
    if (opts.orientation !== 'auto') landscape = opts.orientation === 'landscape';
    // 2-up and 6-up place pages side by side, which flips the natural sheet orientation.
    else landscape = n === 2 || n === 6 ? !firstLandscape : firstLandscape;

    const width = landscape ? A4.h : A4.w;
    const height = landscape ? A4.w : A4.h;
    // The longer grid dimension follows the longer sheet dimension.
    const cols = landscape ? long : short;
    const rows = landscape ? short : long;
    const cw = width / cols;
    const ch = height / rows;
    const cellLandscape = cw > ch;

    const cells: Cell[] = group.map((page, i) => {
      let rotate = userRot;
      if (opts.rotation === 'auto' && isLandscape(page) !== cellLandscape && !(n === 1 && opts.orientation === 'auto')) {
        rotate = 90;
      }
      const rw = rotate % 180 === 0 ? page.w : page.h;
      const rh = rotate % 180 === 0 ? page.h : page.w;
      const availW = Math.max(cw - margin * 2, 1);
      const availH = Math.max(ch - margin * 2, 1);
      const scale = Math.min(availW / rw, availH / rh);
      const w = rw * scale;
      const h = rh * scale;
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Rows fill top to bottom, so invert for PDF's bottom-left origin.
      const x = col * cw + (cw - w) / 2;
      const y = height - (row + 1) * ch + (ch - h) / 2;
      return { page: start + i, x, y, w, h, rotate: rotate as Cell['rotate'] };
    });
    sides.push({ landscape, width, height, cells });
  }
  return sides;
}

/** Padding inside each cell. Images get a margin so nothing is cropped by printer hardware margins. */
export function cellMargin(kind: 'pdf' | 'jpg' | 'png', pagesPerSheet: number): number {
  if (pagesPerSheet > 1) return 6;
  return kind === 'pdf' ? 0 : 18;
}
