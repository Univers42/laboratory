import { registerProbe } from '../lab/registry';
import { httpErr } from './util';

registerProbe({
  id: 'reach.gateway',
  group: 'reach',
  title: 'Gateway is there',
  blurb: 'The door answers, the anon key opens it, a missing key is refused, and how long a round trip takes through this door.',
  knobs: [{ key: 'samples', label: 'latency samples', type: 'number', default: 8 }],
  async run(ctx) {
    const { api } = ctx;
    let version = '';
    await ctx.step('the gateway answers at /', async () => {
      const r = await api.req('/', { noKey: true });
      if (r.status === 0) throw new Error(r.text);
      return `HTTP ${r.status}${r.status === 404 ? ' (Kong: no route for /)' : ''}`;
    });
    await ctx.step('auth health with the anon key', async () => {
      const r = await api.req<{ version?: string; name?: string }>('/auth/v1/health');
      if (r.status !== 200) throw httpErr(r.status, r.text);
      version = r.json?.version || '';
      return `${r.json?.name || ''} ${version}`.trim();
    });
    await ctx.step('the same call without a key is refused', async () => {
      const r = await api.req('/auth/v1/health', { noKey: true });
      if (r.status !== 401 && r.status !== 403) throw new Error(`expected 401, got HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    await ctx.step('the REST root serves its OpenAPI', async () => {
      const r = await api.req('/rest/v1/');
      if (r.status !== 200) throw httpErr(r.status, r.text);
      return `${(r.text.length / 1024).toFixed(0)} KB of OpenAPI`;
    });
    let reqId: string | null = null;
    let upstream: string | null = null;
    const n = Math.max(1, Math.min(50, Number(ctx.knob<number>('samples')) || 8));
    const lat: number[] = [];
    await ctx.step(`latency, ${n} samples`, async () => {
      for (let i = 0; i < n; i++) {
        const r = await api.req('/auth/v1/health', { signal: ctx.signal });
        lat.push(r.ms);
        reqId = r.headers.get('x-request-id');
        upstream = r.headers.get('x-kong-upstream-latency');
        ctx.view({ lat: lat.slice(), door: api.base });
      }
      const s = [...lat].sort((a, b) => a - b);
      const med = s[Math.floor(s.length / 2)];
      const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
      return `median ${med} ms · p95 ${p95} ms · min ${s[0]} · max ${s[s.length - 1]}`;
    });
    ctx.expect('Kong exposes its request id and latency to the page', !!reqId, reqId ? `X-Request-ID ${reqId}, upstream ${upstream ?? '?'} ms` : 'Access-Control-Expose-Headers does not include X-Request-ID');
    return { evidence: { door: api.base, version, latencies_ms: lat, upstream_ms: upstream } };
  },
  View({ state }) {
    const lat: number[] = state?.lat || [];
    const max = Math.max(1, ...lat);
    return (
      <div>
        <div class="bars" data-testid="latency-bars">
          {lat.map((v, i) => (
            <i key={i} style={{ height: `${Math.max(4, (v / max) * 80)}px` }}>
              <b>{v}</b>
            </i>
          ))}
        </div>
        <div class="help" style="color:var(--fg-3);font-size:12px">
          round trips (ms) to /auth/v1/health through {state?.door || 'the gateway'}
        </div>
      </div>
    );
  },
});
