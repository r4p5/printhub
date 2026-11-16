import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { A4 } from '@printhub/shared';

/** A one-page A4 test print: border shows clipping, text confirms the routing. */
export async function testPage(printerName: string, shopName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([A4.w, A4.h]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 18, y: 18, width: A4.w - 36, height: A4.h - 36, borderWidth: 1.5, borderColor: rgb(0, 0, 0) });
  page.drawText('PrintHub test page', { x: 60, y: A4.h - 110, size: 28, font: bold });
  const lines = [`Shop: ${shopName}`, `Printer: ${printerName}`, `Time: ${new Date().toLocaleString()}`, '', 'If the border is fully visible, margins are fine.'];
  lines.forEach((l, i) => page.drawText(sanitize(l), { x: 60, y: A4.h - 160 - i * 22, size: 13, font }));
  return doc.save();
}

// Standard fonts are WinAnsi only; replace anything else rather than failing.
const sanitize = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
