import type { PagesPerSheet, PrintOptions, Rotation } from '@printhub/shared';
import type { ShopConfig } from './types';

export function optionsSummary(o: PrintOptions) {
  const parts = [o.color === 'color' ? 'Color' : 'B&W', o.sides === 'double' ? 'Double-sided' : 'Single-sided'];
  if (o.pagesPerSheet > 1) parts.push(`${o.pagesPerSheet} per sheet`);
  if (o.pageRange) parts.push(`pages ${o.pageRange}`);
  if (o.copies > 1) parts.push(`${o.copies} copies`);
  return parts.join(' · ');
}

function Seg<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function OptionsPanel({ options: o, pages, config, onChange, onApplyAll }: {
  options: PrintOptions;
  pages: number;
  config: ShopConfig;
  onChange: (o: PrintOptions) => void;
  onApplyAll?: () => void;
}) {
  const combos = config.capabilities.combos;
  const set = (p: Partial<PrintOptions>) => {
    const next = { ...o, ...p };
    // Keep the pair valid: e.g. switching to color on a shop without color duplex falls back to single-sided.
    if (!combos[`${next.color}:${next.sides}`]) next.sides = next.sides === 'double' ? 'single' : 'double';
    onChange(next);
  };
  const custom = o.pageRange !== '';

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Seg label="Color" value={o.color} onChange={(color) => set({ color })} options={[
        { value: 'bw', label: 'B&W', disabled: !combos['bw:single'] && !combos['bw:double'] },
        { value: 'color', label: 'Color', disabled: !config.capabilities.color },
      ]} />
      <Seg label="Sides" value={o.sides} onChange={(sides) => set({ sides })} options={[
        { value: 'single', label: 'Single', disabled: !combos[`${o.color}:single`] },
        { value: 'double', label: 'Double', disabled: !combos[`${o.color}:double`] },
      ]} />
      {o.sides === 'double' && (
        <Seg label="Flip on" value={o.binding} onChange={(binding) => set({ binding })} options={[
          { value: 'long', label: 'Long edge' },
          { value: 'short', label: 'Short edge' },
        ]} />
      )}
      <Seg<PagesPerSheet> label="Pages per sheet" value={o.pagesPerSheet} onChange={(pagesPerSheet) => set({ pagesPerSheet })}
        options={([1, 2, 4, 6, 9] as const).map((n) => ({ value: n, label: String(n) }))} />
      <Seg label="Orientation" value={o.orientation} onChange={(orientation) => set({ orientation })} options={[
        { value: 'auto', label: 'Auto' },
        { value: 'portrait', label: 'Portrait' },
        { value: 'landscape', label: 'Landscape' },
      ]} />
      <Seg<Rotation> label="Rotate" value={o.rotation} onChange={(rotation) => set({ rotation })}
        options={(['auto', 0, 90, 180, 270] as const).map((r) => ({ value: r, label: r === 'auto' ? 'Auto' : `${r}°` }))} />
      {pages > 1 && (
        <div>
          <span className="label">Pages</span>
          <div className="flex gap-2">
            <div className="seg shrink-0">
              <button type="button" aria-pressed={!custom} onClick={() => set({ pageRange: '' })}>All {pages}</button>
              <button type="button" aria-pressed={custom} onClick={() => !custom && set({ pageRange: `1-${pages}` })}>Custom</button>
            </div>
            {custom && (
              <input className="input" inputMode="numeric" placeholder="e.g. 1-3, 5" value={o.pageRange} aria-label="Page range"
                onChange={(e) => onChange({ ...o, pageRange: e.target.value.replace(/[^\d,\-\s]/g, '') })} />
            )}
          </div>
        </div>
      )}
      <div>
        <span className="label">Copies</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary btn-sm w-10" aria-label="Fewer copies" disabled={o.copies <= 1} onClick={() => set({ copies: o.copies - 1 })}>−</button>
          <span className="w-8 text-center font-semibold" aria-live="polite">{o.copies}</span>
          <button type="button" className="btn-secondary btn-sm w-10" aria-label="More copies" disabled={o.copies >= config.limits.maxCopies} onClick={() => set({ copies: o.copies + 1 })}>+</button>
        </div>
      </div>
      {onApplyAll && (
        <button type="button" className="btn-secondary sm:col-span-2" onClick={onApplyAll}>Apply these settings to all documents</button>
      )}
    </div>
  );
}
