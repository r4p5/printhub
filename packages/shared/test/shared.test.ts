import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A4, DEFAULT_OPTIONS, estimateOrder, layoutSheets, parseOptions, parsePageRange, type Pricing } from '../src/index.ts';

const caps = { color: true, duplex: true };
const pricing: Pricing = { bwPerSide: 200, colorPerSide: 1000, bwDuplexPerSide: 150, colorDuplexPerSide: null, minimumOrder: 500, maxCopies: 50 };

test('page ranges', () => {
  assert.deepEqual(parsePageRange('', 3), [0, 1, 2]);
  assert.deepEqual(parsePageRange('1-2, 5, 4-', 5), [0, 1, 4, 3, 4]);
  assert.deepEqual(parsePageRange('-2', 5), [0, 1]);
  assert.throws(() => parsePageRange('0', 5));
  assert.throws(() => parsePageRange('3-2', 5));
  assert.throws(() => parsePageRange('6', 5));
  assert.throws(() => parsePageRange('a', 5));
  assert.throws(() => parsePageRange('-', 5));
});

test('options validation rejects unsupported capabilities', () => {
  assert.deepEqual(parseOptions({}, caps, 10), DEFAULT_OPTIONS);
  assert.throws(() => parseOptions({ color: 'color' }, { color: false, duplex: true }, 10));
  assert.throws(() => parseOptions({ sides: 'double' }, { color: true, duplex: false }, 10));
  assert.throws(() => parseOptions({ copies: 11 }, caps, 10));
  assert.throws(() => parseOptions({ pagesPerSheet: 3 }, caps, 10));
  assert.equal(parseOptions({ rotation: 90, junk: 1 }, caps, 10).rotation, 90);
});

test('pricing: duplex, n-up, minimum order', () => {
  const o = { ...DEFAULT_OPTIONS };
  // 5 pages, 2-up => 3 sides, duplex => 2 sheets, 2 copies at duplex rate 150
  const e = estimateOrder([{ pages: 5, options: { ...o, pagesPerSheet: 2, sides: 'double', copies: 2 } }], pricing);
  assert.equal(e.documents[0]!.sidesPerCopy, 3);
  assert.equal(e.totalSheets, 4);
  assert.equal(e.subtotal, 900);
  assert.equal(e.total, 900);
  const small = estimateOrder([{ pages: 1, options: o }], pricing);
  assert.equal(small.total, 500);
  assert.ok(small.minimumApplied);
  // Color duplex has no override, so falls back to the single-sided color price.
  assert.equal(estimateOrder([{ pages: 2, options: { ...o, color: 'color', sides: 'double' } }], pricing).subtotal, 2000);
  assert.equal(estimateOrder([], pricing).total, 0);
});

test('layout: portrait 1-up fills A4, landscape page gets landscape sheet', () => {
  const [side] = layoutSheets([A4], DEFAULT_OPTIONS);
  assert.equal(side!.landscape, false);
  assert.equal(Math.round(side!.cells[0]!.w), Math.round(A4.w));
  const [land] = layoutSheets([{ w: 800, h: 600 }], DEFAULT_OPTIONS);
  assert.equal(land!.landscape, true);
  assert.equal(land!.cells[0]!.rotate, 0);
});

test('layout: forced portrait rotates landscape pages to fit', () => {
  const [side] = layoutSheets([{ w: 800, h: 600 }], { ...DEFAULT_OPTIONS, orientation: 'portrait' });
  assert.equal(side!.landscape, false);
  assert.equal(side!.cells[0]!.rotate, 90);
});

test('layout: 2-up portrait pages go side by side on landscape sheet', () => {
  const sides = layoutSheets([A4, A4, A4], { ...DEFAULT_OPTIONS, pagesPerSheet: 2 });
  assert.equal(sides.length, 2);
  assert.equal(sides[0]!.landscape, true);
  const [a, b] = sides[0]!.cells;
  assert.ok(a!.x < b!.x);
  assert.equal(sides[1]!.cells.length, 1);
});

test('layout: 4-up fills rows top to bottom, all cells inside sheet', () => {
  const [side] = layoutSheets([A4, A4, A4, A4], { ...DEFAULT_OPTIONS, pagesPerSheet: 4 }, 6);
  const c = side!.cells;
  assert.ok(c[0]!.y > c[2]!.y, 'first row is on top');
  for (const cell of c) {
    assert.ok(cell.x >= 0 && cell.y >= 0 && cell.x + cell.w <= side!.width + 1e-6 && cell.y + cell.h <= side!.height + 1e-6);
  }
});
