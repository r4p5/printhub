import type { ServerResponse } from 'node:http';

const MAX_CLIENTS = 200;
const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events hub. Cheaper than WebSockets (no extra dependency, plain HTTP) and the
 * browser's EventSource reconnects automatically. One shared heartbeat timer runs only
 * while at least one client is connected.
 */
export class EventHub {
  private channels = new Map<string, Set<ServerResponse>>();
  private count = 0;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(channel: string, event: string, data: unknown) => void>();

  /** In-process subscribers (the desktop shell's tray notifications). */
  listen(fn: (channel: string, event: string, data: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribe(channel: string, res: ServerResponse): boolean {
    if (this.count >= MAX_CLIENTS) return false;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(res);
    this.count++;
    this.ensureTimer();
    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.channels.delete(channel);
      this.count--;
      if (this.count === 0) this.stopTimer();
    });
    return true;
  }

  publish(channel: string, event: string, data: unknown) {
    for (const fn of this.listeners) fn(channel, event, data);
    const set = this.channels.get(channel);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(msg);
  }

  closeAll() {
    for (const set of this.channels.values()) for (const res of set) res.end();
    this.channels.clear();
    this.stopTimer();
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const set of this.channels.values()) for (const res of set) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
