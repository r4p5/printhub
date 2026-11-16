import type { Capabilities, JobState, OrderEstimate, PrintOptions, Pricing } from '@printhub/shared';
import type { DocSource } from '../lib/preview';

export interface ShopConfig {
  shopName: string | null;
  mobileNumber: string | null;
  accepting: boolean;
  pricing: Pricing;
  capabilities: Capabilities & { combos: Record<string, boolean> };
  merchantName: string | null;
  limits: { maxFileBytes: number; maxFiles: number; maxCopies: number; maxPages: number };
}

export interface Payment {
  amount: number;
  reference: string;
  upiUri: string;
  instructions: string;
}

export interface ServerDoc {
  id: string;
  name: string;
  kind: 'pdf' | 'jpg' | 'png';
  size: number;
  pages: number;
  options: PrintOptions;
}

export interface JobView {
  id: string;
  code: string;
  state: JobState;
  stateText: string;
  total: number | null;
  estimate: OrderEstimate | null;
  payment: Payment | null;
  documents: ServerDoc[];
}

export interface LocalDoc {
  /** Client-generated; doubles as the idempotent upload id. */
  localId: string;
  name: string;
  size: number;
  kind: 'pdf' | 'jpg' | 'png';
  file: File | null;
  status: 'queued' | 'uploading' | 'ready' | 'error';
  progress: number;
  error: string | null;
  serverId: string | null;
  pages: number | null;
  options: PrintOptions;
  source: DocSource | null;
}

export interface Session {
  jobId: string;
  token: string;
  shop: string;
}
