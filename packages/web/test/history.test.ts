import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS } from '@printhub/shared';
import { clearHistory, forgetOrder, getFile, listOrders, saveOrder, updateOrder, type HistoryOrder } from '../src/customer/history.ts';

const order = (n: number, shop = '9066191970', size = 1024): HistoryOrder => ({
  jobId: `j_${n}`,
  token: 't',
  shop,
  code: `C${n}`,
  createdAt: 1000 + n,
  total: 500,
  state: 'payment_pending',
  docs: [{ name: `doc${n}.pdf`, kind: 'pdf', pages: 2, size, options: { ...DEFAULT_OPTIONS, copies: 2 }, fileKey: `j_${n}:d` }],
});
const blob = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });

test('saves orders newest first, per shop, and returns saved document copies', async () => {
  await saveOrder(order(1), new Map([['j_1:d', blob(10)]]));
  await saveOrder(order(2), new Map([['j_2:d', blob(20)]]));
  await saveOrder(order(3, '9876543210'), new Map([['j_3:d', blob(30)]]));
  const list = await listOrders('9066191970');
  assert.deepEqual(list.map((o) => o.code), ['C2', 'C1']);
  assert.equal((await getFile('j_1:d'))!.size, 10);
  assert.equal(list[0]!.docs[0]!.options.copies, 2, 'options kept for Print again');

  await updateOrder('j_1', { state: 'completed' });
  assert.equal((await listOrders('9066191970')).find((o) => o.jobId === 'j_1')!.state, 'completed');

  await forgetOrder('j_1');
  assert.equal(await getFile('j_1:d'), undefined, 'removing an order deletes its document copy');
  await clearHistory('9066191970');
  assert.equal((await listOrders('9066191970')).length, 0);
  assert.equal((await listOrders('9876543210')).length, 1, 'other shops untouched');
  await clearHistory('9876543210');
});

test('keeps at most 30 orders and drops oldest document copies beyond 300 MB', async () => {
  for (let i = 1; i <= 32; i++) await saveOrder(order(100 + i), new Map([[`j_${100 + i}:d`, blob(8)]]));
  const list = await listOrders('9066191970');
  assert.equal(list.length, 30);
  assert.equal(list.at(-1)!.code, 'C103', 'two oldest orders pruned');
  assert.equal(await getFile('j_101:d'), undefined);
  await clearHistory('9066191970');

  // Declared sizes drive the budget: 3 x 120 MB -> the oldest copy is dropped, its order kept.
  const MB = 1024 * 1024;
  for (let i = 1; i <= 3; i++) await saveOrder(order(200 + i, '9066191970', 120 * MB), new Map([[`j_${200 + i}:d`, blob(8)]]));
  const big = await listOrders('9066191970');
  assert.equal(big.length, 3);
  assert.deepEqual(big.map((o) => o.docs[0]!.fileKey !== null), [true, true, false]);
  assert.equal(await getFile('j_201:d'), undefined);
});
