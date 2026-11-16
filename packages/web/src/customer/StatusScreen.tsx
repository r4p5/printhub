import { useEffect } from 'react';
import type { JobState } from '@printhub/shared';
import { api, rupees, subscribe } from '../lib/api';
import type { JobView, Session } from './types';

const STEPS: { label: string; states: JobState[] }[] = [
  { label: 'Paid', states: ['payment_pending'] },
  { label: 'Confirmed', states: ['payment_verified', 'queued'] },
  { label: 'Printing', states: ['processing', 'printing'] },
  { label: 'Ready', states: ['completed'] },
];

const FINAL: JobState[] = ['completed', 'cancelled', 'failed'];

export function StatusScreen({ job, session, onJob, onNewOrder }: { job: JobView; session: Session; onJob: (j: JobView) => void; onNewOrder: () => void }) {
  const done = FINAL.includes(job.state);

  useEffect(() => {
    if (done) return;
    const headers = { 'x-job-token': session.token };
    const refresh = () => api<JobView>(`/api/jobs/${session.jobId}/status`, { headers }).then(onJob).catch(() => {});
    // Push updates while open; a refresh on return covers phones that suspended the connection.
    const close = subscribe(`/api/jobs/${session.jobId}/events?token=${encodeURIComponent(session.token)}`, { status: () => void refresh() });
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session.jobId, done]);

  const stepIndex = STEPS.findIndex((s) => s.states.includes(job.state));
  const tone = job.state === 'completed' ? 'bg-green-50 text-green-800' : job.state === 'failed' || job.state === 'cancelled' ? 'bg-red-50 text-red-800' : job.state === 'manual_review' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-800';

  return (
    <div className="space-y-3">
      <div className="card text-center">
        <p className="text-xs uppercase tracking-wide text-slate-500">Your order code</p>
        <p className="mt-1 font-mono text-4xl font-bold tracking-widest">{job.code}</p>
        <p className="mt-1 text-xs text-slate-500">Show this to the shopkeeper</p>
        <p className={`mt-4 rounded-lg px-3 py-2 text-sm font-medium ${tone}`} aria-live="polite">{job.stateText}</p>
        {stepIndex >= 0 && (
          <ol className="mt-4 grid grid-cols-4 gap-1 text-[11px]">
            {STEPS.map((s, i) => (
              <li key={s.label} className="flex flex-col items-center gap-1">
                <span className={`h-1.5 w-full rounded ${i <= stepIndex ? 'bg-slate-900' : 'bg-slate-200'}`} />
                <span className={i <= stepIndex ? 'font-semibold' : 'text-slate-500'}>{s.label}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="card">
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">Total</span>
          <span className="font-semibold">{rupees(job.total)}</span>
        </div>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {job.documents.map((d) => (
            <li key={d.id} className="flex justify-between gap-2 py-1.5">
              <span className="truncate">{d.name}</span>
              <span className="shrink-0 text-slate-500">{d.pages}p × {d.options.copies}</span>
            </li>
          ))}
        </ul>
      </div>
      {done && <button className="btn-primary w-full" onClick={onNewOrder}>Start a new order</button>}
    </div>
  );
}
