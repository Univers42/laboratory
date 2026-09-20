import { registerProbe } from '../lab/registry';

registerProbe({
  id: 'limits.burst',
  group: 'limits',
  title: 'The gateway pushes back',
  blurb: 'A burst against the auth route, which is limited to 300 a minute per address. Some must come back 429. Opt-in: it throttles this address for up to a minute.',
  needs: ['optIn'],
  knobs: [
    { key: 'optIn', label: 'I mean it: throttle me for a minute', type: 'toggle', default: false },
    { key: 'burst', label: 'requests', type: 'number', default: 340 },
    { key: 'concurrency', label: 'in flight at once', type: 'number', default: 40 },
  ],
  async run(ctx) {
    const burst = Math.max(1, Math.min(2000, Number(ctx.knob<number>('burst')) || 340));
    const conc = Math.max(1, Math.min(200, Number(ctx.knob<number>('concurrency')) || 40));
    const hist: Record<string, number> = {};
    const t0 = performance.now();
    await ctx.step(`${burst} × GET /auth/v1/health, ${conc} at a time`, async () => {
      let sent = 0;
      while (sent < burst && !ctx.signal.aborted) {
        const n = Math.min(conc, burst - sent);
        const rs = await Promise.all(Array.from({ length: n }, () => ctx.api.req('/auth/v1/health', { signal: ctx.signal })));
        rs.forEach((r) => (hist[String(r.status)] = (hist[String(r.status)] || 0) + 1));
        sent += n;
        ctx.view({ hist: { ...hist }, sent, burst });
      }
      const s = Math.round(performance.now() - t0);
      return `${sent} requests in ${s} ms (${Math.round((sent / s) * 1000)} req/s from this tab)`;
    });
    ctx.expect('the first requests went through (200)', (hist['200'] || 0) > 0, `${hist['200'] || 0} × 200`);
    ctx.expect('the gateway answered 429 to the rest', (hist['429'] || 0) > 0, `${hist['429'] || 0} × 429`);
    return { evidence: { hist, burst, concurrency: conc } };
  },
  View({ state }) {
    const hist: Record<string, number> = state?.hist || {};
    const keys = Object.keys(hist).sort();
    const max = Math.max(1, ...Object.values(hist));
    return (
      <div>
        <div class="bars">
          {keys.map((k) => (
            <i key={k} style={{ height: `${Math.max(4, (hist[k] / max) * 80)}px`, background: k === '200' ? 'var(--ok)' : k === '429' ? 'var(--warn)' : 'var(--bad)' }}>
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
