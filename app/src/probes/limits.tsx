import { registerProbe } from '../lab/registry';

registerProbe({
  id: 'limits.burst',
  group: 'limits',
  title: 'The gateway pushes back',
  blurb: 'A burst against a route Kong limits to 300 a minute per address (the auth route allows 60000, which no browser can reach). Some must come back 429. It runs last: it throttles this address on that route, which nothing else uses, for up to a minute.',
  knobs: [
    { key: 'route', label: 'route', type: 'select', options: ['/tmdb/v1/', '/search/v1/', '/api/', '/auth/v1/health'], default: '/tmdb/v1/', help: 'kong.yml: /tmdb/v1 and /search/v1 and /api are 300/min per IP; /auth/v1 is 60000/min' },
    { key: 'burst', label: 'requests', type: 'number', default: 700, help: 'more than twice the limit: Kong counts in fixed calendar minutes, and a burst that straddles the boundary splits across two windows' },
    { key: 'concurrency', label: 'in flight at once', type: 'number', default: 60 },
  ],
  async run(ctx) {
    const route = String(ctx.knob('route') || '/tmdb/v1/');
    const burst = Math.max(1, Math.min(2000, Number(ctx.knob<number>('burst')) || 700));
    const conc = Math.max(1, Math.min(200, Number(ctx.knob<number>('concurrency')) || 60));
    const hist: Record<string, number> = {};
    const t0 = performance.now();
    await ctx.step(`${burst} × GET ${route}, ${conc} at a time`, async () => {
      let sent = 0;
      while (sent < burst && !ctx.signal.aborted) {
        const n = Math.min(conc, burst - sent);
        const rs = await Promise.all(Array.from({ length: n }, () => ctx.api.req(route, { signal: ctx.signal })));
        rs.forEach((r) => (hist[String(r.status)] = (hist[String(r.status)] || 0) + 1));
        sent += n;
        ctx.view({ hist: { ...hist }, sent, burst });
      }
      const s = Math.round(performance.now() - t0);
      return `${sent} requests in ${s} ms (${Math.round((sent / s) * 1000)} req/s from this tab)`;
    });
    const passed = Object.entries(hist).filter(([k]) => k !== '429' && k !== '0').reduce((a, [, v]) => a + v, 0);
    ctx.expect('requests reached the upstream before the limit (or the minute was already spent)', true, passed > 0 ? Object.entries(hist).filter(([k]) => k !== '429').map(([k, v]) => `${v} × ${k}`).join(', ') : 'none: this address was still throttled from a burst less than a minute ago');
    ctx.expect('the gateway answered 429 to the rest', (hist['429'] || 0) > 0, `${hist['429'] || 0} × 429${(hist['429'] || 0) === 0 ? ` — this route's limit is above ${burst}/min` : ''}`);
    return { evidence: { route, hist, burst, concurrency: conc } };
  },
  View({ state }) {
    const hist: Record<string, number> = state?.hist || {};
    const keys = Object.keys(hist).sort();
    const max = Math.max(1, ...Object.values(hist));
    return (
      <div>
        <div class="bars">
          {keys.map((k) => (
            <i key={k} style={{ height: `${Math.max(4, (hist[k] / max) * 80)}px`, background: k === '429' ? 'var(--warn)' : k === '0' ? 'var(--bad)' : 'var(--ok)' }}>
              <b>
                {k} × {hist[k]}
              </b>
            </i>
          ))}
        </div>
        <div style="color:var(--fg-3);font-size:12px">
          {state ? `${state.sent} of ${state.burst} sent` : 'idle'}
        </div>
      </div>
    );
  },
});
