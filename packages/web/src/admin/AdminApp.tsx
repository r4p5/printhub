import { useCallback, useEffect, useRef, useState } from 'react';
import { rupees, subscribe } from '../lib/api';
import { adminApi, adminToken } from './client';
import { PaymentForm, PricingForm, PrinterList, ShopForm } from './forms';
import { OrderGroups } from './Orders';
import { QrPanel } from './QrPanel';
import { SetupWizard } from './SetupWizard';
import type { AdminJob, AllSettings, Overview } from './types';

const TABS = ['Orders', 'Printers', 'Pricing & payment', 'Shop & QR'] as const;
type Tab = (typeof TABS)[number];

/** Short two-tone chime; no audio file to ship. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.15);
      o.stop(ctx.currentTime + i * 0.15 + 0.3);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {}
}

export function AdminApp() {
  const [settings, setSettings] = useState<AllSettings | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [tab, setTab] = useState<Tab>('Orders');
  const [error, setError] = useState<string | null>(null);
  const pendingSeen = useRef<Set<string> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, o, j] = await Promise.all([
        adminApi<AllSettings>('/api/admin/settings'),
        adminApi<Overview>('/api/admin/overview'),
        adminApi<AdminJob[]>('/api/admin/jobs?limit=150'),
      ]);
      setSettings(s);
      setOverview(o);
      setJobs(j);
      setError(null);
      // Chime when a customer reports a new payment (not on first load).
      const pending = new Set(j.filter((x) => x.state === 'payment_pending').map((x) => x.id));
      if (pendingSeen.current && [...pending].some((id) => !pendingSeen.current!.has(id))) chime();
      pendingSeen.current = pending;
      const attention = j.filter((x) => ['payment_pending', 'manual_review', 'failed'].includes(x.state)).length;
      document.title = attention ? `(${attention}) PrintHub` : 'PrintHub';
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Server pushes events; coalesce bursts into one reload.
  useEffect(() => {
    void reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 250);
    };
    const close = subscribe(`/api/admin/events?token=${encodeURIComponent(adminToken)}`, { job: soon, printer: soon, settings: soon, alert: soon });
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [reload]);

  // Safety net for missed events (e.g. sleep/resume), cheap and infrequent; paused when hidden.
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === 'visible' && void reload(), 60_000);
    return () => clearInterval(id);
  }, [reload]);

  if (!adminToken) return <p className="p-6 text-sm">Open PrintHub from the desktop app.</p>;
  if (error && !overview) return <p className="p-6 text-sm text-red-700">Cannot reach the PrintHub server: {error}</p>;
  if (!settings || !overview) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  if (!settings.general.setupComplete) return <SetupWizard settings={settings} overview={overview} reload={reload} />;

  const toggleOpen = async () => {
    await adminApi('/api/shop/config', { method: 'PUT', body: { general: { open: !settings.general.open } } });
    void reload();
  };
  const c = overview.counts;
  const stats: [string, string | number][] = [
    ['Today’s orders', overview.todayOrders],
    ['Today’s revenue', rupees(overview.todayRevenue)],
    ['Waiting', (c.queued ?? 0) + (c.payment_pending ?? 0)],
    ['Printing', (c.processing ?? 0) + (c.printing ?? 0)],
    ['Failed / review', (c.failed ?? 0) + (c.manual_review ?? 0)],
  ];

  return (
    <div className="mx-auto max-w-5xl p-4 print:p-0">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold">{settings.shop?.shopName}</h1>
          <p className="text-xs text-slate-500">
            Server on {overview.server.addresses[0]?.address ?? 'no network'}:{overview.server.port} · {overview.server.memoryMb} MB · v{overview.server.version}
          </p>
        </div>
        <button onClick={toggleOpen} className={`btn ${settings.general.open ? 'bg-green-600 text-white hover:bg-green-500' : 'bg-slate-300 text-slate-800 hover:bg-slate-400'}`}>
          {settings.general.open ? '● Open for orders' : '○ Closed — click to open'}
        </button>
      </header>

      {error && <p className="mb-3 rounded-lg bg-red-50 p-2 text-sm text-red-700 print:hidden">Connection problem: {error}</p>}
      {overview.printers.some((p) => p.enabled && (p.status === 'error' || p.status === 'offline')) && (
        <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 print:hidden">
          {overview.printers.filter((p) => p.enabled && (p.status === 'error' || p.status === 'offline')).map((p) => (
            <p key={p.id}><strong>{p.name}:</strong> {p.statusDetail ?? p.status}</p>
          ))}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5 print:hidden">
        {stats.map(([k, v]) => (
          <div key={k} className="card p-3">
            <p className="text-xs text-slate-500">{k}</p>
            <p className="text-lg font-bold">{v}</p>
          </div>
        ))}
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${t === tab ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Orders' && <OrderGroups jobs={jobs} onChange={reload} />}
      {tab === 'Printers' && <PrinterList printers={overview.printers} onChange={reload} />}
      {tab === 'Pricing & payment' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card"><h2 className="mb-3 font-semibold">Pricing</h2><PricingForm pricing={settings.pricing} onSaved={reload} /></div>
          <div className="card"><h2 className="mb-3 font-semibold">UPI payment</h2><PaymentForm payment={settings.payment} onSaved={reload} /></div>
        </div>
      )}
      {tab === 'Shop & QR' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card print:border-0 print:shadow-none"><h2 className="mb-3 font-semibold print:hidden">Customer QR code</h2><QrPanel overview={overview} shopName={settings.shop?.shopName ?? ''} /></div>
          <div className="space-y-4 print:hidden">
            <div className="card"><h2 className="mb-3 font-semibold">Shop details</h2><ShopForm settings={settings} onSaved={reload} /></div>
            <div className="card text-xs text-slate-600">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">Storage</h2>
              <p>Data folder: <span className="font-mono">{overview.server.dataDir}</span></p>
              <p>Free disk: {overview.server.diskFreeBytes != null ? `${(overview.server.diskFreeBytes / 1073741824).toFixed(1)} GB` : '—'}</p>
              <p>Files of failed orders are kept {settings.general.retentionDays} days; printed files are deleted right away.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
