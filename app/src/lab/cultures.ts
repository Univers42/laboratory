// The cast. Four cultures with stable identities, so the same Linus can
// sign in from another tab, another browser context, another laptop, and
// meet Ada on the canvas. Sessions live in memory: two contexts never
// share one, which is the whole point of a multi-user bench.
import type { ApiClient } from './client';

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  user: { id: string; email: string };
}

export interface Culture {
  id: string;
  name: string;
  color: string;
  email: string;
  password: string;
  session?: Session;
}

export const CULTURES: Culture[] = [
  { id: 'ada', name: 'Ada', color: '#14b8a6', email: 'ada@laboratory.test', password: 'Lab-Ada-2026!x' },
  { id: 'linus', name: 'Linus', color: '#f59e0b', email: 'linus@laboratory.test', password: 'Lab-Linus-2026!x' },
  { id: 'grace', name: 'Grace', color: '#a78bfa', email: 'grace@laboratory.test', password: 'Lab-Grace-2026!x' },
  { id: 'margaret', name: 'Margaret', color: '#f472b6', email: 'margaret@laboratory.test', password: 'Lab-Margaret-2026!x' },
];

export function cultureById(id: string): Culture | undefined {
  return CULTURES.find((c) => c.id === id);
}

/** this page's culture: ?culture=linus, else Ada */
export function myCultureId(): string {
  const q = new URLSearchParams(location.search).get('culture');
  return q && cultureById(q) ? q : 'ada';
}

/** the cast for a run: me first, then the others, castSize long */
export function cast(size: number): Culture[] {
  const me = cultureById(myCultureId())!;
  const others = CULTURES.filter((c) => c.id !== me.id);
  return [me, ...others].slice(0, Math.max(1, Math.min(4, size)));
}

// The opening sign-in is allowed to fail: the bench signs the culture up
// when it does, so that 400 is a step in the flow and not a fault. Saying
// so keeps it out of the log's "unexpected" count -- where it sat looking
// exactly like a broken password.
async function signIn(api: ApiClient, c: Culture, tentative = false) {
  return api.req<Session>('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: c.email, password: c.password },
    culture: c.id,
    ...(tentative ? { want: 'any' as const, why: 'first try; if this account does not exist yet the bench signs it up next' } : {}),
  });
}

/** sign in, or sign up then sign in; keeps a session that still answers /user */
export async function ensureSession(api: ApiClient, c: Culture): Promise<Session> {
  if (c.session) {
    const me = await api.req('/auth/v1/user', { token: c.session.access_token, culture: c.id, want: 'any', why: 'checking whether the kept session still answers; the bench signs in again if not' });
    if (me.ok) return c.session;
    c.session = undefined;
  }
  let r = await signIn(api, c, true);
  if (!r.ok) {
    const up = await api.req<Session>('/auth/v1/signup', { method: 'POST', body: { email: c.email, password: c.password }, culture: c.id });
    if (up.ok && up.json?.access_token) r = up;
    else r = await signIn(api, c);
  }
  if (!r.ok || !r.json?.access_token) throw new Error(`${c.name} cannot sign in: HTTP ${r.status} ${r.text.slice(0, 120)}`);
  c.session = r.json;
  return c.session;
}

export function signOutLocal(c: Culture) {
  c.session = undefined;
}
