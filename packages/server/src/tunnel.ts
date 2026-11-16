import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EventHub } from './events.ts';
import { log } from './log.ts';
import type { Settings } from './settings.ts';

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const CONNECTED = /Registered tunnel connection/;
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
// Re-announce occasionally in case the directory lost the record; KV writes are rationed on the free plan.
const REANNOUNCE_MS = 12 * 3600_000;

export type TunnelState = 'off' | 'starting' | 'online' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  registered: boolean;
  error: string | null;
}

/**
 * Runs cloudflared so customers can reach this PC from any network. cloudflared only makes
 * outbound connections (no router or firewall changes) and forwards to the loopback-only
 * public listener, which serves customer routes and nothing else.
 *
 * Runs only while the shop is open for orders, so an idle shop has no tunnel process at all.
 */
export class Tunnel {
  private proc: ChildProcess | null = null;
  private status: TunnelStatus = { state: 'off', url: null, registered: false, error: null };
  private restartDelay = RESTART_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private wanted = false;
  private settings: Settings;
  private hub: EventHub;
  private binary: string | null;
  private localUrl: string;
  private directoryUrl: string;

  constructor(settings: Settings, hub: EventHub, binary: string | null, localUrl: string, directoryUrl: string) {
    this.settings = settings;
    this.hub = hub;
    this.binary = binary;
    this.localUrl = localUrl;
    this.directoryUrl = directoryUrl;
  }

  get(): TunnelStatus {
    return { ...this.status };
  }

  /** Brings the process in line with settings; call after any settings change. */
  sync() {
    const online = this.settings.get('online');
    const general = this.settings.get('general');
    const want = online.enabled && general.setupComplete && general.open && this.settings.get('shop') !== null;
    if (want && !this.binary) {
      this.set({ state: 'error', error: 'cloudflared is not installed' });
      return;
    }
    if (want === this.wanted && (this.proc || this.restartTimer)) return;
    this.wanted = want;
    this.stopProcess();
    if (want) this.startProcess();
    else this.set({ state: 'off', url: null, registered: false, error: null });
  }

  /** Restarts with the current settings (e.g. after switching between quick and named). */
  restart() {
    this.wanted = false;
    this.stopProcess();
    this.sync();
  }

  async close() {
    this.wanted = false;
    this.stopProcess();
  }

  private startProcess() {
    const online = this.settings.get('online');
    const args =
      online.mode === 'named'
        ? ['tunnel', '--no-autoupdate', 'run', '--token', online.namedToken]
        : ['tunnel', '--no-autoupdate', '--url', this.localUrl];
    this.set({ state: 'starting', url: online.mode === 'named' ? online.publicUrl : null, registered: false, error: null });
    const proc = spawn(this.binary!, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    // cloudflared logs to stderr; only scan for the two lines that matter.
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      if (this.proc !== proc) return;
      const quick = online.mode === 'quick' ? QUICK_URL.exec(line) : null;
      if (quick && quick[0] !== this.status.url) {
        this.set({ url: quick[0] });
        void this.announce();
      }
      if (CONNECTED.test(line) && this.status.state !== 'online') {
        this.restartDelay = RESTART_MIN_MS;
        if (online.mode === 'named') void this.announce();
        else if (this.status.registered) this.set({ state: 'online' });
      }
    });
    proc.on('error', (e) => this.onExit(proc, e.message));
    proc.on('exit', (code) => this.onExit(proc, `cloudflared exited (${code})`));
  }

  private onExit(proc: ChildProcess, reason: string) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (!this.wanted) return;
    log.warn('tunnel stopped, restarting', { reason, inMs: this.restartDelay });
    this.set({ state: 'error', error: reason, registered: false });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) this.startProcess();
    }, this.restartDelay);
    this.restartTimer.unref();
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
  }

  private stopProcess() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.restartTimer = this.announceTimer = null;
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  /** Tells the directory where this shop can be reached now. Retries until it succeeds. */
  private async announce(attempt = 0): Promise<void> {
    const url = this.status.url;
    const shop = this.settings.get('shop');
    if (!url || !shop || !this.wanted) return;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    try {
      const res = await fetch(`${this.directoryUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.settings.get('online').directorySecret}` },
        body: JSON.stringify({ mobile: shop.mobileNumber, url }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403) {
        // Another installation owns this number in the directory; retrying cannot help.
        this.set({ state: 'error', registered: false, error: 'This mobile number is registered to another PrintHub installation' });
        return;
      }
      if (!res.ok) throw new Error(`directory responded ${res.status}`);
      if (this.status.url !== url) return; // superseded by a newer address
      log.info('tunnel online', { url });
      this.set({ state: 'online', registered: true, error: null });
      this.announceTimer = setTimeout(() => void this.announce(), REANNOUNCE_MS);
    } catch (e) {
      const delay = Math.min(5_000 * 2 ** attempt, 5 * 60_000);
      this.set({ registered: false, error: `Could not register online address: ${(e as Error).message}` });
      this.announceTimer = setTimeout(() => void this.announce(attempt + 1), delay);
    }
    this.announceTimer?.unref();
  }

  private set(patch: Partial<TunnelStatus>) {
    this.status = { ...this.status, ...patch };
    this.hub.publish('admin', 'tunnel', this.get());
  }
}
