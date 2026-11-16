import { useState } from 'react';
import { rupees } from '../lib/api';
import { adminApi } from './client';
import type { AdminJob } from './types';

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATE_LABEL: Record<string, string> = {
  awaiting_payment: 'Waiting for customer to pay',
  payment_pending: 'Customer says paid',
  queued: 'Queued',
  processing: 'Preparing',
  printing: 'Printing',
  completed: 'Printed',
  failed: 'Failed',
  manual_review: 'Needs your decision',
  cancelled: 'Cancelled',
};

export function OrderCard({ job, onChange }: { job: AdminJob; onChange: () => void }) {
  const [amount, setAmount] = useState(job.total != null ? (job.total / 100).toFixed(2) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi(`/api/admin/jobs/${job.id}${path}`, { method: 'POST', body });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifiable = job.state === 'awaiting_payment' || job.state === 'payment_pending';
  const mismatch = job.state === 'manual_review' && job.amountReceived != null && job.tasks.length === 0;
  const docName = (id: string) => job.documents.find((d) => d.id === id)?.name ?? 'Document';

  return (
    <article className="card space-y-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg font-bold tracking-wider">{job.code}</span>
          <span className="text-sm font-semibold">{rupees(job.total)}</span>
        </div>
        <span className="text-xs text-slate-500">{STATE_LABEL[job.state] ?? job.state} · {time(job.createdAt)}</span>
      </header>
      <p className="text-xs text-slate-600">
        {job.documents.length} document{job.documents.length === 1 ? '' : 's'} · {job.estimate?.totalPages} pages · ~{job.estimate?.totalSheets} sheets · UPI note <span className="font-mono">PRINT-{job.code}</span>
      </p>

      {verifiable && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-amber-50 p-2">
          <label className="text-xs">
            <span className="label">Amount received (check your UPI app)</span>
            <input className="input w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
          <button className="btn-primary" disabled={busy || !amount} onClick={() => act('/verify-payment', { amountReceived: Math.round(Number(amount) * 100) })}>
            Confirm payment & print
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => act('/cancel', undefined, `Cancel order ${job.code}?`)}>Cancel</button>
        </div>
      )}

      {mismatch && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm">
          <span>Received {rupees(job.amountReceived)} but the order is {rupees(job.total)}.</span>
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => act('/verify-payment', { amountReceived: job.amountReceived, force: true }, 'Print this order anyway?')}>Print anyway</button>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act('/cancel', undefined, `Cancel order ${job.code}?`)}>Cancel order</button>
        </div>
      )}

      {job.tasks.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {job.tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate">{docName(t.documentId)}</span>
              <span className="text-xs text-slate-500">
                {t.state}{t.printerName ? ` · ${t.printerName}` : ''}{t.error ? ` · ${t.error}` : ''}
              </span>
              {(t.state === 'manual_review' || t.state === 'failed') && (
                <span className="flex gap-1">
                  {/* Never guess: the shopkeeper looks at the tray and decides. */}
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(`/tasks/${t.id}/resolve`, { outcome: 'printed' })}>It printed</button>
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(`/tasks/${t.id}/resolve`, { outcome: 'reprint' }, 'Send this document to the printer again?')}>Print again</button>
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(`/tasks/${t.id}/resolve`, { outcome: 'cancel' })}>Skip</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {job.state === 'queued' && (
        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act('/cancel', undefined, `Cancel order ${job.code}? Refund the customer separately.`)}>Cancel order</button>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </article>
  );
}

export function OrderGroups({ jobs, onChange }: { jobs: AdminJob[]; onChange: () => void }) {
  const groups: [string, AdminJob[]][] = [
    ['Check payment', jobs.filter((j) => j.state === 'payment_pending' || j.state === 'awaiting_payment')],
    ['Needs attention', jobs.filter((j) => j.state === 'manual_review' || j.state === 'failed')],
    ['In progress', jobs.filter((j) => ['queued', 'processing', 'printing', 'payment_verified'].includes(j.state))],
    ['Recent', jobs.filter((j) => j.state === 'completed' || j.state === 'cancelled').slice(0, 15)],
  ];
  return (
    <div className="space-y-5">
      {groups.map(([title, list]) =>
        list.length === 0 ? null : (
          <section key={title}>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{title} <span className="text-slate-400">({list.length})</span></h3>
            <div className="space-y-2">{list.map((j) => <OrderCard key={j.id} job={j} onChange={onChange} />)}</div>
          </section>
        ),
      )}
      {jobs.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No orders yet. Customers scan your QR code to start.</p>}
    </div>
  );
}
