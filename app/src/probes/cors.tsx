import { registerProbe } from '../lab/registry';
import { httpErr } from './util';
import { blockedByBrowser } from './rules';
import { isHostile } from '../lab/store';

registerProbe({
  id: 'cors.origin',
  group: 'cors',
  origin: 'lab',
  title: 'This origin is allowed',
  blurb: 'A cross-origin request with the apikey header forces a preflight, which the gateway must answer with this exact origin. The stranger side of the question lives on the hostile page.',
  async run(ctx) {
    const { api } = ctx;
    await ctx.step('a preflighted GET (apikey header) passes', async () => {
      const r = await api.req('/auth/v1/health');
      if (r.status === 0) throw new Error(`browser refused: ${r.text}`);
      return `HTTP ${r.status}`;
    });
    await ctx.step('a JSON POST (content-type preflight) passes', async () => {
      const r = await api.req('/rest/v1/rpc/lab_ping', { method: 'POST', body: {} });
      if (r.status === 0) throw new Error(`browser refused: ${r.text}`);
      return `HTTP ${r.status}${r.status === 404 ? ' (schema not applied yet, but CORS passed)' : ''}`;
    });
    await ctx.step('exposed headers reach the page', async () => {
      const r = await api.req('/auth/v1/health');
      const id = r.headers.get('x-request-id');
      if (!id) throw new Error('X-Request-ID not readable: Access-Control-Expose-Headers lacks it');
      return `X-Request-ID ${id} · X-Kong-Upstream-Latency ${r.headers.get('x-kong-upstream-latency') ?? '?'}`;
    });
    return { evidence: { origin: location.origin, gateway: api.base } };
  },
});

registerProbe({
  id: 'cors.hostile',
  group: 'cors',
  origin: 'lab',
  title: 'A stranger origin is refused',
  blurb: 'The same app, served from an origin that is not in the gateway list, asks from an iframe. The browser must give it nothing: status 0. Green here means blocked.',
  knobs: [{ key: 'timeoutMs', label: 'iframe answer timeout (ms)', type: 'number', default: 15000 }],
  async run(ctx) {
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
    ctx.expect('the browser refused it: blocked as expected', blockedByBrowser(seen), seen === undefined ? 'no answer' : `status ${seen.status}`);
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

// ── the other half of the blind spot, seen from the inside ───────────────
registerProbe({
  id: 'cors.blindspot',
  group: 'cors',
  origin: 'lab',
  title: 'A stranger cannot write, though the browser lets it try',
  blurb: 'CORS stops a page from reading an answer; it never stops the browser from sending a simple request. The hostile origin posts a note into a public dish with no key, and the bench — signed in, on the inside — checks that nothing arrived. Anything that trusts CORS to keep strangers out is open to any tab.',
  needs: ['auth', 'schema'],
  knobs: [{ key: 'timeoutMs', label: 'iframe answer timeout (ms)', type: 'number', default: 15000 }],
  async run(ctx) {
    const { api, me } = ctx;
    const hostileUrl = ctx.settings.hostileUrl;
    const token = me.session!.access_token;
    const nonce = `stranger-${Math.random().toString(36).slice(2, 10)}`;
    let dishId = '';
    try {
      await ctx.step('the bench opens a public dish for the stranger to aim at', async () => {
        const r = await api.req<{ id: string }[]>('/rest/v1/lab_dishes', {
          method: 'POST',
          body: { name: `blind spot ${nonce}`, is_public: true },
          token,
          headers: { Prefer: 'return=representation' },
          culture: me.id,
        });
        if (r.status !== 201 || !r.json?.[0]?.id) throw httpErr(r.status, r.text);
        dishId = r.json[0].id;
        // public on purpose: a row that did land would be visible to this
        // session, so "nothing arrived" cannot be row-level security hiding it
        return `${dishId} (public, so a row that landed would be visible)`;
      });
      let seen: { sent?: boolean; opaque?: boolean; error?: string } = {};
      await ctx.step(`${hostileUrl} posts a note with no key, unpreflighted`, async () => {
        seen = await new Promise((resolve, reject) => {
          const iframe = document.createElement('iframe');
          iframe.className = 'hostile';
          iframe.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px';
          iframe.src = `${hostileUrl}/?embed=write&base=${encodeURIComponent(ctx.settings.baseUrl)}&dish=${encodeURIComponent(dishId)}&nonce=${nonce}`;
          const timeout = Number(ctx.knob<number>('timeoutMs')) || 15000;
          const to = setTimeout(() => {
            cleanup();
            reject(new Error(`no answer from the hostile iframe in ${timeout} ms`));
          }, timeout);
          const onMsg = (ev: MessageEvent) => {
            const d = ev.data as { lab?: string; nonce?: string };
            if (d && d.lab === 'write' && d.nonce === nonce && ev.origin === hostileUrl) {
              cleanup();
              resolve(ev.data as typeof seen);
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
        return seen.sent ? 'the browser sent it and told the stranger nothing' : `the browser would not send it: ${seen.error || 'unknown'}`;
      });
      let landed = -1;
      await ctx.step('the bench looks for the stranger\'s row', async () => {
        const r = await api.req<{ id: string }[]>(`/rest/v1/lab_notes?dish_id=eq.${dishId}&body=eq.${nonce}&select=id`, { token, culture: me.id });
        if (r.status !== 200) throw httpErr(r.status, r.text);
        landed = r.json?.length ?? -1;
        return landed === 0 ? 'nothing was written' : `${landed} row(s) written by an origin the gateway never allowed`;
      });
      ctx.expect('the platform refused it server-side, not just at the browser', landed === 0, landed === 0 ? 'no row, and the gateway asked for a key before the body was ever read' : `${landed} row(s) landed: this route trusts CORS to keep strangers out`);
      ctx.view({ nonce, landed, sent: seen.sent });
      return { evidence: { nonce, dishId, landed, iframe: seen } };
    } finally {
      if (dishId) await api.req(`/rest/v1/lab_dishes?id=eq.${dishId}`, { method: 'DELETE', token, culture: me.id });
    }
  },
  View({ state }) {
    if (!state) return <div class="card">not run</div>;
    const clean = state.landed === 0;
    return (
      <div class="two">
        <div class="card">
          <h4>what the browser did</h4>
          <div>{state.sent ? 'sent the request — a simple POST needs no permission to leave' : 'refused to send it'}</div>
        </div>
        <div class="card" style={clean ? 'border-color:var(--ok)' : 'border-color:var(--bad)'}>
          <h4>what the platform did</h4>
          <div data-testid="blindspot-verdict">{clean ? '✓ refused it: nothing was written' : `✗ ${state.landed} row(s) landed from a stranger origin`}</div>
        </div>
      </div>
    );
  },
});
