import type { Capabilities, PrintOptions } from './types.ts';

export const DEFAULT_OPTIONS: Readonly<PrintOptions> = Object.freeze({
  color: 'bw',
  orientation: 'auto',
  sides: 'single',
  binding: 'long',
  pagesPerSheet: 1,
  rotation: 'auto',
  pageRange: '',
  copies: 1,
});

const PAGES_PER_SHEET = [1, 2, 4, 6, 9] as const;
const ROTATIONS = ['auto', 0, 90, 180, 270] as const;

function pick<T>(value: unknown, allowed: readonly T[], field: string): T {
  if (allowed.includes(value as T)) return value as T;
  throw new OptionsError(`Invalid ${field}`);
}

export class OptionsError extends Error {}

/**
 * Validates untrusted options. Unknown keys are dropped, missing keys take defaults,
 * and anything the shop cannot physically do is rejected rather than silently changed.
 */
export function parseOptions(input: unknown, caps: Capabilities, maxCopies: number): PrintOptions {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  const copies = o.copies ?? d.copies;
  if (!Number.isInteger(copies) || (copies as number) < 1 || (copies as number) > maxCopies) {
    throw new OptionsError(`Copies must be between 1 and ${maxCopies}`);
  }
  const pageRange = o.pageRange ?? d.pageRange;
  if (typeof pageRange !== 'string' || pageRange.length > 200) throw new OptionsError('Invalid page range');

  const opts: PrintOptions = {
    color: pick(o.color ?? d.color, ['bw', 'color'] as const, 'color mode'),
    orientation: pick(o.orientation ?? d.orientation, ['auto', 'portrait', 'landscape'] as const, 'orientation'),
    sides: pick(o.sides ?? d.sides, ['single', 'double'] as const, 'sides'),
    binding: pick(o.binding ?? d.binding, ['long', 'short'] as const, 'binding'),
    pagesPerSheet: pick(o.pagesPerSheet ?? d.pagesPerSheet, PAGES_PER_SHEET, 'pages per sheet'),
    rotation: pick(o.rotation ?? d.rotation, ROTATIONS, 'rotation'),
    pageRange: pageRange.trim(),
    copies: copies as number,
  };
  if (opts.color === 'color' && !caps.color) throw new OptionsError('Color printing is not available at this shop');
  if (opts.sides === 'double' && !caps.duplex) throw new OptionsError('Double-sided printing is not available at this shop');
  return opts;
}
