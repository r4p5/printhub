import { readImageInfo, type PageSize, type SheetSide } from '@printhub/shared';

/** Width in CSS px that thumbnails are rendered at; sheets are drawn from these. */
const THUMB_PX = 360;
const CACHE_MAX = 40;

type PdfDoc = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
function loadPdfjs() {
  // Legacy build: still supports the older Android browsers common in shops' customer base.
  pdfjsPromise ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjsPromise;
}

export interface DocSource {
  readonly key: string;
  /** Displayed sizes (after intrinsic rotation / EXIF) for every page. */
  sizes(): Promise<PageSize[]>;
  thumb(page: number): Promise<ImageBitmap | HTMLCanvasElement>;
  destroy(): void;
}

// --- tiny LRU of rendered thumbnails ----------------------------------------------------------

const cache = new Map<string, ImageBitmap | HTMLCanvasElement>();
function cacheGet(k: string) {
  const v = cache.get(k);
  if (v) {
    cache.delete(k);
    cache.set(k, v);
  }
  return v;
}
function cachePut(k: string, v: ImageBitmap | HTMLCanvasElement) {
  cache.set(k, v);
  while (cache.size > CACHE_MAX) {
    const [oldKey, old] = cache.entries().next().value!;
    cache.delete(oldKey);
    release(old);
  }
}
function release(v: ImageBitmap | HTMLCanvasElement) {
  if ('close' in v) v.close();
  else v.width = v.height = 0; // frees the canvas backing store on mobile Safari
}
function dropKey(prefix: string) {
  for (const [k, v] of cache) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      release(v);
    }
  }
}

// One render at a time: phones have little memory and a single GPU/CPU budget.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

// --- sources ----------------------------------------------------------------------------

export function pdfSource(key: string, load: () => Promise<ArrayBuffer>): DocSource {
  let docPromise: Promise<PdfDoc> | null = null;
  let sizes: Promise<PageSize[]> | null = null;
  const doc = () =>
    (docPromise ??= Promise.all([loadPdfjs(), load()]).then(([lib, data]) =>
      lib.getDocument({ data: new Uint8Array(data) }).promise,
    ));
  return {
    key,
    sizes: () =>
      (sizes ??= doc().then(async (d) => {
        const out: PageSize[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const page = await d.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          out.push({ w: vp.width, h: vp.height });
          page.cleanup();
        }
        return out;
      })),
    thumb: (index) => {
      const k = `${key}:${index}`;
      const hit = cacheGet(k);
      if (hit) return Promise.resolve(hit);
      return serial(async () => {
        const again = cacheGet(k);
        if (again) return again;
        const page = await (await doc()).getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (THUMB_PX * dpr()) / Math.max(base.width, base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvas, viewport: vp, background: 'white' }).promise;
        page.cleanup();
        const out = 'createImageBitmap' in window ? await createImageBitmap(canvas) : canvas;
        if (out !== canvas) release(canvas);
        cachePut(k, out);
        return out;
      });
    },
    destroy: () => {
      dropKey(`${key}:`);
      void docPromise?.then((d) => d.destroy());
    },
  };
}

export function imageSource(key: string, file: Blob): DocSource {
  let sizes: Promise<PageSize[]> | null = null;
  return {
    key,
    sizes: () =>
      (sizes ??= file
        .slice(0, 256 * 1024)
        .arrayBuffer()
        .then((buf) => {
          // Header-only parse: no full decode of a 12 MP photo just to learn its size.
          const info = readImageInfo(new Uint8Array(buf), file.type === 'image/png' ? 'png' : 'jpg');
          return [{ w: info.w, h: info.h }];
        })),
    thumb: () => {
      const k = `${key}:0`;
      const hit = cacheGet(k);
      if (hit) return Promise.resolve(hit);
      return serial(async () => {
        const [size] = await sizes!;
        const scale = (THUMB_PX * dpr()) / Math.max(size!.w, size!.h);
        // The browser applies EXIF orientation and decodes at the reduced size directly.
        const bmp = await createImageBitmap(file, {
          resizeWidth: Math.max(1, Math.round(size!.w * scale)),
          resizeHeight: Math.max(1, Math.round(size!.h * scale)),
          resizeQuality: 'medium',
          imageOrientation: 'from-image',
        });
        cachePut(k, bmp);
        return bmp;
      });
    },
    destroy: () => dropKey(`${key}:`),
  };
}

// --- drawing ---------------------------------------------------------------------------

/** Draws one sheet side; cell geometry comes from the same layout the server prints with. */
export async function drawSheet(canvas: HTMLCanvasElement, side: SheetSide, cssWidth: number, thumb: (page: number) => Promise<CanvasImageSource>, isStale: () => boolean) {
  const s = (cssWidth * dpr()) / side.width;
  canvas.width = Math.round(side.width * s);
  canvas.height = Math.round(side.height * s);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.aspectRatio = `${side.width} / ${side.height}`;
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const cell of side.cells) {
    const img = await thumb(cell.page);
    if (isStale()) return;
    const turned = cell.rotate % 180 !== 0;
    const dw = (turned ? cell.h : cell.w) * s;
    const dh = (turned ? cell.w : cell.h) * s;
    ctx.save();
    // PDF origin is bottom-left; canvas is top-left.
    ctx.translate((cell.x + cell.w / 2) * s, (side.height - cell.y - cell.h / 2) * s);
    ctx.rotate((cell.rotate * Math.PI) / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    if (side.cells.length > 1) {
      ctx.strokeStyle = '#e2e8f0';
      ctx.strokeRect(cell.x * s, (side.height - cell.y - cell.h) * s, cell.w * s, cell.h * s);
    }
  }
}
