import { api, type ApiOptions } from '../lib/api';

declare global {
  interface Window {
    /** Exposed by the Electron preload script. */
    printhub?: { adminToken: string };
  }
}

function resolveToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    sessionStorage.setItem('printhub:admin', fromUrl);
    history.replaceState(null, '', location.pathname); // keep the token out of history
  }
  return window.printhub?.adminToken ?? fromUrl ?? sessionStorage.getItem('printhub:admin') ?? '';
}

export const adminToken = resolveToken();

export const adminApi = <T,>(path: string, opts: ApiOptions = {}) =>
  api<T>(path, { ...opts, headers: { ...opts.headers, 'x-admin-token': adminToken } });
