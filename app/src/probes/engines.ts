import { registerProbe } from '../lab/registry';
import { httpErr } from './util';

registerProbe({
  id: 'engines.graphql',
  group: 'engines',
  title: 'GraphQL door',
  blurb: 'POST /graphql/v1: the smallest query there is, then a real one on the bench table. pg_graphql behind PostgREST, through the gateway.',
  async run(ctx) {
    const r = await ctx.api.req<{ data?: { __typename?: string }; errors?: unknown }>('/graphql/v1', { method: 'POST', body: { query: '{ __typename }' } });
    ctx.expect('the door answers', r.status !== 0, r.status === 0 ? r.text : `HTTP ${r.status}`);
    ctx.expect('{ __typename } executes (pg_graphql behind PostgREST)', r.status === 200 && r.json?.data?.__typename === 'Query', `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    const q = await ctx.api.req<{ data?: { lab_dishesCollection?: { edges: unknown[] } }; errors?: unknown }>('/graphql/v1', {
      method: 'POST',
      body: { query: '{ lab_dishesCollection(first: 3) { edges { node { id name is_public } } } }' },
    });
    const edges = q.json?.data?.lab_dishesCollection?.edges;
    ctx.expect('a query on lab_dishes returns rows (public ones, as anon)', q.status === 200 && Array.isArray(edges), `HTTP ${q.status} ${Array.isArray(edges) ? `${edges.length} edge(s)` : q.text.slice(0, 120)}`);
    return { evidence: { typename: r.json?.data, dishes: q.json?.data ?? q.json?.errors } };
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
