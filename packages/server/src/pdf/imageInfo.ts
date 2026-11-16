import type { PageSize } from '@printhub/shared';

export interface ImageInfo extends PageSize {
  /** Clockwise rotation from EXIF orientation, so photos print the way phones show them. */
  rotate: 0 | 90 | 180 | 270;
}

const EXIF_ROTATION: Record<number, ImageInfo['rotate']> = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/** Reads dimensions from the file header only; never decodes pixels. */
export function readImageInfo(buf: Uint8Array, kind: 'jpg' | 'png'): ImageInfo {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (kind === 'png') {
    if (buf.length < 24) throw new Error('CORRUPT');
    return { w: dv.getUint32(16), h: dv.getUint32(20), rotate: 0 };
  }
  let rotate: ImageInfo['rotate'] = 0;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) throw new Error('CORRUPT');
    const marker = buf[off + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = dv.getUint16(off + 2);
    if (marker === 0xe1 && len > 8) rotate = exifRotation(dv, off + 4, len - 2) ?? rotate;
    // SOF0-SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 > buf.length) break;
      const h = dv.getUint16(off + 5);
      const w = dv.getUint16(off + 7);
      return rotate % 180 === 0 ? { w, h, rotate } : { w: h, h: w, rotate };
    }
    off += 2 + len;
  }
  throw new Error('CORRUPT');
}

function exifRotation(dv: DataView, start: number, len: number): ImageInfo['rotate'] | undefined {
  if (dv.getUint32(start) !== 0x45786966) return; // "Exif"
  const tiff = start + 6;
  if (tiff + 8 > start + len) return;
  const little = dv.getUint16(tiff) === 0x4949;
  const ifd = tiff + dv.getUint32(tiff + 4, little);
  if (ifd + 2 > dv.byteLength) return;
  const entries = dv.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > dv.byteLength) return;
    if (dv.getUint16(e, little) === 0x0112) return EXIF_ROTATION[dv.getUint16(e + 8, little)];
  }
}
