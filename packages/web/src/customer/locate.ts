import { MOBILE_RE } from '@printhub/shared';
import { setApiBase } from '../lib/api';

/** Set only in the GitHub Pages build; the shop-served build talks to its own origin. */
const DIRECTORY = import.meta.env.VITE_DIRECTORY_URL as string | undefined;
export const HOSTED = Boolean(DIRECTORY);

export type Located = { ok: true; mobile: string | null } | { ok: false; title: string; detail: string } | { ok: 'redirecting' };

const PRIVATE_HOST = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}:\d{2,5}$/;

/**
 * Works out which shop this page is for and where its API lives.
 * Hosted: shop number from the path (r4p5.github.io/<mobile>), address from the directory.
 * Served by the shop PC: same origin; the number (if any) arrives as ?shop=.
 */
export async function locateShop(): Promise<Located> {
  const query = new URLSearchParams(location.search).get('shop');
  if (!HOSTED) {
    if (query !== null && !MOBILE_RE.test(query)) return invalid();
    return { ok: true, mobile: query };
  }

  const segment = location.pathname.split('/').filter(Boolean).pop() ?? '';
  const mobile = MOBILE_RE.test(segment) ? segment : query;
  if (!mobile || !MOBILE_RE.test(mobile)) return invalid();

  // QR codes printed before online mode carry the shop's LAN address: keep them working.
  const lan = new URLSearchParams(location.hash.slice(1)).get('h');
  if (lan && PRIVATE_HOST.test(lan)) {
    location.replace(`http://${lan}/?shop=${mobile}`);
    return { ok: 'redirecting' };
  }

  try {
    const res = await fetch(`${DIRECTORY}/shop/${mobile}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return { ok: false, title: 'Shop not online', detail: 'This shop is not taking online orders right now. Please ask at the counter.' };
    if (!res.ok) throw new Error();
    const { url } = (await res.json()) as { url: string };
    setApiBase(url);
    return { ok: true, mobile };
  } catch {
    return { ok: false, title: 'No connection', detail: 'Could not reach PrintHub. Check your internet connection and try again.' };
  }
}

const invalid = (): Located => ({ ok: false, title: 'Invalid shop link', detail: 'Please scan the QR code displayed at the shop again.' });
