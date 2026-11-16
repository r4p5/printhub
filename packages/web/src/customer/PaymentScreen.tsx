import { useState } from 'react';
import { api, rupees } from '../lib/api';
import type { JobView, Session } from './types';

export function PaymentScreen({ job, session, onJob }: { job: JobView; session: Session; onJob: (j: JobView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const headers = { 'x-job-token': session.token };
  const pay = job.payment!;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onJob(await api<JobView>(`/api/jobs/${session.jobId}/status`, { headers }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const markPaid = () => run(() => api(`/api/jobs/${session.jobId}/payment-pending`, { method: 'POST', headers }));
  // Re-saving the current configuration unlocks the order for editing.
  const edit = () =>
    run(() =>
      api(`/api/jobs/${session.jobId}/estimate`, {
        method: 'POST',
        headers,
        body: { documents: job.documents.map((d) => ({ id: d.id, options: d.options })) },
      }),
    );

  return (
    <div className="space-y-3">
      <div className="card text-center">
        <p className="text-sm text-slate-500">Amount to pay</p>
        <p className="mt-1 text-4xl font-bold tracking-tight">{rupees(pay.amount)}</p>
        <p className="mt-2 text-xs text-slate-500">
          {job.estimate?.totalPages} pages · ~{job.estimate?.totalSheets} sheets · {job.documents.length} document{job.documents.length === 1 ? '' : 's'}
        </p>
        <a href={pay.upiUri} onClick={() => setOpened(true)} className="btn-primary mt-4 w-full py-3 text-base">
          Pay with UPI app
        </a>
        <p className="mt-3 text-xs text-slate-500">
          Payment note: <span className="font-mono font-semibold text-slate-800">{pay.reference}</span>
        </p>
        {pay.instructions && <p className="mt-2 whitespace-pre-line text-left text-sm text-slate-700">{pay.instructions}</p>}
      </div>

      <div className="card space-y-2">
        <p className="text-sm">{opened ? 'Finished paying in your UPI app?' : 'After paying, come back here and tap below.'}</p>
        <button className="btn-primary w-full" disabled={busy} onClick={markPaid}>I have paid {rupees(pay.amount)}</button>
        <p className="text-xs text-slate-500">The shopkeeper checks the payment before printing starts.</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      <button className="btn-secondary w-full" disabled={busy} onClick={edit}>Change documents or options</button>
    </div>
  );
}
