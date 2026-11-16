import { createHmac, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  estimateOrder,
  parseOptions,
  parsePageRange,
  DEFAULT_OPTIONS,
  OptionsError,
  PageRangeError,
  type DocumentKind,
  type JobState,
  type OrderEstimate,
  type PrintOptions,
  type Pricing,
} from '@printhub/shared';
import type { Db } from './db.ts';
import type { EventHub } from './events.ts';
import { HttpError, safeEqual } from './http.ts';
import type { Printers } from './printers.ts';
import type { Settings } from './settings.ts';
import { log } from './log.ts';

export interface JobRow {
  id: string;
  code: string;
  idem_key: string | null;
  state: JobState;
  total: number | null;
  estimate: string | null;
  pricing: string | null;
  amount_received: number | null;
  error: string | null;
  files_removed: number;
  created_at: number;
  updated_at: number;
}

export interface DocRow {
  id: string;
  job_id: string;
  position: number;
  name: string;
  kind: DocumentKind;
  size: number;
  pages: number;
  options: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  job_id: string;
  document_id: string;
  printer_id: string | null;
  seq: number;
  state: 'queued' | 'processing' | 'printing' | 'completed' | 'failed' | 'manual_review' | 'cancelled';
  spool_ref: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const EDITABLE: JobState[] = ['uploaded', 'awaiting_payment'];
const PAYABLE: JobState[] = ['awaiting_payment', 'payment_pending'];
export const ACTIVE_TASK = ['queued', 'processing', 'printing'] as const;
const MAX_OPEN_DRAFTS = 200;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const newCode = () => Array.from(randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
export const newId = (prefix: string) => prefix + randomBytes(12).toString('base64url');

/** Customer-facing explanation per state. Never mentions printer names. */
export const STATE_TEXT: Record<JobState, string> = {
  uploaded: 'Add documents and choose print options',
  awaiting_payment: 'Waiting for payment',
  payment_pending: 'Payment sent — waiting for the shop to confirm',
  payment_verified: 'Payment confirmed',
  queued: 'In the print queue',
  processing: 'Preparing your documents',
  printing: 'Printing',
  completed: 'Printed — collect your documents',
  failed: 'Printing failed — please talk to the shopkeeper',
  manual_review: 'The shopkeeper is checking your order',
  cancelled: 'Cancelled',
};

export class Jobs {
  /** Fire-and-forget work (file deletion) that shutdown must wait for. */
  private background = new Set<Promise<unknown>>();

  private db: Db;
  private settings: Settings;
  private printers: Printers;
  private hub: EventHub;
  private jobsDir: string;
  private secret: string;

  constructor(db: Db, settings: Settings, printers: Printers, hub: EventHub, jobsDir: string, secret: string) {
    this.db = db;
    this.settings = settings;
    this.printers = printers;
    this.hub = hub;
    this.jobsDir = jobsDir;
    this.secret = secret;
  }

  // --- identity -----------------------------------------------------------------------

  /** Deterministic so an idempotent retry of job creation can return the same token. */
  tokenFor(id: string) {
    return createHmac('sha256', this.secret).update(id).digest('base64url').slice(0, 32);
  }

  authorize(id: string, token: string | null | undefined): JobRow {
    if (!ID_RE.test(id) || !token || !safeEqual(token, this.tokenFor(id))) throw new HttpError(404, 'Order not found');
    const job = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw new HttpError(404, 'Order not found');
    return job;
  }

  get(id: string): JobRow {
    const job = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw new HttpError(404, 'Order not found');
    return job;
  }

  dir(id: string) {
    return join(this.jobsDir, id);
  }

  // --- customer flow ------------------------------------------------------------------

  create(idemKey: string | null) {
    if (!this.settings.acceptingJobs) throw new HttpError(503, 'This shop is not accepting orders right now', 'SHOP_CLOSED');
    if (idemKey !== null && !ID_RE.test(idemKey)) throw new HttpError(400, 'Invalid idempotency key');
    if (idemKey) {
      const existing = this.db.get<JobRow>('SELECT * FROM jobs WHERE idem_key = ?', idemKey);
      if (existing) return { job: existing, token: this.tokenFor(existing.id) };
    }
    const open = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'uploaded'`)!.n;
    if (open >= MAX_OPEN_DRAFTS) throw new HttpError(503, 'The shop is very busy, please try again shortly');
    const now = Date.now();
    const id = newId('j_');
    this.db.run(`INSERT INTO jobs (id, code, idem_key, state, created_at, updated_at) VALUES (?, ?, ?, 'uploaded', ?, ?)`, id, newCode(), idemKey, now, now);
    this.event(id, 'created');
    return { job: this.get(id), token: this.tokenFor(id) };
  }

  documents(jobId: string) {
    return this.db.all<DocRow>('SELECT * FROM documents WHERE job_id = ? ORDER BY position', jobId);
  }

  assertEditable(job: JobRow) {
    if (!EDITABLE.includes(job.state)) throw new HttpError(409, 'This order can no longer be changed', 'LOCKED');
  }

  addDocument(job: JobRow, doc: { id: string; name: string; kind: DocumentKind; size: number; pages: number }) {
    this.assertEditable(job);
    const now = Date.now();
    this.db.tx(() => {
      const pos = this.db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM documents WHERE job_id = ?', job.id)!.p;
      this.db.run(
        'INSERT INTO documents (id, job_id, position, name, kind, size, pages, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        doc.id, job.id, pos, doc.name, doc.kind, doc.size, doc.pages, JSON.stringify(DEFAULT_OPTIONS), now,
      );
      this.touch(job.id);
    });
    return this.db.get<DocRow>('SELECT * FROM documents WHERE id = ?', doc.id)!;
  }

  async removeDocument(job: JobRow, docId: string) {
    this.assertEditable(job);
    const doc = this.db.get<DocRow>('SELECT * FROM documents WHERE id = ? AND job_id = ?', docId, job.id);
    if (!doc) throw new HttpError(404, 'Document not found');
    this.db.tx(() => {
      this.db.run('DELETE FROM documents WHERE id = ?', docId);
      this.touch(job.id);
    });
    await rm(join(this.dir(job.id), `${docId}.${doc.kind}`), { force: true });
  }

  /**
   * Saves document order and options and returns the authoritative estimate. Any change
   * after checkout moves the order back to editing, so a stale price can never be paid.
   */
  configure(job: JobRow, input: unknown): OrderEstimate {
    this.assertEditable(job);
    const docs = this.documents(job.id);
    const list = Array.isArray(input) ? input : null;
    if (!list || list.length !== docs.length) throw new HttpError(400, 'Every uploaded document must be included exactly once');
    const pricing = this.settings.get('pricing');
    const byId = new Map(docs.map((d) => [d.id, d]));
    const seen = new Set<string>();
    const configured = list.map((item: { id?: unknown; options?: unknown }) => {
      const doc = typeof item?.id === 'string' ? byId.get(item.id) : undefined;
      if (!doc || seen.has(doc.id)) throw new HttpError(400, 'Every uploaded document must be included exactly once');
      seen.add(doc.id);
      const options = this.validateOptions(item.options, pricing, doc.name);
      return { doc, options, pages: selectedPages(doc, options) };
    });
    this.db.tx(() => {
      configured.forEach((c, i) => this.db.run('UPDATE documents SET position = ?, options = ? WHERE id = ?', i, JSON.stringify(c.options), c.doc.id));
      this.touch(job.id);
    });
    return estimateOrder(configured, pricing);
  }

  private validateOptions(raw: unknown, pricing: Pricing, name: string): PrintOptions {
    const caps = this.printers.capabilities();
    try {
      const o = parseOptions(raw, caps, pricing.maxCopies);
      if (!caps.combos[`${o.color}:${o.sides}`]) {
        throw new OptionsError(`${o.color === 'color' ? 'Color' : 'B&W'} ${o.sides === 'double' ? 'double-sided' : 'single-sided'} printing is not available`);
      }
      return o;
    } catch (e) {
      if (e instanceof OptionsError) throw new HttpError(400, `${name}: ${e.message}`);
      throw e;
    }
  }

  /** Locks the order at its current price and returns the payment details. */
  checkout(job: JobRow) {
    this.assertEditable(job);
    const docs = this.documents(job.id);
    if (docs.length === 0) throw new HttpError(400, 'Add at least one document');
    const pricing = this.settings.get('pricing');
    // Re-validate stored options: printers or pricing limits may have changed since configure.
    const estimate = estimateOrder(
      docs.map((d) => {
        const options = this.validateOptions(JSON.parse(d.options), pricing, d.name);
        return { options, pages: selectedPages(d, options) };
      }),
      pricing,
    );
    if (estimate.total <= 0) throw new HttpError(400, 'Order total must be greater than zero');
    this.db.run(
      `UPDATE jobs SET state = 'awaiting_payment', total = ?, estimate = ?, pricing = ?, updated_at = ? WHERE id = ?`,
      estimate.total, JSON.stringify(estimate), JSON.stringify(pricing), Date.now(), job.id,
    );
    this.event(job.id, 'checkout', { total: estimate.total });
    return { estimate, payment: this.paymentFor(this.get(job.id)) };
  }

  paymentFor(job: JobRow) {
    const pay = this.settings.get('payment');
    const shop = this.settings.get('shop');
    if (job.total === null) return null;
    const params = [
      ['pa', pay.upiId],
      ['pn', pay.merchantName || shop?.shopName || 'PrintHub'],
      ['am', (job.total / 100).toFixed(2)],
      ['cu', 'INR'],
      ['tn', `PRINT-${job.code}`],
    ];
    return {
      amount: job.total,
      reference: `PRINT-${job.code}`,
      upiUri: 'upi://pay?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&'),
      instructions: pay.instructions,
    };
  }

  markPaymentPending(job: JobRow) {
    if (job.state === 'payment_pending') return;
    if (job.state !== 'awaiting_payment') throw new HttpError(409, 'Order is not awaiting payment');
    this.setState(job.id, 'payment_pending');
    this.event(job.id, 'payment_pending');
  }

  async cancelByCustomer(job: JobRow) {
    if (!EDITABLE.includes(job.state) && job.state !== 'payment_pending') throw new HttpError(409, 'This order can no longer be cancelled here');
    // Once the customer reports a payment, only the shopkeeper should cancel, so money isn't lost.
    if (job.state === 'payment_pending') throw new HttpError(409, 'Please ask the shopkeeper to cancel a paid order');
    await this.cancel(job.id, 'customer');
  }

  // --- shopkeeper actions -------------------------------------------------------------

  /**
   * Payment verification is the only path that creates print tasks. A mismatched amount
   * goes to manual review unless the shopkeeper explicitly overrides it.
   */
  verifyPayment(jobId: string, amountReceived: number | null, force: boolean) {
    const job = this.get(jobId);
    const allowed = PAYABLE.includes(job.state) || (job.state === 'manual_review' && job.amount_received !== null && !this.hasTasks(jobId));
    if (!allowed) throw new HttpError(409, `Cannot verify payment for an order that is ${job.state}`);
    if (amountReceived !== null && (!Number.isInteger(amountReceived) || amountReceived < 0)) throw new HttpError(400, 'Invalid amount');
    if (amountReceived !== null && amountReceived !== job.total && !force) {
      this.db.run(`UPDATE jobs SET state = 'manual_review', amount_received = ?, error = ?, updated_at = ? WHERE id = ?`,
        amountReceived, `Amount received ${amountReceived} differs from ${job.total}`, Date.now(), jobId);
      this.event(jobId, 'payment_mismatch', { amountReceived, expected: job.total });
      this.publish(jobId);
      return this.get(jobId);
    }
    const now = Date.now();
    this.db.tx(() => {
      const docs = this.documents(jobId);
      let seq = this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) AS s FROM tasks')!.s;
      for (const d of docs) {
        this.db.run(`INSERT INTO tasks (id, job_id, document_id, seq, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
          newId('t_'), jobId, d.id, ++seq, now, now);
      }
      this.db.run(`UPDATE jobs SET state = 'queued', amount_received = COALESCE(?, total), error = NULL, updated_at = ? WHERE id = ?`, amountReceived, now, jobId);
      this.event(jobId, 'payment_verified', { amountReceived, forced: force });
    });
    this.publish(jobId);
    return this.get(jobId);
  }

  async cancel(jobId: string, by: 'customer' | 'admin') {
    const job = this.get(jobId);
    if (job.state === 'completed' || job.state === 'cancelled') throw new HttpError(409, `Order is already ${job.state}`);
    const printing = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE job_id = ? AND state IN ('processing', 'printing')`, jobId)!.n;
    if (printing > 0) throw new HttpError(409, 'Order is printing right now; cancel it from the Windows print queue, then mark it for review');
    this.db.tx(() => {
      this.db.run(`UPDATE tasks SET state = 'cancelled', updated_at = ? WHERE job_id = ? AND state NOT IN ('completed', 'cancelled')`, Date.now(), jobId);
      this.setState(jobId, 'cancelled');
      this.event(jobId, 'cancelled', { by });
    });
    await this.removeFiles(jobId);
  }

  /** Re-queues failed tasks. Uncertain (manual_review) tasks require an explicit decision via resolve(). */
  retry(jobId: string) {
    const n = Number(this.db.run(`UPDATE tasks SET state = 'queued', error = NULL, printer_id = NULL, spool_ref = NULL, updated_at = ? WHERE job_id = ? AND state = 'failed'`, Date.now(), jobId).changes);
    if (n === 0) throw new HttpError(409, 'Nothing to retry');
    this.event(jobId, 'retry', { tasks: n });
    this.refreshState(jobId);
    return n;
  }

  /**
   * Shopkeeper's decision on a task whose physical outcome is unknown.
   * printed: paper came out fine; reprint: send it again; cancel: drop it.
   */
  resolve(jobId: string, taskId: string, outcome: unknown) {
    const task = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND job_id = ?', taskId, jobId);
    if (!task) throw new HttpError(404, 'Task not found');
    if (task.state !== 'manual_review' && task.state !== 'failed') throw new HttpError(409, 'Task does not need review');
    const next = outcome === 'printed' ? 'completed' : outcome === 'reprint' ? 'queued' : outcome === 'cancel' ? 'cancelled' : null;
    if (!next) throw new HttpError(400, 'Outcome must be printed, reprint or cancel');
    this.db.run(`UPDATE tasks SET state = ?, error = NULL, spool_ref = CASE WHEN ? = 'queued' THEN NULL ELSE spool_ref END, printer_id = CASE WHEN ? = 'queued' THEN NULL ELSE printer_id END, updated_at = ? WHERE id = ?`,
      next, next, next, Date.now(), taskId);
    this.event(jobId, 'resolved', { taskId, outcome });
    return this.refreshState(jobId);
  }

  // --- task-driven state ------------------------------------------------------------------

  private hasTasks(jobId: string) {
    return this.db.get('SELECT 1 FROM tasks WHERE job_id = ? LIMIT 1', jobId) !== undefined;
  }

  /** Derives the job state from its tasks after any task change. */
  refreshState(jobId: string): JobState {
    const job = this.get(jobId);
    const states = new Set(this.db.all<{ state: TaskRow['state'] }>('SELECT state FROM tasks WHERE job_id = ?', jobId).map((r) => r.state));
    if (states.size === 0) return job.state;
    let next: JobState;
    if (states.has('printing')) next = 'printing';
    else if (states.has('processing')) next = 'processing';
    else if (states.has('manual_review')) next = 'manual_review';
    else if (states.has('failed')) next = 'failed';
    else if (states.has('queued')) next = 'queued';
    else if (states.has('completed')) next = 'completed';
    else next = 'cancelled';
    if (next !== job.state) {
      this.setState(jobId, next);
      if (next === 'completed') {
        this.event(jobId, 'completed');
        this.track(this.removeFiles(jobId));
      }
    } else this.publish(jobId);
    return next;
  }

  // --- views ------------------------------------------------------------------------------

  customerView(job: JobRow) {
    const docs = this.documents(job.id);
    return {
      id: job.id,
      code: job.code,
      state: job.state,
      stateText: STATE_TEXT[job.state],
      total: job.total,
      estimate: job.estimate ? (JSON.parse(job.estimate) as OrderEstimate) : null,
      payment: job.state === 'awaiting_payment' || job.state === 'payment_pending' ? this.paymentFor(job) : null,
      documents: docs.map((d) => ({ id: d.id, name: d.name, kind: d.kind, size: d.size, pages: d.pages, options: JSON.parse(d.options) as PrintOptions })),
      updatedAt: job.updated_at,
    };
  }

  adminView(job: JobRow) {
    const tasks = this.db.all<TaskRow>('SELECT * FROM tasks WHERE job_id = ? ORDER BY seq', job.id);
    return {
      ...this.customerView(job),
      amountReceived: job.amount_received,
      error: job.error,
      createdAt: job.created_at,
      tasks: tasks.map((t) => ({
        id: t.id,
        documentId: t.document_id,
        printerId: t.printer_id,
        printerName: t.printer_id ? (this.printers.get(t.printer_id)?.name ?? null) : null,
        state: t.state,
        attempts: t.attempts,
        error: t.error,
      })),
    };
  }

  list(states: string[] | null, limit: number) {
    const rows = states
      ? this.db.all<JobRow>(`SELECT * FROM jobs WHERE state IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC LIMIT ?`, JSON.stringify(states), limit)
      : this.db.all<JobRow>(`SELECT * FROM jobs WHERE state != 'uploaded' ORDER BY updated_at DESC LIMIT ?`, limit);
    return rows.map((j) => this.adminView(j));
  }

  overview() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const counts = Object.fromEntries(
      this.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').map((r) => [r.state, r.n]),
    );
    const today = this.db.get<{ orders: number; revenue: number }>(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_received), 0) AS revenue FROM jobs
       WHERE created_at >= ? AND amount_received IS NOT NULL AND state != 'cancelled'`,
      start.getTime(),
    )!;
    return { counts, todayOrders: today.orders, todayRevenue: today.revenue };
  }

  track(p: Promise<unknown>) {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  async drain() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // --- internals ----------------------------------------------------------------------------

  /** Any edit returns the order to the editing state and discards a previously locked price. */
  private touch(jobId: string) {
    this.db.run(`UPDATE jobs SET state = 'uploaded', total = NULL, estimate = NULL, pricing = NULL, updated_at = ? WHERE id = ?`, Date.now(), jobId);
  }

  setState(jobId: string, state: JobState) {
    this.db.run('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?', state, Date.now(), jobId);
    this.publish(jobId);
  }

  event(jobId: string, type: string, detail?: unknown) {
    this.db.run('INSERT INTO job_events (job_id, at, type, detail) VALUES (?, ?, ?, ?)', jobId, Date.now(), type, detail === undefined ? null : JSON.stringify(detail));
  }

  publish(jobId: string) {
    const job = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', jobId);
    if (!job) return;
    this.hub.publish(`job:${jobId}`, 'status', { state: job.state, stateText: STATE_TEXT[job.state] });
    if (job.state !== 'uploaded') this.hub.publish('admin', 'job', { id: jobId, state: job.state });
  }

  async removeFiles(jobId: string) {
    const dir = this.dir(jobId);
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      this.db.run('UPDATE jobs SET files_removed = 1 WHERE id = ?', jobId);
    } catch (e) {
      // Windows can hold a file open briefly (antivirus, spooler); the sweeper retries later.
      log.warn('cleanup deferred', { jobId, error: (e as Error).message });
      this.db.run('INSERT OR IGNORE INTO cleanup (path, next_at) VALUES (?, ?)', dir, Date.now() + 60_000);
    }
  }
}

function selectedPages(doc: DocRow, options: PrintOptions) {
  try {
    return parsePageRange(options.pageRange, doc.pages).length;
  } catch (e) {
    if (e instanceof PageRangeError) throw new HttpError(400, `${doc.name}: ${e.message}`);
    throw e;
  }
}
