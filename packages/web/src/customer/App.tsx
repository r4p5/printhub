import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { JobView, Session, ShopConfig } from './types';
import { loadSession, saveSession } from './session';
import { HOSTED, locateShop } from './locate';
import { OrderEditor } from './OrderEditor';
import { PaymentScreen } from './PaymentScreen';
import { StatusScreen } from './StatusScreen';

type Load = { kind: 'loading' } | { kind: 'error'; title: string; detail: string } | { kind: 'ready'; config: ShopConfig };

export function App() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [session, setSession] = useState<Session | null>(null);
  const [job, setJob] = useState<JobView | null>(null);

  useEffect(() => {
    void (async () => {
      const where = await locateShop();
      if (where.ok === 'redirecting') return;
      if (!where.ok) return setLoad({ kind: 'error', title: where.title, detail: where.detail });
      const wanted = where.mobile;
      try {
        const config = await api<ShopConfig>('/api/shop/config');
        if (!config.shopName || !config.mobileNumber) {
          setLoad({ kind: 'error', title: 'Shop not set up yet', detail: 'This shop has not finished setting up PrintHub.' });
        } else if (wanted && wanted !== config.mobileNumber) {
          setLoad({ kind: 'error', title: 'Wrong shop', detail: 'This QR code belongs to a different shop. Please scan the code at this counter.' });
        } else {
          document.title = `${config.shopName} · Print`;
          setSession(loadSession(config.mobileNumber));
          setLoad({ kind: 'ready', config });
        }
      } catch (e) {
        const offline = (e as ApiError).code === 'OFFLINE';
        setLoad({
          kind: 'error',
          title: offline ? (HOSTED ? 'Shop computer is offline' : 'Cannot reach the shop') : 'Something went wrong',
          detail: offline
            ? HOSTED
              ? "The shop's computer isn't responding right now. Please try again in a minute or ask at the counter."
              : "Connect your phone to the shop's Wi-Fi network, then try again."
            : (e as Error).message,
        });
      }
    })();
  }, []);

  // Restore an order after a reload or reopening the browser.
  useEffect(() => {
    if (!session) return setJob(null);
    api<JobView>(`/api/jobs/${session.jobId}/status`, { headers: { 'x-job-token': session.token } })
      .then(setJob)
      .catch(() => {
        saveSession(null);
        setSession(null);
      });
  }, [session]);

  const startOver = () => {
    saveSession(null);
    setSession(null);
    setJob(null);
  };

  if (load.kind === 'loading') return <Centered><Spinner /></Centered>;
  if (load.kind === 'error')
    return (
      <Centered>
        <div className="card max-w-sm text-center">
          <h1 className="text-lg font-semibold">{load.title}</h1>
          <p className="mt-2 text-sm text-slate-600">{load.detail}</p>
          <button className="btn-primary mt-4 w-full" onClick={() => location.reload()}>Try again</button>
        </div>
      </Centered>
    );

  const { config } = load;
  const onSession = (s: Session) => {
    saveSession(s);
    setSession(s);
  };

  let body;
  if (session && !job) body = <Centered><Spinner /></Centered>;
  else if (job && session && job.state === 'awaiting_payment')
    body = <PaymentScreen job={job} session={session} onJob={setJob} />;
  else if (job && session && job.state !== 'uploaded')
    body = <StatusScreen job={job} session={session} onJob={setJob} onNewOrder={startOver} />;
  else if (!config.accepting)
    body = (
      <div className="card text-center">
        <h2 className="font-semibold">The shop is closed for online orders</h2>
        <p className="mt-1 text-sm text-slate-600">Please ask the shopkeeper.</p>
      </div>
    );
  else body = <OrderEditor config={config} session={session} job={job} onSession={onSession} onJob={setJob} />;

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 pb-32 pt-4">
      <header className="mb-4 flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-slate-900 text-white">
          <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden><path d="M6 2h12v6H6zM4 9h16a2 2 0 0 1 2 2v6h-4v5H6v-5H2v-6a2 2 0 0 1 2-2zm4 8v3h8v-3z" /></svg>
        </div>
        <div>
          <h1 className="font-semibold leading-tight">{config.shopName}</h1>
          <p className="text-xs text-slate-500">Upload, preview and pay — collect your prints at the shop</p>
        </div>
      </header>
      {body}
    </div>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-4">{children}</div>;
}

export function Spinner() {
  return <div className="size-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" role="status" aria-label="Loading" />;
}
