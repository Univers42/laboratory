import { registerProbe } from '../lab/registry';
import { ensureSession, signOutLocal, type Session } from '../lab/cultures';
import { httpErr, sleep } from './util';

registerProbe({
  id: 'auth.lifecycle',
  group: 'auth',
  title: 'Sign up, sign in, refresh, sign out',
  blurb: 'One culture goes through the whole life of a session, including the answers that must be "no": a wrong password, a tampered token, a refresh after sign-out.',
  async run(ctx) {
    const { api, me } = ctx;
    signOutLocal(me);
    let sess: Session | undefined;
    await ctx.step(`${me.name} signs in (signing up first if unknown)`, async () => {
      sess = await ensureSession(api, me);
      return `${sess.user.email} · user ${sess.user.id}`;
    });
    if (!sess) return;
    await ctx.step('the session answers /auth/v1/user', async () => {
      const r = await api.req<{ id: string; email: string }>('/auth/v1/user', { token: sess!.access_token, culture: me.id });
      if (r.status !== 200) throw httpErr(r.status, r.text);
      if (r.json?.id !== sess!.user.id) throw new Error('user id mismatch');
      return r.json.email;
    });
    await ctx.step('refresh rotates the access token', async () => {
      // GoTrue mints the JWT from (sub, iat, exp) at second granularity: a
      // refresh within the same second as the sign-in returns the same bytes.
      await sleep(1100);
      const r = await api.req<Session>('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: sess!.refresh_token }, culture: me.id });
      if (r.status !== 200 || !r.json?.access_token) throw httpErr(r.status, r.text);
      const changed = r.json.access_token !== sess!.access_token;
      me.session = r.json;
      sess = r.json;
      if (!changed) throw new Error('same access token after refresh');
      return `new token, expires in ${r.json.expires_in ?? '?'} s`;
    });
    await ctx.step('a wrong password is refused', async () => {
      const r = await api.req('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: me.email, password: 'definitely-not-it' }, culture: me.id });
      if (r.status < 400 || r.status >= 500) throw new Error(`expected 4xx, got HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    await ctx.step('a tampered token is refused', async () => {
      const bad = sess!.access_token.slice(0, -4) + 'AAAA';
      const r = await api.req('/auth/v1/user', { token: bad, culture: me.id });
      // 401 from GoTrue; 403 when the gateway's jwt plugin rejects it first
      if (r.status !== 401 && r.status !== 403) throw new Error(`expected 401 or 403, got HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    await ctx.step('the database sees the same user (rpc lab_ping)', async () => {
      const r = await api.req<{ role: string; uid: string }>('/rest/v1/rpc/lab_ping', { method: 'POST', body: {}, token: sess!.access_token, culture: me.id });
      if (r.status === 404) return 'schema not applied: not checked';
      if (r.status !== 200) throw httpErr(r.status, r.text);
      if (r.json?.uid !== sess!.user.id) throw new Error(`uid ${r.json?.uid} is not ${sess!.user.id}`);
      return `role ${r.json.role}, uid matches`;
    });
    await ctx.step('sign out', async () => {
      const r = await api.req('/auth/v1/logout', { method: 'POST', token: sess!.access_token, culture: me.id });
      if (r.status !== 204 && r.status !== 200) throw httpErr(r.status, r.text);
      return `HTTP ${r.status}`;
    });
    await ctx.step('the refresh token is dead after sign-out', async () => {
      const r = await api.req('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: sess!.refresh_token }, culture: me.id });
      if (r.status === 200) throw new Error('refresh still works after sign-out');
      return `HTTP ${r.status}`;
    });
    signOutLocal(me);
    await ctx.step(`${me.name} signs back in for the other probes`, async () => (await ensureSession(api, me)).user.email);
    return { evidence: { user: sess.user, gateway: api.base } };
  },
});

registerProbe({
  id: 'auth.cast',
  group: 'auth',
  title: 'The cast signs in, each as themselves',
  blurb: 'Every culture in the cast holds its own session in this page, and the platform tells them apart.',
  needs: ['auth'],
  async run(ctx) {
    const ids = new Set<string>();
    for (const c of ctx.cast) {
      await ctx.step(`${c.name} is who the platform says`, async () => {
        const r = await ctx.api.req<{ id: string; email: string }>('/auth/v1/user', { token: c.session!.access_token, culture: c.id });
        if (r.status !== 200) throw httpErr(r.status, r.text);
        if (r.json?.email !== c.email) throw new Error(`${r.json?.email} is not ${c.email}`);
        ids.add(r.json.id);
        return r.json.id;
      });
    }
    ctx.expect('their user ids are all different', ids.size === ctx.cast.length, `${ids.size} distinct of ${ctx.cast.length}`);
    return { evidence: { cast: ctx.cast.map((c) => ({ culture: c.id, user: c.session?.user.id })) } };
  },
});
