import { useState } from 'react';
import { adminApi } from './client';
import { PaymentForm, PricingForm, PrinterList, ShopForm, Status, useSave } from './forms';
import { QrPanel } from './QrPanel';
import type { AllSettings, Overview } from './types';

const STEPS = ['Shop', 'Printers', 'Pricing', 'Payment', 'QR code', 'Activate'];

export function SetupWizard({ settings, overview, reload }: { settings: AllSettings; overview: Overview; reload: () => Promise<void> }) {
  const [step, setStep] = useState(settings.shop ? 1 : 0);
  const activate = useSave();
  const next = async () => {
    await reload();
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const enabled = overview.printers.filter((p) => p.enabled && p.present);

  const checks = [
    { ok: !!settings.shop, label: 'Shop name and mobile number' },
    { ok: enabled.length > 0, label: `At least one printer enabled (${enabled.length})` },
    { ok: !!settings.payment.upiId, label: 'UPI ID' },
    { ok: overview.server.addresses.length > 0, label: `Connected to a local network (${overview.server.addresses[0]?.address ?? 'not connected'})` },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-xl font-bold">Set up PrintHub</h1>
      <ol className="flex flex-wrap gap-1 text-xs">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button className={`rounded-full px-3 py-1 ${i === step ? 'bg-slate-900 text-white' : i < step ? 'bg-slate-200' : 'bg-slate-100 text-slate-500'}`} onClick={() => setStep(i)}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>
      <div className="card">
        {step === 0 && <ShopForm settings={settings} onSaved={next} />}
        {step === 1 && (
          <div className="space-y-3">
            <PrinterList printers={overview.printers} onChange={reload} />
            <button className="btn-primary" disabled={enabled.length === 0} onClick={next}>Continue</button>
          </div>
        )}
        {step === 2 && <PricingForm pricing={settings.pricing} onSaved={next} />}
        {step === 3 && <PaymentForm payment={settings.payment} onSaved={next} />}
        {step === 4 && (
          <div className="space-y-3">
            <QrPanel overview={overview} shopName={settings.shop?.shopName ?? ''} />
            <button className="btn-primary" onClick={next}>Continue</button>
          </div>
        )}
        {step === 5 && (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {checks.map((c) => (
                <li key={c.label} className={c.ok ? 'text-green-700' : 'text-red-700'}>{c.ok ? '✓' : '✗'} {c.label}</li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">
              Test from a phone on the same Wi-Fi: open <span className="font-mono">{overview.directUrl ?? '—'}</span>. If it doesn't load, allow PrintHub through Windows Firewall for private networks.
            </p>
            <Status error={activate.error} />
            <button className="btn-primary" disabled={activate.busy || !checks.every((c) => c.ok)}
              onClick={() => activate.run(() => adminApi('/api/admin/setup/complete', { method: 'POST' })).then((ok) => { if (ok) return reload(); })}>
              Start accepting orders
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
