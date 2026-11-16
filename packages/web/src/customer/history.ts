import type { JobState, PrintOptions } from '@printhub/shared';

/**
 * Order history kept on the customer's own phone (IndexedDB). The shop PC deletes documents
 * once printed, so "Print again" re-uploads the copies saved here; nothing extra is kept at
 * the shop. Storage is bounded and pruned oldest-first.
 */

export interface HistoryDoc {
  name: string;
  kind: 'pdf' | 'jpg' | 'png';
  pages: number;
  size: number;
  options: PrintOptions;
  /** Key into the files store, or null once the copy was pruned. */
  fileKey: string | null;
}

export interface HistoryOrder {
  jobId: string;
  token: string;
  shop: string;
  code: string;
  createdAt: number;
  total: number | null;
  state: JobState;
  docs: HistoryDoc[];
}

const MAX_ORDERS = 30;
const MAX_FILE_BYTES = 300 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('printhub', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('orders', { keyPath: 'jobId' });
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function allOrders(): Promise<HistoryOrder[]> {
  const d = await db();
  const list = await done(d.transaction('orders').objectStore('orders').getAll() as IDBRequest<HistoryOrder[]>);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listOrders(shop: string): Promise<HistoryOrder[]> {
  try {
    return (await allOrders()).filter((o) => o.shop === shop);
  } catch {
    return []; // private browsing or storage disabled: history simply stays empty
  }
}

/** Saves (or replaces) an order and its document copies, then prunes old data. */
export async function saveOrder(order: HistoryOrder, files: Map<string, Blob>) {
  try {
    // Ask the browser not to evict our data under storage pressure (best effort).
    void navigator.storage?.persist?.();
    const d = await db();
    const tx = d.transaction(['orders', 'files'], 'readwrite');
    for (const [key, blob] of files) tx.objectStore('files').put(blob, key);
    tx.objectStore('orders').put(order);
    await finished(tx);
    await prune();
  } catch {
    // Quota exceeded or storage unavailable: the order still works, just without "Print again".
  }
}

export async function updateOrder(jobId: string, patch: Partial<Pick<HistoryOrder, 'state' | 'total'>>) {
  try {
    const d = await db();
    const tx = d.transaction('orders', 'readwrite');
    const store = tx.objectStore('orders');
    const cur = (await done(store.get(jobId))) as HistoryOrder | undefined;
    if (cur && (cur.state !== patch.state || (patch.total !== undefined && cur.total !== patch.total))) store.put({ ...cur, ...patch });
    await finished(tx);
  } catch {}
}

export async function getFile(key: string): Promise<Blob | undefined> {
  try {
    const d = await db();
    return (await done(d.transaction('files').objectStore('files').get(key))) as Blob | undefined;
  } catch {
    return undefined;
  }
}

export async function forgetOrder(jobId: string) {
  try {
    const d = await db();
    const tx = d.transaction(['orders', 'files'], 'readwrite');
    const cur = (await done(tx.objectStore('orders').get(jobId))) as HistoryOrder | undefined;
    for (const doc of cur?.docs ?? []) if (doc.fileKey) tx.objectStore('files').delete(doc.fileKey);
    tx.objectStore('orders').delete(jobId);
    await finished(tx);
  } catch {}
}

/** Keeps the newest orders, and drops document copies of older orders beyond the byte budget. */
async function prune() {
  const orders = await allOrders();
  const d = await db();
  const tx = d.transaction(['orders', 'files'], 'readwrite');
  const files = tx.objectStore('files');
  const store = tx.objectStore('orders');
  let bytes = 0;
  orders.forEach((o, i) => {
    if (i >= MAX_ORDERS) {
      for (const doc of o.docs) if (doc.fileKey) files.delete(doc.fileKey);
      store.delete(o.jobId);
      return;
    }
    let changed = false;
    const docs = o.docs.map((doc) => {
      if (!doc.fileKey) return doc;
      bytes += doc.size;
      if (bytes <= MAX_FILE_BYTES) return doc;
      files.delete(doc.fileKey);
      changed = true;
      return { ...doc, fileKey: null };
    });
    if (changed) store.put({ ...o, docs });
  });
  await finished(tx);
}

export async function clearHistory(shop: string) {
  for (const o of await listOrders(shop)) await forgetOrder(o.jobId);
}
