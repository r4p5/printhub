import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiscoveredPrinter, PrinterDriver, PrinterStatus, SpoolStatus, SubmitRequest } from './driver.ts';
import { PsHost } from './pshost.ts';

const exec = promisify(execFile);

const VIRTUAL = /microsoft print to pdf|xps document writer|onenote|fax|send to|adobe pdf|pdf24|cutepdf/i;

// One CIM query returns every printer with capabilities; much cheaper than Get-PrintConfiguration per printer.
const DISCOVER = `
@(Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name; driver = $_.DriverName; port = $_.PortName
    caps = @($_.CapabilityDescriptions); papers = @($_.PrinterPaperNames)
    status = [int]$_.PrinterStatus; err = [int]$_.DetectedErrorState; offline = [bool]$_.WorkOffline
  }
}) | ConvertTo-Json -Compress -Depth 3`;

const JOBS = `@(Get-CimInstance -ClassName Win32_PrintJob | ForEach-Object {
  [pscustomobject]@{ doc = $_.Document; mask = [int]$_.StatusMask; status = [string]$_.JobStatus }
}) | ConvertTo-Json -Compress`;

const ERROR_STATES: Record<number, string> = {
  4: 'Out of paper',
  6: 'Out of toner/ink',
  7: 'Door open',
  8: 'Paper jam',
  9: 'Offline',
  10: 'Service requested',
  11: 'Output bin full',
};

// Win32_PrintJob.StatusMask bits
const PAUSED = 1, ERROR = 2, DELETING = 4, PRINTING = 16, OFFLINE = 32, PAPEROUT = 64, PRINTED = 128, DELETED = 256, BLOCKED = 512, INTERVENTION = 1024;

interface RawPrinter {
  name: string;
  driver: string;
  port: string;
  caps: string[] | null;
  papers: string[] | null;
  status: number;
  err: number;
  offline: boolean;
}

export class WindowsDriver implements PrinterDriver {
  private ps = new PsHost();
  private sumatraPath: string;

  constructor(sumatraPath: string) {
    this.sumatraPath = sumatraPath;
  }

  async discover(): Promise<DiscoveredPrinter[]> {
    const raw = parseJsonArray<RawPrinter>(await this.ps.run(DISCOVER));
    return raw.map((p) => {
      const caps = (p.caps ?? []).map((c) => c.toLowerCase());
      let status: PrinterStatus = 'ready';
      let detail: string | null = null;
      if (p.offline || p.status === 7 || p.err === 9) {
        status = 'offline';
        detail = 'Printer is offline';
      } else if (ERROR_STATES[p.err]) {
        status = 'error';
        detail = ERROR_STATES[p.err]!;
      } else if (p.status === 4 || p.status === 5) status = 'busy';
      return {
        name: p.name,
        driver: p.driver ?? '',
        port: p.port ?? '',
        caps: { color: caps.includes('color'), duplex: caps.includes('duplex'), papers: p.papers ?? [], virtual: VIRTUAL.test(p.name) },
        status,
        statusDetail: detail,
      };
    });
  }

  async submit(req: SubmitRequest) {
    const settings = [
      `${req.copies}x`,
      req.duplex === 'simplex' ? 'simplex' : req.duplex === 'long' ? 'duplexlong' : 'duplexshort',
      req.color === 'color' ? 'color' : 'monochrome',
      'paper=A4',
      // Output is already exact A4; shrink only compensates for unprintable hardware margins.
      'shrink',
    ].join(',');
    // SumatraPDF hands the file to the spooler and exits; the document name is the file name,
    // which carries req.ref so poll() can find the job.
    await exec(this.sumatraPath, ['-print-to', req.printer, '-print-settings', settings, '-silent', req.file], {
      windowsHide: true,
      timeout: 120_000,
    });
  }

  async poll(refs: string[]) {
    const out = new Map<string, SpoolStatus>();
    if (refs.length === 0) return out;
    const jobs = parseJsonArray<{ doc: string; mask: number; status: string }>(await this.ps.run(JOBS));
    for (const ref of refs) {
      const job = jobs.find((j) => j.doc?.includes(ref));
      if (!job) {
        out.set(ref, { state: 'gone' });
        continue;
      }
      const m = job.mask;
      const printed = (m & PRINTED) !== 0;
      if (m & (ERROR | OFFLINE | PAPEROUT | BLOCKED | INTERVENTION | PAUSED)) {
        out.set(ref, { state: 'attention', detail: job.status || describeMask(m), printed });
      } else if (m & (DELETING | DELETED)) {
        out.set(ref, { state: 'attention', detail: 'Job is being deleted', printed });
      } else if (m & PRINTING) out.set(ref, { state: 'printing', printed });
      else out.set(ref, { state: printed ? 'printing' : 'spooled', printed });
    }
    return out;
  }

  async close() {
    await this.ps.close();
  }
}

function describeMask(m: number) {
  if (m & PAPEROUT) return 'Out of paper';
  if (m & OFFLINE) return 'Printer offline';
  if (m & INTERVENTION) return 'Printer needs attention';
  if (m & PAUSED) return 'Paused';
  if (m & BLOCKED) return 'Blocked';
  return 'Printer error';
}

/** ConvertTo-Json emits a bare object for single items and nothing for empty input. */
function parseJsonArray<T>(text: string): T[] {
  const t = text.trim();
  if (!t) return [];
  const v = JSON.parse(t);
  return Array.isArray(v) ? v : [v];
}
