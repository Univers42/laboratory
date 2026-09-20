import { registerProbe } from '../lab/registry';
import { isHostile } from '../lab/store';

registerProbe({
  id: 'cors.origin',
  group: 'cors',
  title: 'This origin is allowed',
  blurb: 'A cross-origin request with the apikey header forces a preflight. On the lab origin it must pass; on the hostile origin the browser must refuse it.',
  async run(ctx) {
    const hostile = isHostile.value;
    const { api } = ctx;
    await ctx.step(hostile ? 'a preflighted GET is refused by the browser' : 'a preflighted GET (apikey header) passes', async () => {
      const r = await api.req('/auth/v1/health');
      if (hostile) {
        if (r.status !== 0) throw new Error(`expected the browser to refuse, got HTTP ${r.status}`);
        return 'blocked as expected (status 0)';
      }
      if (r.status === 0) throw new Error(`browser refused: ${r.text}`);
      return `HTTP ${r.status}`;
    });
    await ctx.step(hostile ? 'a JSON POST is refused too' : 'a JSON POST (content-type preflight) passes', async () => {
      const r = await api.req('/rest/v1/rpc/lab_ping', { method: 'POST', body: {} });
      if (hostile) {
        if (r.status !== 0) throw new Error(`expected refusal, got HTTP ${r.status}`);
        return 'blocked as expected (status 0)';
      }
      if (r.status === 0) throw new Error(`browser refused: ${r.text}`);
      return `HTTP ${r.status}${r.status === 404 ? ' (schema not applied yet, but CORS passed)' : ''}`;
    });
    if (!hostile)
      await ctx.step('exposed headers reach the page', async () => {
        const r = await api.req('/auth/v1/health');
        const id = r.headers.get('x-request-id');
        if (!id) throw new Error('X-Request-ID not readable: Access-Control-Expose-Headers lacks it');
        return `X-Request-ID ${id} · X-Kong-Upstream-Latency ${r.headers.get('x-kong-upstream-latency') ?? '?'}`;
      });
    return { evidence: { origin: location.origin, hostile, gateway: api.base } };
  },
});

registerProbe({
  id: 'cors.hostile',
  group: 'cors',
  title: 'A stranger origin is refused',
  blurb: 'The same app, served from an origin that is not in the gateway list, asks from an iframe. The browser must give it nothing: status 0. Green here means blocked.',
  knobs: [{ key: 'timeoutMs', label: 'iframe answer timeout (ms)', type: 'number', default: 15000 }],
  async run(ctx) {
    if (isHostile.value) return { skipped: 'this page is the hostile origin: run "This origin is allowed" here instead' };
    const hostileUrl = ctx.settings.hostileUrl;
    if (!hostileUrl || hostileUrl === location.origin) return { skipped: 'no hostile origin configured (LAB_HOSTILE_URL)' };
    let seen: { status: number; error?: string } | undefined;
    await ctx.step(`${hostileUrl} asks the gateway from an iframe`, async () => {
      seen = await new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.className = 'hostile';
        iframe.style.position = 'fixed';
        iframe.style.bottom = '0';
        iframe.style.right = '0';
        iframe.style.width = '1px';
        iframe.style.height = '1px';
        iframe.src = `${hostileUrl}/?embed=cors&base=${encodeURIComponent(ctx.settings.baseUrl)}`;
        const timeout = Number(ctx.knob<number>('timeoutMs')) || 15000;
        const to = setTimeout(() => {
          cleanup();
          reject(new Error(`no answer from the hostile iframe in ${timeout} ms (is ${hostileUrl} up?)`));
        }, timeout);
        const onMsg = (ev: MessageEvent) => {
          const d = ev.data as { lab?: string; status?: number; error?: string };
          if (d && d.lab === 'cors' && ev.origin === hostileUrl) {
            cleanup();
            resolve({ status: Number(d.status), error: d.error });
          }
        };
        const cleanup = () => {
          clearTimeout(to);
          window.removeEventListener('message', onMsg);
          setTimeout(() => iframe.remove(), 500);
        };
        window.addEventListener('message', onMsg);
        document.body.appendChild(iframe);
      });
      ctx.view({ hostileUrl, ...seen });
      return `the hostile page saw status ${seen!.status}${seen!.error ? ` (${seen!.error})` : ''}`;
    });
    ctx.expect('the browser refused it: blocked as expected', seen?.status === 0, seen === undefined ? 'no answer' : `status ${seen.status}`);
    return { evidence: { hostileUrl, seen } };
  },
  View({ state }) {
    const blocked = state?.status === 0;
    return (
      <div class="two">
        <div class="card">
          <h4>{location.origin}</h4>
          <div>this page · in the CORS list · requests pass</div>
        </div>
        <div class="card" style={state ? (blocked ? 'border-color:var(--ok)' : 'border-color:var(--bad)') : ''}>
          <h4>{state?.hostileUrl || 'hostile origin'}</h4>
          <div>{!state ? 'not asked yet' : blocked ? '✓ browser refused (status 0)' : `✗ the browser let it through: HTTP ${state.status}`}</div>
        </div>
      </div>
    );
  },
});
