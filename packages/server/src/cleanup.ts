import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import type { Jobs } from './jobs.ts';
import { log } from './log.ts';
import type { Settings } from './settings.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const DRAFT_TTL = 6 * HOUR;
const ROW_TTL = 180 * DAY;

/**
 * Hourly housekeeping: abandoned drafts, retention of failed/uncertain jobs' files, deferred
 * deletions, orphaned directories and very old rows. Cheap indexed queries; runs on an
 * unref'd timer so it never keeps the process alive.
 */
export class Cleanup {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private db: Db;
  private jobs: Jobs;
  private settings: Settings;
  private jobsDir: string;

  constructor(db: Db, jobs: Jobs, settings: Settings, jobsDir: string) {
    this.db = db;
    this.jobs = jobs;
    this.settings = settings;
    this.jobsDir = jobsDir;
  }

  start() {
    const first = setTimeout(() => void this.sweep(), 10_000);
    first.unref();
    this.timer = setInterval(() => void this.sweep(), HOUR);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const { id } of this.db.all<{ id: string }>(
        `SELECT id FROM jobs WHERE state IN ('uploaded', 'awaiting_payment') AND updated_at < ?`, now - DRAFT_TTL)) {
        await this.jobs.cancel(id, 'admin').catch(() => {});
        this.jobs.event(id, 'expired');
      }

      const retention = this.settings.get('general').retentionDays * DAY;
      const stale = this.db.all<{ id: string }>(
        `SELECT id FROM jobs WHERE files_removed = 0 AND state IN ('failed', 'manual_review', 'cancelled', 'completed') AND updated_at < ?`, now - retention);
      for (const { id } of stale) await this.jobs.removeFiles(id);

      for (const c of this.db.all<{ path: string; attempts: number }>('SELECT path, attempts FROM cleanup WHERE next_at <= ?', now)) {
        try {
          await rm(c.path, { recursive: true, force: true });
          this.db.run('DELETE FROM cleanup WHERE path = ?', c.path);
        } catch {
          // Exponential backoff, capped at a day.
          this.db.run('UPDATE cleanup SET attempts = attempts + 1, next_at = ? WHERE path = ?', now + Math.min(2 ** c.attempts * 60_000, DAY), c.path);
        }
      }

      // Directories left behind by a crash between file write and DB insert, or by purged rows.
      for (const entry of await readdir(this.jobsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !this.db.get('SELECT 1 FROM jobs WHERE id = ?', entry.name)) {
          await rm(join(this.jobsDir, entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }

      const purged = this.db.run(`DELETE FROM jobs WHERE state IN ('completed', 'cancelled') AND updated_at < ?`, now - ROW_TTL).changes;
      if (purged) this.db.raw.exec('PRAGMA optimize');
    } catch (e) {
      log.error('cleanup sweep failed', e);
    } finally {
      this.running = false;
    }
  }
}
