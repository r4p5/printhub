import type { ColorMode } from '@printhub/shared';

export type PrinterStatus = 'ready' | 'busy' | 'offline' | 'error' | 'unknown';

export interface PrinterCaps {
  color: boolean;
  duplex: boolean;
  papers: string[];
  virtual: boolean;
}

export interface DiscoveredPrinter {
  name: string;
  driver: string;
  port: string;
  caps: PrinterCaps;
  status: PrinterStatus;
  statusDetail: string | null;
}

export interface SubmitRequest {
  file: string;
  printer: string;
  color: ColorMode;
  duplex: 'simplex' | 'long' | 'short';
  copies: number;
  /** Unique token that appears in the spooler document name, used to find the job again. */
  ref: string;
}

/**
 * spooled: waiting in the Windows queue
 * printing: actively printing
 * attention: needs a human (paper out, jam, offline, error) — keep watching
 * gone: no longer in the queue; outcome depends on what was last seen
 */
export interface SpoolStatus {
  state: 'spooled' | 'printing' | 'attention' | 'gone';
  detail?: string;
  /** True once the spooler reported the job as printed/completed. */
  printed?: boolean;
}

export interface PrinterDriver {
  discover(): Promise<DiscoveredPrinter[]>;
  submit(req: SubmitRequest): Promise<void>;
  /** One call for all refs so a single spooler query serves every active job. */
  poll(refs: string[]): Promise<Map<string, SpoolStatus>>;
  close(): Promise<void>;
}
