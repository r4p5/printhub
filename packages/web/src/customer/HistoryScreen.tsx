import { useEffect, useState } from 'react';
import type { JobState } from '@printhub/shared';
import { api, rupees } from '../lib/api';
import { clearHistory, forgetOrder, listOrders, updateOrder, type HistoryOrder } from './history';
import type { JobView } from './types';

const FINAL: JobState[] = ['completed', 'cancelled', 'failed'];

const BADGE: Partial<Record<JobState, [string, string]>> = {
  completed: ['Printed', 'bg-green-100 text-green-800'],
  cancelled: ['Cancelled', 'bg-slate-200 text-slate-700'],
  failed: ['Failed', 'bg-red-100 text-red-800'],
  manual_review: ['Being checked', 'bg-amber-100 text-amber-800'],
  awaiting_payment: ['Not paid', 'bg-amber-100 text-amber-800'],
  payment_pending: ['Payment sent', 'bg-blue-100 text-blue-800'],
  uploaded: ['Draft', 'bg-slate-100 text-slate-600'],
};
const badge = (s: JobState): [string, string] => BADGE[s] ?? ['In progress', 'bg-blue-100 text-blue-800'];

const when = (ms: number) =>
  new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function HistoryScreen({ shop, onOpen, onPrintAgain, onNewOrder }: {
  shop: string;
  onOpen: (o: HistoryOrder) => void;
  onPrintAgain: (o: HistoryOrder) => Promise<void>;
  onNewOrder: () => void;
}) {
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const list = await listOrders(shop);
      if (!live) return;
      setOrders(list);
      // Refresh orders that may have moved on since last seen; one request at a time keeps it light.
      for (const o of list.filter((x) => !FINAL.includes(x.state)).slice(0, 10)) {
        try {
          const v = await api<JobView>(`/api/jobs/${o.jobId}/status`, { headers: { 'x-job-token': o.token } });
          await updateOrder(o.jobId, { state: v.state, total: v.total });
          if (live) setOrders((cur) => cur?.map((x) => (x.jobId === o.jobId ? { ...x, state: v.state, total: v.total } : x)) ?? cur);
        } catch {
          /* shop offline or order purged: keep the last known state */
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [shop]);

  const again = async (o: HistoryOrder) => {
    setBusy(o.jobId);
    setError(null);
    try {
      await onPrintAgain(o);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (o: HistoryOrder) => {
    await forgetOrder(o.jobId);
    setOrders((cur) => cur?.filter((x) => x.jobId !== o.jobId) ?? cur);
  };

  if (!orders) return <div className="h-40 animate-pulse rounded-xl bg-slate-100" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">My orders</h2>
        <button className="btn-primary btn-sm" onClick={onNewOrder}>+ New order</button>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      {orders.length === 0 && <p className="card text-center text-sm text-slate-500">No orders yet on this phone.</p>}
      {orders.map((o) => {
        const [label, tone] = badge(o.state);
        const pages = o.docs.reduce((s, d) => s + d.pages * d.options.copies, 0);
        const saved = o.docs.filter((d) => d.fileKey).length;
        return (
          <article key={o.jobId} className="card space-y-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono font-bold tracking-wider">{o.code}</p>
                <p className="text-xs text-slate-500">{when(o.createdAt)} · {rupees(o.total)}</p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
            </div>
            <ul className="text-sm text-slate-700">
              {o.docs.map((d, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate">{d.name}</span>
                  <span className="shrink-0 text-xs text-slate-500">{d.pages}p × {d.options.copies}{d.options.color === 'color' ? ' · color' : ''}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">{pages} pages total</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary btn-sm" disabled={saved === 0 || busy !== null} onClick={() => again(o)}>
                {busy === o.jobId ? 'Preparing…' : 'Print again'}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => onOpen(o)}>View status</button>
              <button className="btn-secondary btn-sm" onClick={() => remove(o)} aria-label={`Remove order ${o.code} from this phone`}>Remove</button>
            </div>
            {saved < o.docs.length && (
              <p className="text-xs text-amber-700">
                {saved === 0 ? 'Documents are no longer saved on this phone; upload them again to reprint.' : `${o.docs.length - saved} document(s) are no longer saved on this phone.`}
              </p>
            )}
          </article>
        );
      })}
      {orders.length > 0 && (
        <button
          className="w-full text-center text-xs text-slate-500 underline"
          onClick={async () => {
            if (!confirm('Remove all orders and saved documents from this phone?')) return;
            await clearHistory(shop);
            setOrders([]);
          }}
        >
          Clear history on this phone
        </button>
      )}
      <p className="text-center text-xs text-slate-400">Order history and document copies are stored only on this phone.</p>
    </div>
  );
}
