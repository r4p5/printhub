import type { DocumentEstimate, OrderEstimate, PrintOptions, Pricing } from './types.ts';

export function estimateDocument(selectedPages: number, opts: PrintOptions, pricing: Pricing): DocumentEstimate {
  const sidesPerCopy = Math.ceil(selectedPages / opts.pagesPerSheet);
  const duplex = opts.sides === 'double';
  // Each copy starts on a fresh sheet, matching how drivers collate duplex copies.
  const sheetsPerCopy = duplex ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;
  const rate =
    opts.color === 'color'
      ? (duplex ? pricing.colorDuplexPerSide : null) ?? pricing.colorPerSide
      : (duplex ? pricing.bwDuplexPerSide : null) ?? pricing.bwPerSide;
  return {
    pages: selectedPages,
    sidesPerCopy,
    sheetsPerCopy,
    copies: opts.copies,
    color: opts.color,
    sides: opts.sides,
    amount: sidesPerCopy * opts.copies * rate,
  };
}

export function estimateOrder(docs: { pages: number; options: PrintOptions }[], pricing: Pricing): OrderEstimate {
  const documents = docs.map((d) => estimateDocument(d.pages, d.options, pricing));
  const subtotal = documents.reduce((s, d) => s + d.amount, 0);
  const total = documents.length ? Math.max(subtotal, pricing.minimumOrder) : 0;
  return {
    documents,
    totalPages: documents.reduce((s, d) => s + d.pages * d.copies, 0),
    totalSheets: documents.reduce((s, d) => s + d.sheetsPerCopy * d.copies, 0),
    subtotal,
    total,
    minimumApplied: total > subtotal,
  };
}

export const formatRupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
