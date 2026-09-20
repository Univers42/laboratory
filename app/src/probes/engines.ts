import { registerProbe } from '../lab/registry';
import { httpErr } from './util';

registerProbe({
  id: 'engines.graphql',
  group: 'engines',
  title: 'GraphQL door',
  blurb: 'POST /graphql/v1 with the smallest query there is. The gateway must route it; whether pg_graphql is bundled decides if it executes.',
  async run(ctx) {
    const r = await ctx.api.req<{ data?: unknown; errors?: unknown }>('/graphql/v1', { method: 'POST', body: { query: '{ __typename }' } });
    ctx.expect('the door answers', r.status !== 0, r.status === 0 ? r.text : `HTTP ${r.status}`);
    if (r.status === 404 || r.status === 406 || r.status === 501) return { skipped: `the route answers HTTP ${r.status}: PostgREST exposes no graphql schema (pg_graphql is not bundled in this grobase image)` };
    ctx.expect('the query executes', r.status === 200 && !!r.json?.data, `HTTP ${r.status} ${r.text.slice(0, 100)}`);
    return { evidence: { status: r.status, body: r.json } };
  },
});

registerProbe({
  id: 'engines.mongo',
  group: 'engines',
  title: 'Mongo door',
  blurb: 'The document engine behind /mongo/v1 is reachable through the same gateway, same key.',
  async run(ctx) {
    const h = await ctx.api.req('/mongo/v1/health');
    const root = h.status === 404 ? await ctx.api.req('/mongo/v1/') : h;
    ctx.expect('the door answers', root.status !== 0 && root.status < 500, `HTTP ${root.status} ${root.text.slice(0, 80)}`);
    ctx.expect('it wants a key', (await ctx.api.req('/mongo/v1/health', { noKey: true })).status === 401, 'without apikey');
    return { evidence: { status: root.status, body: root.json ?? root.text.slice(0, 200) } };
  },
});

registerProbe({
  id: 'engines.tenant',
  group: 'engines',
  title: 'The tenant you were issued',
  blurb: 'A tenant key from `make tenant_key` identifies an application, not a person. /v1/tenants/me must know it as a bearer token, and refuse its absence.',
  needs: ['tenantKey'],
  async run(ctx) {
    const key = ctx.settings.tenantKey;
    let me: Record<string, unknown> | null = null;
    await ctx.step('GET /v1/tenants/me with X-Baas-Api-Key', async () => {
      // tenant-control takes the key as `Authorization: Bearer <api-key>` (its 401
      // says so); X-Baas-Api-Key is the data plane's header, not this route's.
      const r = await ctx.api.req<Record<string, unknown>>('/v1/tenants/me', { token: key });
      if (r.status !== 200) throw httpErr(r.status, r.text);
      me = r.json;
      const t = (r.json?.tenant ?? r.json) as Record<string, unknown>;
      return `tenant ${String(t?.id ?? t?.slug ?? '?')} · ${String(t?.status ?? '')} ${String(t?.plan ?? '')}`.trim();
    });
    await ctx.step('without the key it is refused', async () => {
      const r = await ctx.api.req('/v1/tenants/me');
      if (r.status < 400 || r.status >= 500) throw new Error(`expected 4xx, got HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    return { evidence: { me } };
  },
});
