export class PageRangeError extends Error {}

/**
 * Parses "1-3, 5, 8-" into zero-based page indices, preserving the order written.
 * An empty string selects every page. Bounds are checked against pageCount.
 */
export function parsePageRange(range: string, pageCount: number): number[] {
  const text = range.trim();
  if (text === '') return Array.from({ length: pageCount }, (_, i) => i);

  const out: number[] = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!part || !m || (!m[1] && !m[3])) throw new PageRangeError(`Invalid page range "${part}"`);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > end) {
      throw new PageRangeError(`Pages ${part} are outside 1-${pageCount}`);
    }
    for (let p = start; p <= end; p++) out.push(p - 1);
    // Guards against "1-99999" style abuse on large documents.
    if (out.length > pageCount * 10) throw new PageRangeError('Page range is too long');
  }
  return out;
}
