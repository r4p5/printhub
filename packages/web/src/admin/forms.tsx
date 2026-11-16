import { useEffect, useState } from 'react';
import { MOBILE_RE, type Pricing } from '@printhub/shared';
import { adminApi } from './client';
import type { AllSettings, Printer } from './types';

export function useSave() {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const run = async (fn: () => Promise<unknown>) => {
    setState({ busy: true, error: null, saved: false });
    try {
      await fn();
      setState({ busy: false, error: null, saved: true });
      return true;
    } catch (e) {
      setState({ busy: false, error: (e as Error).message, saved: false });
      return false;
    }
  };
  return { ...state, run };
}

export function Status({ error, saved }: { error: string | null; saved?: boolean }) {
  if (error) return <p className="text-sm text-red-600" role="alert">{error}</p>;
  if (saved) return <p className="text-sm text-green-700">Saved</p>;
  return null;
}

const toRupees = (p: number | null) => (p == null ? '' : (p / 100).toString());
const toPaise = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100));

function Money({ label, value, onChange, optional }: { label: string; value: string; onChange: (v: string) => void; optional?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}{optional && <span className="text-slate-400"> (optional)</span>}</span>
      <div className="relative">
        <span className="absolute left-3 top-2 text-sm text-slate-500">₹</span>
        <input className="input pl-7" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} />
      </div>
    </label>
  );
}

export function ShopForm({ settings, onSaved }: { settings: AllSettings; onSaved: () => void }) {
  const [name, setName] = useState(settings.shop?.shopName ?? '');
  const [mobile, setMobile] = useState(settings.shop?.mobileNumber ?? '');
  const s = useSave();
  const valid = name.trim() && MOBILE_RE.test(mobile);
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), s.run(() => adminApi('/api/shop/config', { method: 'PUT', body: { shop: { shopName: name, mobileNumber: mobile } } })).then((ok) => ok && onSaved()))}>
      <label className="block"><span className="label">Shop name</span><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required /></label>
      <label className="block">
        <span className="label">Mobile number</span>
        <input className="input" inputMode="numeric" value={mobile} maxLength={10} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} required />
        <span className="mt-1 block text-xs text-slate-500">Used in your shop's QR link. It is public, not a password.</span>
      </label>
      <Status error={s.error} saved={s.saved} />
      <button className="btn-primary" disabled={!valid || s.busy}>Save</button>
    </form>
  );
}

export function PricingForm({ pricing, onSaved }: { pricing: Pricing; onSaved: () => void }) {
  const [v, setV] = useState({
    bw: toRupees(pricing.bwPerSide), color: toRupees(pricing.colorPerSide), bwDuplex: toRupees(pricing.bwDuplexPerSide),
    colorDuplex: toRupees(pricing.colorDuplexPerSide), min: toRupees(pricing.minimumOrder), maxCopies: String(pricing.maxCopies),
  });
  const s = useSave();
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  const submit = () =>
    s.run(() => adminApi('/api/pricing', { method: 'PUT', body: {
      bwPerSide: toPaise(v.bw) ?? 0, colorPerSide: toPaise(v.color) ?? 0, bwDuplexPerSide: toPaise(v.bwDuplex), colorDuplexPerSide: toPaise(v.colorDuplex),
      minimumOrder: toPaise(v.min) ?? 0, maxCopies: Number(v.maxCopies) || 1,
    } })).then((ok) => ok && onSaved());
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Money label="B&W per printed side" value={v.bw} onChange={set('bw')} />
        <Money label="Color per printed side" value={v.color} onChange={set('color')} />
        <Money label="B&W per side when double-sided" value={v.bwDuplex} onChange={set('bwDuplex')} optional />
        <Money label="Color per side when double-sided" value={v.colorDuplex} onChange={set('colorDuplex')} optional />
        <Money label="Minimum order" value={v.min} onChange={set('min')} />
        <label className="block"><span className="label">Maximum copies</span><input className="input" inputMode="numeric" value={v.maxCopies} onChange={(e) => set('maxCopies')(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <p className="text-xs text-slate-500">Price changes apply to new orders only; orders already priced keep their price.</p>
      <Status error={s.error} saved={s.saved} />
      <button className="btn-primary" disabled={s.busy}>Save pricing</button>
    </form>
  );
}

export function PaymentForm({ payment, onSaved }: { payment: AllSettings['payment']; onSaved: () => void }) {
  const [v, setV] = useState(payment);
  const s = useSave();
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), s.run(() => adminApi('/api/admin/payment', { method: 'PUT', body: v })).then((ok) => ok && onSaved()))}>
      <label className="block"><span className="label">UPI ID</span><input className="input" placeholder="shopname@okbank" value={v.upiId} onChange={(e) => setV({ ...v, upiId: e.target.value.trim() })} required /></label>
      <label className="block"><span className="label">Name shown in UPI apps</span><input className="input" maxLength={50} value={v.merchantName} onChange={(e) => setV({ ...v, merchantName: e.target.value })} /></label>
      <label className="block"><span className="label">Payment instructions for customers</span><textarea className="input" rows={3} maxLength={500} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} /></label>
      <Status error={s.error} saved={s.saved} />
      <button className="btn-primary" disabled={s.busy}>Save payment details</button>
    </form>
  );
}

const STATUS_STYLE: Record<Printer['status'], string> = {
  ready: 'bg-green-100 text-green-800',
  busy: 'bg-blue-100 text-blue-800',
  offline: 'bg-slate-200 text-slate-700',
  error: 'bg-red-100 text-red-800',
  unknown: 'bg-slate-100 text-slate-600',
};

export function PrinterList({ printers, onChange }: { printers: Printer[]; onChange: () => void }) {
  const s = useSave();
  const [tested, setTested] = useState<string | null>(null);
  // Discover once when the list is first shown empty.
  useEffect(() => {
    if (printers.length === 0) void s.run(() => adminApi('/api/printers/discover', { method: 'POST' })).then(onChange);
  }, []);
  const update = (p: Printer, body: Partial<Printer>) => s.run(() => adminApi(`/api/printers/${p.id}`, { method: 'PUT', body })).then(onChange);
  const test = (p: Printer) => s.run(() => adminApi(`/api/printers/${p.id}/test`, { method: 'POST' })).then((ok) => ok && setTested(p.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">Printers installed in Windows. Customers never see these names.</p>
        <button className="btn-secondary btn-sm" disabled={s.busy} onClick={() => s.run(() => adminApi('/api/printers/discover', { method: 'POST' })).then(onChange)}>
          {s.busy ? 'Working…' : 'Refresh'}
        </button>
      </div>
      <Status error={s.error} />
      {printers.length === 0 && !s.busy && <p className="text-sm text-slate-500">No printers found. Install the printer in Windows Settings, then press Refresh.</p>}
      {printers.map((p) => (
        <div key={p.id} className={`card ${p.enabled ? '' : 'opacity-80'}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">{p.name}</p>
              <p className="text-xs text-slate-500">
                {p.caps.color ? 'Color' : 'B&W only'} · {p.caps.duplex ? 'Double-sided' : 'Single-sided only'}
                {p.caps.virtual && ' · virtual (not a real printer)'}
              </p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status]}`}>{p.statusDetail ?? p.status}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={p.enabled} disabled={!p.present} onChange={(e) => update(p, { enabled: e.target.checked })} />
              Use for customer orders
            </label>
            <label className="text-sm">
              <span className="label">Prints</span>
              <select className="input py-1.5" value={p.role} onChange={(e) => update(p, { role: e.target.value as Printer['role'] })}>
                <option value="bw">B&W orders</option>
                {p.caps.color && <option value="color">Color orders</option>}
                {p.caps.color && <option value="any">Both</option>}
              </select>
            </label>
            <label className="text-sm">
              <span className="label">Use as</span>
              <select className="input py-1.5" value={p.priority === 0 ? 0 : 1} onChange={(e) => update(p, { priority: Number(e.target.value) })}>
                <option value={0}>Primary</option>
                <option value={1}>Backup</option>
              </select>
            </label>
            <button className="btn-secondary btn-sm" disabled={s.busy || !p.present} onClick={() => test(p)}>{tested === p.id ? 'Test page sent' : 'Test print'}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
