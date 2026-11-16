import { createHash } from 'node:crypto';
import type { Capabilities, ColorMode } from '@printhub/shared';
import type { Db } from './db.ts';
import type { DiscoveredPrinter, PrinterCaps, PrinterDriver, PrinterStatus } from './printing/driver.ts';
import { HttpError } from './http.ts';

export type PrinterRole = 'bw' | 'color' | 'any';

export interface Printer {
  id: string;
  name: string;
  enabled: boolean;
  role: PrinterRole;
  priority: number;
  caps: PrinterCaps;
  status: PrinterStatus;
  statusDetail: string | null;
  present: boolean;
  updatedAt: number;
}

interface PrinterRow {
  id: string;
  name: string;
  enabled: number;
  role: PrinterRole;
  priority: number;
  caps: string;
  status: PrinterStatus;
  status_detail: string | null;
  present: number;
  updated_at: number;
}

export interface Requirement {
  color: ColorMode;
  duplex: boolean;
}

const printerId = (name: string) => 'p_' + createHash('sha1').update(name).digest('hex').slice(0, 12);

export const isAvailable = (p: Printer) => p.enabled && p.present && (p.status === 'ready' || p.status === 'busy' || p.status === 'unknown');

/** A printer can take a job only if its role and physical capabilities both allow it. */
export function canPrint(p: Printer, req: Requirement) {
  if (!p.enabled || !p.present) return false;
  if (req.color === 'color' && (!p.caps.color || p.role === 'bw')) return false;
  if (req.color === 'bw' && p.role === 'color') return false;
  if (req.duplex && !p.caps.duplex) return false;
  return true;
}

/**
 * Printer list cached in memory (a shop has a handful of printers) and persisted in SQLite.
 * The cache is the source of truth for routing decisions on the hot path.
 */
export class Printers {
  private list: Printer[] = [];
  private discovering: Promise<Printer[]> | null = null;

  private db: Db;
  private driver: PrinterDriver;

  constructor(db: Db, driver: PrinterDriver) {
    this.db = db;
    this.driver = driver;
    this.list = db.all<PrinterRow>('SELECT * FROM printers ORDER BY priority, name').map(fromRow);
  }

  all(): readonly Printer[] {
    return this.list;
  }

  get(id: string) {
    return this.list.find((p) => p.id === id);
  }

  /** Coalesces concurrent discovery calls into one spooler query. */
  discover(): Promise<Printer[]> {
    this.discovering ??= this.doDiscover().finally(() => (this.discovering = null));
    return this.discovering;
  }

  private async doDiscover() {
    const found = await this.driver.discover();
    const now = Date.now();
    const seen = new Set<string>();
    this.db.tx(() => {
      for (const d of found) {
        const id = printerId(d.name);
        seen.add(id);
        this.db.run(
          `INSERT INTO printers (id, name, caps, status, status_detail, present, updated_at, enabled, role)
           VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET caps = excluded.caps, status = excluded.status,
             status_detail = excluded.status_detail, present = 1, updated_at = excluded.updated_at`,
          id, d.name, JSON.stringify(d.caps), d.status, d.statusDetail, now, d.caps.color ? 'color' : 'bw',
        );
      }
      for (const p of this.list) {
        if (!seen.has(p.id)) {
          this.db.run(`UPDATE printers SET present = 0, status = 'offline', status_detail = 'Printer not found', updated_at = ? WHERE id = ?`, now, p.id);
        }
      }
    });
    this.list = this.db.all<PrinterRow>('SELECT * FROM printers ORDER BY priority, name').map(fromRow);
    return this.list;
  }

  update(id: string, input: Record<string, unknown>) {
    const p = this.get(id);
    if (!p) throw new HttpError(404, 'Printer not found');
    const enabled = input.enabled === undefined ? p.enabled : input.enabled === true;
    const role = input.role === undefined ? p.role : input.role;
    if (role !== 'bw' && role !== 'color' && role !== 'any') throw new HttpError(400, 'Role must be bw, color or any');
    if (role !== 'bw' && !p.caps.color) throw new HttpError(400, 'This printer does not support color');
    const priority = input.priority === undefined ? p.priority : input.priority;
    if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 9) throw new HttpError(400, 'Priority must be 0 (primary) to 9');
    this.db.run('UPDATE printers SET enabled = ?, role = ?, priority = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, role, priority as number, Date.now(), id);
    Object.assign(p, { enabled, role, priority });
    this.list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    return p;
  }

  /** Records a status observed while printing, without a full discovery. */
  setStatus(id: string, status: PrinterStatus, detail: string | null) {
    const p = this.get(id);
    if (!p || (p.status === status && p.statusDetail === detail)) return false;
    p.status = status;
    p.statusDetail = detail;
    this.db.run('UPDATE printers SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?', status, detail, Date.now(), id);
    return true;
  }

  /** What customers may choose: any combination at least one enabled printer can produce. */
  capabilities(): Capabilities & { combos: Record<string, boolean> } {
    const combos: Record<string, boolean> = {};
    for (const color of ['bw', 'color'] as const) {
      for (const duplex of [false, true]) combos[`${color}:${duplex ? 'double' : 'single'}`] = this.list.some((p) => canPrint(p, { color, duplex }));
    }
    return {
      color: combos['color:single']! || combos['color:double']!,
      duplex: combos['bw:double']! || combos['color:double']!,
      combos,
    };
  }

  /**
   * Picks the printer that should take a task now, or null to keep it waiting. A printer only
   * receives work when no better-priority compatible printer is available, so backups engage
   * only when the primary is offline, in error, or disabled.
   */
  route(req: Requirement, idle: (p: Printer) => boolean): Printer | null {
    const candidates = this.list.filter((p) => canPrint(p, req) && isAvailable(p));
    if (candidates.length === 0) return null;
    const best = Math.min(...candidates.map((p) => p.priority));
    return candidates.find((p) => p.priority === best && idle(p)) ?? null;
  }

  publicView(p: Printer) {
    return { ...p };
  }
}

function fromRow(r: PrinterRow): Printer {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    role: r.role,
    priority: r.priority,
    caps: JSON.parse(r.caps),
    status: r.status,
    statusDetail: r.status_detail,
    present: r.present === 1,
    updatedAt: r.updated_at,
  };
}
