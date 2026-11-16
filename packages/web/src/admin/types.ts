import type { JobState, Pricing } from '@printhub/shared';
import type { JobView } from '../customer/types';

export interface Printer {
  id: string;
  name: string;
  enabled: boolean;
  role: 'bw' | 'color' | 'any';
  priority: number;
  caps: { color: boolean; duplex: boolean; papers: string[]; virtual: boolean };
  status: 'ready' | 'busy' | 'offline' | 'error' | 'unknown';
  statusDetail: string | null;
  present: boolean;
}

export interface AdminJob extends JobView {
  amountReceived: number | null;
  error: string | null;
  createdAt: number;
  tasks: { id: string; documentId: string; printerId: string | null; printerName: string | null; state: string; attempts: number; error: string | null }[];
}

export interface Overview {
  counts: Partial<Record<JobState, number>>;
  todayOrders: number;
  todayRevenue: number;
  accepting: boolean;
  setupComplete: boolean;
  open: boolean;
  printers: Printer[];
  server: { version: string; port: number; addresses: { address: string; iface: string }[]; dataDir: string; diskFreeBytes: number | null; uptimeSec: number; memoryMb: number };
  online: OnlineView & { tunnel: { state: 'off' | 'starting' | 'online' | 'error'; url: string | null; registered: boolean; error: string | null } };
  customerUrl: string | null;
  directUrl: string | null;
}

export interface OnlineView {
  enabled: boolean;
  mode: 'quick' | 'named';
  publicUrl: string;
  hasNamedToken: boolean;
}

export interface AllSettings {
  online: OnlineView;
  shop: { shopName: string; mobileNumber: string } | null;
  payment: { upiId: string; merchantName: string; instructions: string };
  pricing: Pricing;
  general: { open: boolean; setupComplete: boolean; retentionDays: number; launcherBaseUrl: string };
}
