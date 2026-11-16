import { useState } from 'react';
import { adminApi } from './client';
import { Status, useSave } from './forms';
import type { Overview } from './types';

const STATE: Record<Overview['online']['tunnel']['state'], [string, string]> = {
  online: ['Online — customers can order from anywhere', 'bg-green-100 text-green-800'],
  starting: ['Connecting to Cloudflare…', 'bg-blue-100 text-blue-800'],
  error: ['Problem', 'bg-red-100 text-red-800'],
  off: ['Off', 'bg-slate-200 text-slate-700'],
};

export function OnlinePanel({ overview, onSaved }: { overview: Overview; onSaved: () => void }) {
  const online = overview.online;
  const [mode, setMode] = useState(online.mode);
  const [token, setToken] = useState('');
  const [publicUrl, setPublicUrl] = useState(online.publicUrl);
  const s = useSave();
  const [label, tone] = STATE[online.tunnel.state];

  const save = (body: Record<string, unknown>) => s.run(() => adminApi('/api/admin/online', { method: 'PUT', body })).then((ok) => ok && onSaved());

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-4" checked={online.enabled} disabled={s.busy} onChange={(e) => save({ enabled: e.target.checked })} />
        Accept orders from anywhere (mobile data, other Wi-Fi)
      </label>
      {online.enabled && (
        <>
          <p className={`rounded-lg px-3 py-2 text-sm ${tone}`}>
            {label}
            {online.tunnel.error && online.tunnel.state !== 'online' && <span className="block text-xs">{online.tunnel.error}</span>}
          </p>
          {!overview.open && <p className="text-xs text-slate-500">The online connection runs only while the shop is open for orders.</p>}
          <details className="text-sm" open={online.mode === 'named'}>
            <summary className="cursor-pointer text-slate-600">Address type</summary>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-2">
                <input type="radio" name="mode" checked={mode === 'quick'} onChange={() => setMode('quick')} className="mt-1" />
                <span>Free temporary address <span className="block text-xs text-slate-500">Changes when the PC restarts; customers are redirected automatically. Good for getting started.</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="mode" checked={mode === 'named'} onChange={() => setMode('named')} className="mt-1" />
                <span>My own domain (Cloudflare tunnel) <span className="block text-xs text-slate-500">Permanent address and more reliable. Needs a domain on Cloudflare.</span></span>
              </label>
              {mode === 'named' && (
                <div className="space-y-2 pl-6">
                  <label className="block"><span className="label">Public address</span><input className="input" placeholder="https://9066191970.yourdomain.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value.trim())} /></label>
                  <label className="block"><span className="label">Tunnel token {online.hasNamedToken && '(saved — paste only to replace)'}</span><input className="input font-mono" type="password" value={token} onChange={(e) => setToken(e.target.value.trim())} /></label>
                </div>
              )}
              <button className="btn-secondary btn-sm" disabled={s.busy}
                onClick={() => save(mode === 'quick' ? { mode } : { mode, publicUrl, ...(token ? { namedToken: token } : {}) })}>
                Save address type
              </button>
            </div>
          </details>
        </>
      )}
      <Status error={s.error} />
    </div>
  );
}
