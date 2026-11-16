import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveredPrinter, PrinterDriver, SpoolStatus, SubmitRequest } from './driver.ts';

/** In-process fake for development and tests on machines without Windows printers. */
export class MockDriver implements PrinterDriver {
  readonly submitted: SubmitRequest[] = [];
  private jobs = new Map<string, { doneAt: number }>();
  /** Tests can force a printer into an error state. */
  readonly faults = new Map<string, string>();

  private outDir: string;
  private printMs: number;

  constructor(outDir: string, printMs = 1500) {
    this.outDir = outDir;
    this.printMs = printMs;
  }

  async discover(): Promise<DiscoveredPrinter[]> {
    const p = (name: string, color: boolean, duplex: boolean): DiscoveredPrinter => ({
      name,
      driver: 'Mock Driver',
      port: 'MOCK:',
      caps: { color, duplex, papers: ['A4', 'Letter'], virtual: false },
      status: this.faults.has(name) ? 'error' : 'ready',
      statusDetail: this.faults.get(name) ?? null,
    });
    return [p('Mock Mono Laser', false, true), p('Mock Color Inkjet', true, false)];
  }

  async submit(req: SubmitRequest) {
    if (this.faults.has(req.printer)) throw new Error(`Printer error: ${this.faults.get(req.printer)}`);
    await copyFile(req.file, join(this.outDir, `${req.ref}.pdf`));
    this.submitted.push(req);
    this.jobs.set(req.ref, { doneAt: Date.now() + this.printMs });
  }

  async poll(refs: string[]) {
    const out = new Map<string, SpoolStatus>();
    const now = Date.now();
    for (const ref of refs) {
      const j = this.jobs.get(ref);
      if (!j || now >= j.doneAt) {
        this.jobs.delete(ref);
        out.set(ref, { state: 'gone', printed: true });
      } else out.set(ref, { state: 'printing' });
    }
    return out;
  }

  async close() {}
}
