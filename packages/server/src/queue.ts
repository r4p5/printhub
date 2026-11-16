import { join } from 'node:path';
import type { DocumentKind, PrintOptions } from '@printhub/shared';
import type { Db } from './db.ts';
import type { EventHub } from './events.ts';
import type { Jobs, TaskRow } from './jobs.ts';
import { log } from './log.ts';
import type { PdfPool } from './pdf/pool.ts';
import type { Printers } from './printers.ts';
import type { PrinterDriver } from './printing/driver.ts';

const POLL_MIN_MS = 1500;
const POLL_MAX_MS = 5000;
const PRINT_TIMEOUT_MS = 45 * 60_000;
const REDISCOVER_MS = 30_000;

interface Monitored {
  taskId: string;
  jobId: string;
  printerId: string;
  startedAt: number;
  attention: string | null;
  /** Restored after an app restart: if the job is already gone we cannot know the outcome. */
  recovered: boolean;
}

type QueuedTask = TaskRow & { kind: DocumentKind; options: string };

const FRIENDLY_RENDER_ERRORS: Record<string, string> = {
  ENCRYPTED: 'Document is password protected',
  CORRUPT: 'Document could not be read',
  TOO_LARGE: 'Document is too large to process',
};

/**
 * Pull-based per-printer queues: each idle printer takes the oldest task it is the best
 * available match for. Nothing runs on a timer while the shop is idle; dispatch is triggered
 * by events (payment verified, printer freed, printer settings changed).
 */
export class PrintQueue {
  private busy = new Set<string>();
  private monitored = new Map<string, Monitored>();
  private dispatchScheduled = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollDelay = POLL_MIN_MS;
  private rediscoverTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inflight = new Set<Promise<void>>();

  private db: Db;
  private jobs: Jobs;
  private printers: Printers;
  private driver: PrinterDriver;
  private pool: PdfPool;
  private hub: EventHub;

  constructor(db: Db, jobs: Jobs, printers: Printers, driver: PrinterDriver, pool: PdfPool, hub: EventHub) {
    this.db = db;
    this.jobs = jobs;
    this.printers = printers;
    this.driver = driver;
    this.pool = pool;
    this.hub = hub;
  }

  /** Restores state after a restart without ever re-sending a job that might have printed. */
  recover() {
    const now = Date.now();
    // 'processing' happens strictly before submission, so these are safe to run again.
    const requeued = this.db.run(`UPDATE tasks SET state = 'queued', printer_id = NULL, updated_at = ? WHERE state = 'processing'`, now).changes;
    for (const t of this.db.all<TaskRow>(`SELECT * FROM tasks WHERE state = 'printing'`)) {
      this.busy.add(t.printer_id!);
      this.monitored.set(t.spool_ref!, { taskId: t.id, jobId: t.job_id, printerId: t.printer_id!, startedAt: t.updated_at, attention: null, recovered: true });
    }
    for (const { job_id } of this.db.all<{ job_id: string }>(`SELECT DISTINCT job_id FROM tasks WHERE state IN ('queued', 'printing')`)) {
      this.jobs.refreshState(job_id);
    }
    if (requeued || this.monitored.size) log.info('queue recovered', { requeued, monitoring: this.monitored.size });
    if (this.monitored.size) this.schedulePoll(0);
    this.kick();
  }

  kick() {
    if (this.dispatchScheduled || this.stopped) return;
    this.dispatchScheduled = true;
    setImmediate(() => {
      this.dispatchScheduled = false;
      this.dispatch();
    });
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
    // A task mid-render stops before submission (it re-queues on next start); one mid-submit finishes submitting.
    await Promise.allSettled([...this.inflight]);
  }

  snapshot() {
    return this.printers.all().map((p) => ({
      printerId: p.id,
      busy: this.busy.has(p.id),
      tasks: this.db.all<{ id: string; job_id: string; state: string }>(
        `SELECT id, job_id, state FROM tasks WHERE printer_id = ? AND state IN ('processing', 'printing') ORDER BY seq`, p.id),
    }));
  }

  private dispatch() {
    const queued = this.db.all<QueuedTask>(
      `SELECT t.*, d.kind, d.options FROM tasks t JOIN documents d ON d.id = t.document_id
       WHERE t.state = 'queued' ORDER BY t.seq LIMIT 200`,
    );
    let waiting = false;
    for (const task of queued) {
      const options = JSON.parse(task.options) as PrintOptions;
      const printer = this.printers.route({ color: options.color, duplex: options.sides === 'double' }, (p) => !this.busy.has(p.id));
      if (!printer) {
        waiting = true;
        const reason = this.waitReason(options);
        if (task.error !== reason) this.db.run('UPDATE tasks SET error = ? WHERE id = ?', reason, task.id);
        continue;
      }
      const claimed = this.db.run(
        `UPDATE tasks SET state = 'processing', printer_id = ?, attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`,
        printer.id, Date.now(), task.id,
      ).changes;
      if (!claimed) continue;
      this.busy.add(printer.id);
      this.jobs.refreshState(task.job_id);
      const p = this.run(task, options, printer.id, printer.name);
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }
    // Tasks blocked on an unavailable printer: re-check printer status periodically, but only while blocked.
    if (waiting) this.scheduleRediscover();
  }

  private waitReason(options: PrintOptions) {
    const req = { color: options.color, duplex: options.sides === 'double' };
    const any = this.printers.all().some((p) => p.enabled && p.present && (req.color === 'bw' ? p.role !== 'color' : p.caps.color && p.role !== 'bw') && (!req.duplex || p.caps.duplex));
    return any ? 'Waiting for printer' : 'No enabled printer supports these settings';
  }

  private async run(task: QueuedTask, options: PrintOptions, printerId: string, printerName: string) {
    const ref = `PH-${task.id}`;
    const dir = this.jobs.dir(task.job_id);
    const out = join(dir, `${ref}.pdf`);
    try {
      await this.pool.render(join(dir, `${task.document_id}.${task.kind}`), task.kind, options, out);
    } catch (e) {
      const msg = (e as Error).message;
      this.finish(task.id, task.job_id, printerId, 'failed', FRIENDLY_RENDER_ERRORS[msg] ?? `Could not prepare document: ${msg}`);
      return;
    }
    if (this.stopped) return;

    // Recorded before submission: if we crash mid-submit, recovery treats it as uncertain.
    this.db.run(`UPDATE tasks SET state = 'printing', spool_ref = ?, updated_at = ? WHERE id = ?`, ref, Date.now(), task.id);
    this.jobs.refreshState(task.job_id);
    try {
      await this.driver.submit({
        file: out,
        printer: printerName,
        color: options.color,
        duplex: options.sides === 'single' ? 'simplex' : options.binding,
        copies: options.copies,
        ref,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      log.error('submit failed', { task: task.id, printer: printerName, error: err.message });
      // ENOENT: the print helper never started, so nothing can have printed.
      if (err.code === 'ENOENT') this.finish(task.id, task.job_id, printerId, 'failed', 'Print helper is missing; reinstall PrintHub');
      else this.finish(task.id, task.job_id, printerId, 'manual_review', 'Could not confirm the job reached the printer');
      return;
    }
    if (this.stopped) return; // recovery picks it up as 'printing' on next start
    this.monitored.set(ref, { taskId: task.id, jobId: task.job_id, printerId, startedAt: Date.now(), attention: null, recovered: false });
    this.pollDelay = POLL_MIN_MS;
    this.schedulePoll(POLL_MIN_MS);
  }

  private finish(taskId: string, jobId: string, printerId: string, state: TaskRow['state'], error: string | null) {
    this.db.run('UPDATE tasks SET state = ?, error = ?, updated_at = ? WHERE id = ?', state, error, Date.now(), taskId);
    this.busy.delete(printerId);
    this.jobs.event(jobId, `task_${state}`, { taskId, error });
    this.jobs.refreshState(jobId);
    if (state !== 'completed') this.hub.publish('admin', 'alert', { jobId, taskId, state, error });
    this.kick();
  }

  private schedulePoll(delay: number) {
    if (this.pollTimer || this.stopped || this.monitored.size === 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private async poll() {
    const refs = [...this.monitored.keys()];
    let statuses;
    try {
      statuses = await this.driver.poll(refs);
    } catch (e) {
      log.warn('spooler poll failed', { error: (e as Error).message });
      this.pollDelay = POLL_MAX_MS;
      this.schedulePoll(this.pollDelay);
      return;
    }
    let changed = false;
    for (const ref of refs) {
      const m = this.monitored.get(ref);
      const s = statuses.get(ref);
      if (!m || !s) continue;
      if (s.state === 'gone') {
        this.monitored.delete(ref);
        changed = true;
        if (m.recovered) this.finish(m.taskId, m.jobId, m.printerId, 'manual_review', 'PrintHub restarted during printing; check whether it printed');
        else if (m.attention && !s.printed) this.finish(m.taskId, m.jobId, m.printerId, 'manual_review', `Left the print queue after: ${m.attention}`);
        else this.finish(m.taskId, m.jobId, m.printerId, 'completed', null);
        if (m.attention) this.printers.setStatus(m.printerId, 'ready', null);
        continue;
      }
      // Seen alive after restart: from here on it behaves like a normal job.
      m.recovered = false;
      if (s.state === 'attention') {
        if (m.attention !== s.detail) {
          m.attention = s.detail ?? 'Printer needs attention';
          changed = true;
          this.db.run('UPDATE tasks SET error = ? WHERE id = ?', m.attention, m.taskId);
          if (this.printers.setStatus(m.printerId, 'error', m.attention)) this.hub.publish('admin', 'printer', { id: m.printerId });
          this.hub.publish('admin', 'alert', { jobId: m.jobId, taskId: m.taskId, state: 'attention', error: m.attention });
        }
      } else if (m.attention) {
        m.attention = null;
        changed = true;
        this.db.run('UPDATE tasks SET error = NULL WHERE id = ?', m.taskId);
        this.printers.setStatus(m.printerId, 'ready', null);
      }
      if (Date.now() - m.startedAt > PRINT_TIMEOUT_MS) {
        this.monitored.delete(ref);
        this.finish(m.taskId, m.jobId, m.printerId, 'manual_review', 'Printing took too long; check the printer');
      }
    }
    // Poll quickly while things change, back off while a long job just prints.
    this.pollDelay = changed ? POLL_MIN_MS : Math.min(this.pollDelay * 1.5, POLL_MAX_MS);
    this.schedulePoll(this.pollDelay);
  }

  private scheduleRediscover() {
    if (this.rediscoverTimer || this.stopped) return;
    this.rediscoverTimer = setTimeout(async () => {
      this.rediscoverTimer = null;
      try {
        await this.printers.discover();
        this.hub.publish('admin', 'printer', {});
      } catch (e) {
        log.warn('printer refresh failed', { error: (e as Error).message });
      }
      this.kick();
    }, REDISCOVER_MS);
    this.rediscoverTimer.unref();
  }
}
