import { useEffect, useMemo, useRef, useState } from 'react';
import { cellMargin, layoutSheets, parsePageRange, type PageSize, type PrintOptions, type SheetSide } from '@printhub/shared';
import { drawSheet, type DocSource } from '../lib/preview';

const BATCH = 6;

/** A4 preview built from the exact layout the shop computer prints with. */
export function DocPreview({ source, kind, options }: { source: DocSource; kind: 'pdf' | 'jpg' | 'png'; options: PrintOptions }) {
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(BATCH);

  useEffect(() => {
    let live = true;
    source.sizes().then((s) => live && setSizes(s), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [source]);

  const { sides, selected } = useMemo(() => {
    if (!sizes) return { sides: [] as SheetSide[], selected: [] as number[] };
    const selected = parsePageRange(options.pageRange, sizes.length);
    return { sides: layoutSheets(selected.map((i) => sizes[i]!), options, cellMargin(kind, options.pagesPerSheet)), selected };
  }, [sizes, options.pageRange, options.pagesPerSheet, options.orientation, options.rotation, kind]);

  useEffect(() => setShown(BATCH), [sides.length]);

  if (failed) return <p className="text-xs text-slate-500">Preview isn't available for this document, but it will still print.</p>;
  if (!sizes) return <div className="h-40 animate-pulse rounded-lg bg-slate-100" />;

  const duplex = options.sides === 'double';
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-slate-600">
        Preview · {sides.length} printed side{sides.length === 1 ? '' : 's'}
        {duplex ? ` on ${Math.ceil(sides.length / 2)} sheet${sides.length > 2 ? 's' : ''}` : ''} per copy
      </p>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
        {sides.slice(0, shown).map((side, i) => (
          <figure key={i} className="shrink-0">
            <SheetCanvas side={side} thumb={(p) => source.thumb(selected[p]!)} options={options} />
            <figcaption className="mt-1 text-center text-[11px] text-slate-500">
              {duplex ? `Sheet ${Math.floor(i / 2) + 1} · ${i % 2 ? 'back' : 'front'}` : `Sheet ${i + 1}`}
            </figcaption>
          </figure>
        ))}
        {shown < sides.length && (
          <button className="btn-secondary shrink-0 self-center" onClick={() => setShown((n) => n + BATCH)}>
            Show more ({sides.length - shown})
          </button>
        )}
      </div>
    </div>
  );
}

function SheetCanvas({ side, thumb, options }: { side: SheetSide; thumb: (page: number) => Promise<CanvasImageSource>; options: PrintOptions }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cssWidth = side.landscape ? 200 : 142;

  useEffect(() => {
    const canvas = ref.current!;
    let stale = false;
    // Draw only once scrolled into view; long documents stay cheap.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        drawSheet(canvas, side, cssWidth, thumb, () => stale).catch(() => {});
      },
      { rootMargin: '200px' },
    );
    io.observe(canvas);
    return () => {
      stale = true;
      io.disconnect();
    };
  }, [side, options.color]);

  return (
    <canvas
      ref={ref}
      className={`rounded border border-slate-300 bg-white shadow-sm ${options.color === 'bw' ? 'grayscale' : ''}`}
      style={{ width: cssWidth, aspectRatio: `${side.width} / ${side.height}` }}
    />
  );
}
