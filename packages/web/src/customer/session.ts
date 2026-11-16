import type { Session } from './types';

const KEY = 'printhub:session';

// Survives closing the browser so a customer can come back to a paid order's status.
export function loadSession(shop: string): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && s.shop === shop ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: state just won't survive a reload */
  }
}
