import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, estimateOrder, parsePageRange, type PrintOptions } from '@printhub/shared';
import { api, ApiError, randomId, rupees, uploadFile } from '../lib/api';
import { imageSource, pdfSource } from '../lib/preview';
import type { JobView, LocalDoc, ServerDoc, Session, ShopConfig } from './types';
import { OptionsPanel, optionsSummary } from './OptionsPanel';
import { DocPreview } from './DocPreview';

const UPLOAD_CONCURRENCY = 2;

function kindOf(f: File): LocalDoc['kind'] | null {
  const name = f.name.toLowerCase();
  if (f.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (f.type === 'image/png' || name.endsWith('.png')) return 'png';
  if (f.type === 'image/jpeg' || /\.jpe?g$/.test(name)) return 'jpg';
  return null;
}

function fromServer(d: ServerDoc, session: Session): LocalDoc {
  const url = `/api/jobs/${session.jobId}/files/${d.id}?token=${encodeURIComponent(session.token)}`;
  const fetchBlob = () => fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Document unavailable'))));
  return {
    localId: d.id,
    name: d.name,
    size: d.size,
    kind: d.kind,
    file: null,
    status: 'ready',
    progress: 1,
    error: null,
    serverId: d.id,
    pages: d.pages,
    options: d.options,
    // Restored documents are fetched back from the shop only if the preview is opened.
    source: d.kind === 'pdf' ? pdfSource(d.id, () => fetchBlob().then((b) => b.arrayBuffer())) : lazyImage(d.id, fetchBlob),
  };
}

function lazyImage(key: string, fetchBlob: () => Promise<Blob>) {
  let inner: ReturnType<typeof imageSource> | null = null;
  const get = async () => (inner ??= imageSource(key, await fetchBlob()));
  return {
    key,
    sizes: async () => (await get()).sizes(),
    thumb: async (i: number) => {
      const s = await get();
      await s.sizes();
      return s.thumb(i);
    },
    destroy: () => inner?.destroy(),
  };
}

export function OrderEditor({ config, session, job, onSession, onJob }: {
  config: ShopConfig;
  session: Session | null;
  job: JobView | null;
  onSession: (s: Session) => void;
  onJob: (j: JobView) => void;
}) {
  const [docs, setDocs] = useState<LocalDoc[]>(() => (job && session ? job.documents.map((d) => fromServer(d, session)) : []));
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const jobPromise = useRef<Promise<Session> | null>(null);
  const idemKey = useRef(randomId(20));
  const active = useRef(new Map<string, () => void>());
  const fileInput = useRef<HTMLInputElement>(null);

  const patch = (localId: string, p: Partial<LocalDoc>) => setDocs((ds) => ds.map((d) => (d.localId === localId ? { ...d, ...p } : d)));

  // Free decoded pages and pdf.js workers when leaving the editor.
  const docsRef = useRef(docs);
  docsRef.current = docs;
  useEffect(() => () => docsRef.current.forEach((d) => d.source?.destroy()), []);

  const ensureJob = () => {
    if (sessionRef.current) return Promise.resolve(sessionRef.current);
    jobPromise.current ??= api<{ token: string; job: JobView }>('/api/jobs', { method: 'POST', body: { idempotencyKey: idemKey.current } })
      .then(({ token, job }) => {
        const s = { jobId: job.id, token, shop: config.mobileNumber! };
        onSession(s);
        sessionRef.current = s;
        return s;
      })
      .catch((e) => {
        jobPromise.current = null;
        throw e;
      });
    return jobPromise.current;
  };

  // Upload pump: starts queued uploads up to the concurrency limit.
  useEffect(() => {
    const running = docs.filter((d) => d.status === 'uploading').length;
    const next = docs.filter((d) => d.status === 'queued').slice(0, Math.max(0, UPLOAD_CONCURRENCY - running));
    for (const d of next) {
      patch(d.localId, { status: 'uploading', progress: 0, error: null });
      ensureJob()
        .then((s) => {
          const up = uploadFile(`/api/jobs/${s.jobId}/files`, d.file!, { 'x-job-token': s.token, 'x-upload-id': d.localId }, (progress) =>
            patch(d.localId, { progress }),
          );
          active.current.set(d.localId, up.abort);
          return up.promise;
        })
        .then((res) => {
          const doc = (res as { document: ServerDoc }).document;
          patch(d.localId, { status: 'ready', serverId: doc.id, pages: doc.pages, progress: 1 });
        })
        .catch((e: ApiError) => {
          if (e.code !== 'ABORTED') patch(d.localId, { status: 'error', error: e.message });
        })
        .finally(() => active.current.delete(d.localId));
    }
  }, [docs]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setError(null);
    const room = config.limits.maxFiles - docs.length;
    const added: LocalDoc[] = [];
    for (const f of Array.from(files)) {
      const kind = kindOf(f);
      const base = { name: f.name, size: f.size, file: f, progress: 0, serverId: null, pages: null, options: { ...DEFAULT_OPTIONS } };
      const localId = randomId(16);
      if (added.length >= room) {
        setError(`At most ${config.limits.maxFiles} documents per order.`);
        break;
      }
      if (!kind) {
        added.push({ ...base, localId, kind: 'pdf', status: 'error', error: 'Only PDF, JPG and PNG files are supported', source: null });
      } else if (f.size > config.limits.maxFileBytes) {
        added.push({ ...base, localId, kind, status: 'error', error: `Larger than ${Math.round(config.limits.maxFileBytes / 1048576)} MB`, source: null });
      } else {
        const source = kind === 'pdf' ? pdfSource(localId, () => f.arrayBuffer()) : imageSource(localId, f);
        added.push({ ...base, localId, kind, status: 'queued', error: null, source });
      }
    }
    setDocs((ds) => [...ds, ...added]);
  };

  const remove = async (d: LocalDoc) => {
    active.current.get(d.localId)?.();
    if (d.serverId && session) {
      try {
        await api(`/api/jobs/${session.jobId}/files/${d.serverId}`, { method: 'DELETE', headers: { 'x-job-token': session.token } });
      } catch (e) {
        if ((e as ApiError).status !== 404) return setError((e as Error).message);
      }
    }
    d.source?.destroy();
    setDocs((ds) => ds.filter((x) => x.localId !== d.localId));
  };

  const move = (i: number, dir: -1 | 1) =>
    setDocs((ds) => {
      const j = i + dir;
      if (j < 0 || j >= ds.length) return ds;
      const copy = ds.slice();
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });

  const setOptions = (localId: string, options: PrintOptions) => patch(localId, { options });
  const applyToAll = (options: PrintOptions) => setDocs((ds) => ds.map((d) => ({ ...d, options: { ...options, pageRange: d.options.pageRange } })));

  const ready = docs.filter((d) => d.status === 'ready');
  const pending = docs.some((d) => d.status === 'queued' || d.status === 'uploading');
  const rangeErrors = new Map<string, string>();
  for (const d of ready) {
    try {
      parsePageRange(d.options.pageRange, d.pages!);
    } catch (e) {
      rangeErrors.set(d.localId, (e as Error).message);
    }
  }

  // Instant local price; the shop computer recalculates authoritatively at checkout.
  const estimate = useMemo(() => {
    if (rangeErrors.size || ready.length === 0) return null;
    return estimateOrder(ready.map((d) => ({ pages: parsePageRange(d.options.pageRange, d.pages!).length, options: d.options })), config.pricing);
  }, [docs, config.pricing]);

  const checkout = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    const headers = { 'x-job-token': session.token };
    try {
      // Failed uploads are dropped from the order; they would block checkout otherwise.
      for (const d of docs.filter((x) => x.status === 'error')) d.source?.destroy();
      setDocs((ds) => ds.filter((d) => d.status !== 'error'));
      await api(`/api/jobs/${session.jobId}/estimate`, { method: 'POST', headers, body: { documents: ready.map((d) => ({ id: d.serverId, options: d.options })) } });
      await api(`/api/jobs/${session.jobId}/checkout`, { method: 'POST', headers });
      onJob(await api<JobView>(`/api/jobs/${session.jobId}/status`, { headers }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <input ref={fileInput} type="file" multiple accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />

      {docs.length === 0 ? (
        <button onClick={() => fileInput.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-12 text-center hover:border-slate-500">
          <span className="text-3xl" aria-hidden>📄</span>
          <span className="font-semibold">Choose documents to print</span>
          <span className="text-xs text-slate-500">PDF, JPG or PNG · up to {Math.round(config.limits.maxFileBytes / 1048576)} MB each</span>
        </button>
      ) : (
        <ol className="space-y-2">
          {docs.map((d, i) => (
            <li key={d.localId} className="card p-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-[10px] font-bold uppercase text-slate-600">{d.kind}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={d.name}>{d.name}</p>
                  {d.status === 'ready' && (
                    <p className="text-xs text-slate-500">
                      {d.pages} page{d.pages === 1 ? '' : 's'} · {optionsSummary(d.options)}
                    </p>
                  )}
                  {(d.status === 'uploading' || d.status === 'queued') && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-100">
                      <div className="h-full bg-slate-900 transition-[width]" style={{ width: `${Math.round(d.progress * 100)}%` }} />
                    </div>
                  )}
                  {d.status === 'error' && <p className="text-xs text-red-600">{d.error}</p>}
                  {rangeErrors.get(d.localId) && <p className="text-xs text-red-600">{rangeErrors.get(d.localId)}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button className="btn-secondary btn-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn-secondary btn-sm" aria-label="Move down" disabled={i === docs.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn-secondary btn-sm" aria-label={`Remove ${d.name}`} onClick={() => remove(d)}>✕</button>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                {d.status === 'error' && d.file && kindOf(d.file) && d.size <= config.limits.maxFileBytes && (
                  <button className="btn-secondary btn-sm" onClick={() => patch(d.localId, { status: 'queued', error: null })}>Retry upload</button>
                )}
                {d.status === 'ready' && (
                  <button className="btn-secondary btn-sm" aria-expanded={open === d.localId} onClick={() => setOpen(open === d.localId ? null : d.localId)}>
                    {open === d.localId ? 'Done' : 'Print options & preview'}
                  </button>
                )}
              </div>
              {open === d.localId && d.status === 'ready' && (
                <div className="mt-3 space-y-4 border-t border-slate-100 pt-3">
                  <OptionsPanel
                    options={d.options}
                    pages={d.pages!}
                    config={config}
                    onChange={(o) => setOptions(d.localId, o)}
                    onApplyAll={docs.length > 1 ? () => applyToAll(d.options) : undefined}
                  />
                  {d.source && !rangeErrors.has(d.localId) && <DocPreview source={d.source} kind={d.kind} options={d.options} />}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {docs.length > 0 && docs.length < config.limits.maxFiles && (
        <button className="btn-secondary w-full" onClick={() => fileInput.current?.click()}>+ Add more documents</button>
      )}
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

      {ready.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold">{rupees(estimate?.total)}</p>
              <p className="truncate text-xs text-slate-500">
                {estimate ? `${estimate.totalPages} pages · ~${estimate.totalSheets} sheets${estimate.minimumApplied ? ' · minimum order applied' : ''}` : 'Fix the highlighted page ranges'}
              </p>
            </div>
            <button className="btn-primary" disabled={busy || pending || !estimate} onClick={checkout}>
              {pending ? 'Uploading…' : busy ? 'Checking…' : 'Continue to pay'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
