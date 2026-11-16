export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** '' when served by the shop PC itself; the shop's public URL when hosted on GitHub Pages. */
let apiBase = '';
export const setApiBase = (base: string) => (apiBase = base.replace(/\/+$/, ''));
export const apiUrl = (path: string) => apiBase + path;

export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, { method = 'GET', body, headers = {}, signal }: ApiOptions = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers }, signal };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach the shop computer', 'OFFLINE');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  // A tunnel whose shop PC is off answers with a Cloudflare HTML error page, not our JSON.
  if (!res.ok && !data && res.status >= 502) throw new ApiError(res.status, 'The shop computer is offline', 'OFFLINE');
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  return data as T;
}

/** Upload with progress; fetch has no upload progress events, XHR does. */
export function uploadFile(
  path: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): { promise: Promise<unknown>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', apiUrl(path));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string; code?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? `Upload failed (${xhr.status})`, data?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload interrupted — check your internet connection', 'OFFLINE'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled', 'ABORTED'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export const rupees = (paise: number | null | undefined) => (paise == null ? '—' : `₹${(paise / 100).toFixed(2)}`);

export function randomId(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/** EventSource that reconnects on its own; returns a disposer. */
export function subscribe(path: string, handlers: Record<string, (data: unknown) => void>) {
  const es = new EventSource(apiUrl(path));
  for (const [event, fn] of Object.entries(handlers)) es.addEventListener(event, (e) => fn(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}
