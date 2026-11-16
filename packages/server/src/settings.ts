import { randomBytes } from 'node:crypto';
import { MOBILE_RE, type Pricing } from '@printhub/shared';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

export interface ShopSettings {
  shopName: string;
  mobileNumber: string;
}
export interface PaymentSettings {
  upiId: string;
  merchantName: string;
  instructions: string;
}
export interface GeneralSettings {
  /** Customers can submit jobs only while open (and once setup is complete). */
  open: boolean;
  setupComplete: boolean;
  /** Days to keep files of failed / uncertain jobs before automatic cleanup. */
  retentionDays: number;
  /** Base URL of the static launcher, e.g. https://r4p5.github.io */
  launcherBaseUrl: string;
}

export interface OnlineSettings {
  /** Expose customer pages to the internet through Cloudflare. */
  enabled: boolean;
  /** quick: free temporary trycloudflare.com address. named: permanent hostname on your own domain. */
  mode: 'quick' | 'named';
  namedToken: string;
  /** Public https URL of the named tunnel, e.g. https://9066191970.printhub.eu.org */
  publicUrl: string;
  /** Proves to the directory that this PC owns the shop's number. Never leaves this PC except to the directory. */
  directorySecret: string;
}

interface SettingsShape {
  shop: ShopSettings | null;
  payment: PaymentSettings;
  pricing: Pricing;
  general: GeneralSettings;
  online: OnlineSettings;
  adminToken: string;
}

const DEFAULTS: Omit<SettingsShape, 'adminToken'> = {
  shop: null,
  payment: { upiId: '', merchantName: '', instructions: '' },
  pricing: { bwPerSide: 200, colorPerSide: 1000, bwDuplexPerSide: null, colorDuplexPerSide: null, minimumOrder: 0, maxCopies: 50 },
  general: { open: false, setupComplete: false, retentionDays: 7, launcherBaseUrl: 'https://r4p5.github.io' },
  online: { enabled: true, mode: 'quick', namedToken: '', publicUrl: '', directorySecret: '' },
};

/** Small key/value store held in memory; reads are free, writes go straight to SQLite. */
export class Settings {
  private cache = new Map<string, unknown>();

  private db: Db;

  constructor(db: Db) {
    this.db = db;
    for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      this.cache.set(row.key, JSON.parse(row.value));
    }
    if (!this.cache.has('adminToken')) this.set('adminToken', randomBytes(24).toString('base64url'));
    if (!this.get('online').directorySecret) this.set('online', { ...this.get('online'), directorySecret: randomBytes(32).toString('base64url') });
  }

  get<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
    if (this.cache.has(key)) return this.cache.get(key) as SettingsShape[K];
    return structuredClone((DEFAULTS as SettingsShape)[key]);
  }

  set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) {
    this.db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    this.cache.set(key, value);
  }

  get acceptingJobs() {
    const g = this.get('general');
    return g.open && g.setupComplete && this.get('shop') !== null;
  }
}

// --- validation of admin input -----------------------------------------------------------

const str = (v: unknown, field: string, max: number, required = true): string => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  if (required && !s) throw new HttpError(400, `${field} is required`);
  return s;
};

const paise = (v: unknown, field: string, nullable = false): number | null => {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10_000_000) throw new HttpError(400, `${field} must be a whole number of paise`);
  return v as number;
};

export function validateShop(input: Record<string, unknown>): ShopSettings {
  const shopName = str(input.shopName, 'Shop name', 80);
  const mobileNumber = str(input.mobileNumber, 'Mobile number', 10);
  if (!MOBILE_RE.test(mobileNumber)) throw new HttpError(400, 'Mobile number must be a valid 10-digit Indian mobile number');
  return { shopName, mobileNumber };
}

export function validatePayment(input: Record<string, unknown>): PaymentSettings {
  const upiId = str(input.upiId, 'UPI ID', 100);
  if (!/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(upiId)) throw new HttpError(400, 'UPI ID looks invalid (expected name@bank)');
  return {
    upiId,
    merchantName: str(input.merchantName, 'Merchant name', 50, false),
    instructions: str(input.instructions, 'Payment instructions', 500, false),
  };
}

export function validatePricing(input: Record<string, unknown>): Pricing {
  const maxCopies = input.maxCopies;
  if (!Number.isInteger(maxCopies) || (maxCopies as number) < 1 || (maxCopies as number) > 999) throw new HttpError(400, 'Max copies must be 1-999');
  return {
    bwPerSide: paise(input.bwPerSide, 'B&W price')!,
    colorPerSide: paise(input.colorPerSide, 'Color price')!,
    bwDuplexPerSide: paise(input.bwDuplexPerSide, 'B&W duplex price', true),
    colorDuplexPerSide: paise(input.colorDuplexPerSide, 'Color duplex price', true),
    minimumOrder: paise(input.minimumOrder, 'Minimum order')!,
    maxCopies: maxCopies as number,
  };
}

export function validateGeneral(input: Record<string, unknown>, current: GeneralSettings): GeneralSettings {
  const out = { ...current };
  if (input.open !== undefined) out.open = input.open === true;
  if (input.retentionDays !== undefined) {
    if (!Number.isInteger(input.retentionDays) || (input.retentionDays as number) < 1 || (input.retentionDays as number) > 90) {
      throw new HttpError(400, 'Retention must be 1-90 days');
    }
    out.retentionDays = input.retentionDays as number;
  }
  if (input.launcherBaseUrl !== undefined) {
    const u = str(input.launcherBaseUrl, 'Launcher URL', 200);
    if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) throw new HttpError(400, 'Launcher URL must be https://');
    out.launcherBaseUrl = u.replace(/\/+$/, '');
  }
  return out;
}

export function validateOnline(input: Record<string, unknown>, current: OnlineSettings): OnlineSettings {
  const out = { ...current };
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.mode !== undefined) {
    if (input.mode !== 'quick' && input.mode !== 'named') throw new HttpError(400, 'Mode must be quick or named');
    out.mode = input.mode;
  }
  if (input.namedToken !== undefined) {
    const t = str(input.namedToken, 'Tunnel token', 4096, false);
    if (t && !/^[A-Za-z0-9+/=_-]{40,}$/.test(t)) throw new HttpError(400, 'Tunnel token looks invalid; paste the long token from the Cloudflare dashboard');
    out.namedToken = t;
  }
  if (input.publicUrl !== undefined) {
    const u = str(input.publicUrl, 'Public URL', 200, false).replace(/\/+$/, '');
    if (u && !/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new HttpError(400, 'Public URL must look like https://shop.example.com');
    out.publicUrl = u.toLowerCase();
  }
  if (out.enabled && out.mode === 'named' && (!out.namedToken || !out.publicUrl)) throw new HttpError(400, 'A permanent address needs both the tunnel token and its public URL');
  return out;
}
