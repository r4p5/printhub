import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, degrees, type PDFEmbeddedPage, type PDFImage, type PDFPage } from 'pdf-lib';
import { MAX_PAGES, cellMargin, layoutSheets, parsePageRange, type DocumentKind, type PageSize, type PrintOptions } from '@printhub/shared';
import { readImageInfo } from './imageInfo.ts';


export interface InspectResult {
  pages: number;
}

/** Throws Error with message ENCRYPTED | CORRUPT | TOO_MANY_PAGES for customer-facing mapping. */
export async function inspect(path: string, kind: DocumentKind): Promise<InspectResult> {
  const bytes = await readFile(path);
  if (kind !== 'pdf') {
    const info = readImageInfo(bytes, kind);
    if (!info.w || !info.h || info.w * info.h > 80e6) throw new Error('CORRUPT');
    return { pages: 1 };
  }
  const doc = await loadPdf(bytes);
  const pages = doc.getPageCount();
  if (pages === 0) throw new Error('CORRUPT');
  if (pages > MAX_PAGES) throw new Error('TOO_MANY_PAGES');
  return { pages };
}

async function loadPdf(bytes: Uint8Array) {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    // pdf-lib cannot decrypt content streams, so any encryption would print garbage.
    if (doc.isEncrypted) throw new Error('ENCRYPTED');
    doc.getPageCount(); // forces the page tree to resolve
  } catch (e) {
    if ((e as Error).message === 'ENCRYPTED' || hasEncryptDict(bytes)) throw new Error('ENCRYPTED');
    throw new Error('CORRUPT');
  }
  return doc;
}

/** Fallback for files whose trailer pdf-lib fails to parse: look for an /Encrypt key near the end. */
function hasEncryptDict(bytes: Uint8Array) {
  const tail = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(-4096).toString('latin1');
  return tail.includes('/Encrypt');
}

interface Source {
  size: PageSize; // displayed size, after intrinsic rotation
  intrinsic: number; // clockwise
  draw(page: PDFPage, x: number, y: number, w: number, h: number, ccw: number): void;
}

/**
 * Produces a print-ready PDF with page selection, rotation and N-up already applied, so the
 * printer only needs copies/duplex/color from the driver. Returns the number of sheet sides.
 */
export async function render(srcPath: string, kind: DocumentKind, opts: PrintOptions, outPath: string): Promise<number> {
  const bytes = await readFile(srcPath);
  const out = await PDFDocument.create();
  out.setProducer('PrintHub');
  let sources: Source[];

  if (kind === 'pdf') {
    const doc = await loadPdf(bytes);
    const indices = parsePageRange(opts.pageRange, doc.getPageCount());
    const pages = doc.getPages();
    // Embed each distinct page once even if the range repeats it. Pages without a content
    // stream are genuinely blank; pdf-lib refuses to embed them, so they keep their slot but draw nothing.
    const unique = [...new Set(indices)].filter((i) => pages[i]!.node.Contents() !== undefined);
    const embedded = new Map<number, PDFEmbeddedPage>();
    const boxes = unique.map((i) => {
      const box = pages[i]!.getCropBox();
      return { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height };
    });
    const list = await out.embedPages(unique.map((i) => pages[i]!), boxes);
    unique.forEach((i, k) => embedded.set(i, list[k]!));
    sources = indices.map((i) => {
      const e = embedded.get(i);
      const box = pages[i]!.getCropBox();
      const intrinsic = (((pages[i]!.getRotation().angle % 360) + 360) % 360) as number;
      const size = intrinsic % 180 === 0 ? { w: box.width, h: box.height } : { w: box.height, h: box.width };
      return {
        size,
        intrinsic,
        draw: (p, x, y, w, h, ccw) => e && p.drawPage(e, { x, y, width: w, height: h, rotate: degrees(ccw) }),
      };
    });
  } else {
    parsePageRange(opts.pageRange, 1);
    const info = readImageInfo(bytes, kind);
    const img: PDFImage = kind === 'jpg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
    sources = [
      {
        size: { w: info.w, h: info.h },
        intrinsic: info.rotate,
        draw: (p, x, y, w, h, ccw) => p.drawImage(img, { x, y, width: w, height: h, rotate: degrees(ccw) }),
      },
    ];
  }

  const sides = layoutSheets(
    sources.map((s) => s.size),
    opts,
    cellMargin(kind, opts.pagesPerSheet),
  );
  for (const side of sides) {
    const page = out.addPage([side.width, side.height]);
    for (const cell of side.cells) {
      const src = sources[cell.page]!;
      const cw = (src.intrinsic + cell.rotate) % 360;
      // Unrotated drawn size: the cell box is the rotated footprint.
      const turned = cw % 180 !== 0;
      const sw = turned ? cell.h : cell.w;
      const sh = turned ? cell.w : cell.h;
      const ccw = (360 - cw) % 360;
      const [ax, ay] =
        ccw === 90 ? [cell.x + sh, cell.y] : ccw === 180 ? [cell.x + sw, cell.y + sh] : ccw === 270 ? [cell.x, cell.y + sw] : [cell.x, cell.y];
      src.draw(page, ax, ay, sw, sh, ccw);
    }
  }
  // Object streams shrink output considerably, which also speeds up spooling.
  await writeFile(outPath, await out.save({ useObjectStreams: true }));
  return sides.length;
}
