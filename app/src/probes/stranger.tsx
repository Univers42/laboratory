// The bench, served from an origin the platform never allowed.
//
// These probes only exist on http://localhost:5181, and they ask the opposite
// question from every other probe: not "does it work" but "is it refused".
// Green here means the platform said no. A red dot on this page is a door
// standing open to any website a person happens to have in another tab.
//
// Before this bench existed, the hostile page listed the *lab* probes and
// painted twelve of them red -- which is what a correctly closed gateway
// looks like through the wrong lens, and it hid the one door that really is
// open: a WebSocket is not subject to CORS at all.
import { registerProbe } from '../lab/registry';
import { blockedByBrowser, socketRefused } from './rules';

// Every door this gateway has that a stranger would most regret being open.
// Six of them were the REST surface; the other six are the ones that give
// away the platform itself -- the admin plane that issues API keys, the
// query router, the direct data plane, Trino's SQL door and the studio.
// They are named individually because a door that quietly opens cannot then
// hide inside a count.
const DOORS = [
  { path: '/auth/v1/health', what: 'auth', costs: 'sessions and sign-ups' },
  { path: '/rest/v1/lab_dishes?limit=1', what: 'data', costs: 'every table REST exposes' },
  { path: '/storage/v1/bucket', what: 'storage', costs: 'buckets and their objects' },
  { path: '/graphql/v1', what: 'graphql', costs: 'the same data, one query deep' },
  { path: '/mongo/v1/health', what: 'mongo', costs: 'the document engine' },
  { path: '/v1/tenants/me', what: 'tenant', costs: 'who this deployment belongs to' },
  { path: '/admin/v1/keys', what: 'admin keys', costs: 'the API keys themselves' },
  { path: '/admin/v1/tenants', what: 'admin tenants', costs: 'the control plane' },
  { path: '/query/v1', what: 'query', costs: 'arbitrary queries' },
  { path: '/data/v1', what: 'data plane', costs: 'the data plane without the gateway rules' },
  { path: '/sql', what: 'sql', costs: 'Trino: SQL across every engine' },
  { path: '/studio', what: 'studio', costs: 'the admin UI' },
];

registerProbe({
  id: 'stranger.doors',
  group: 'stranger',
  origin: 'hostile',
  title: 'Every door refuses this origin',
  blurb: 'Every door of the gateway, asked with the public anon key from an origin that is not in its list — including the admin plane that issues API keys, the query router and Trino. The browser must hand the page nothing at all: status 0, no body, no headers.',
  async run(ctx) {
    const seen: Record<string, number> = {};
    for (const d of DOORS) {
      const r = await ctx.api.req(d.path, { want: 'refused', why: 'the gateway does not know this origin, so the browser hands the page nothing' });
      seen[d.what] = r.status;
      ctx.expect(`${d.what} (${d.path.split('?')[0]}) is refused`, blockedByBrowser({ status: r.status }), r.status === 0 ? 'blocked before the page could read it' : `LET IN: HTTP ${r.status}`);
      ctx.view({ seen: { ...seen } });
    }
    return { evidence: { origin: location.origin, gateway: ctx.api.base, seen } };
  },
  // A table of the word "refused" repeated six times was read as six
  // errors. Each row now carries its own verdict in words -- "✓ correct:
  // the door held" -- and the table says overhead what a full house means.
  View({ state }) {
    const seen: Record<string, number> = state?.seen || {};
    const asked = DOORS.filter((d) => seen[d.what] !== undefined);
    const held = asked.filter((d) => seen[d.what] === 0);
    return (
      <div class="card">
        <p class={asked.length && held.length === asked.length ? 'ok' : asked.length ? 'bad' : 'help'} data-testid="doors-verdict">
          {!asked.length
            ? 'not asked yet'
            : held.length === asked.length
              ? `✓ all ${held.length} doors refused this origin — that is a pass`
              : `⚠ ${asked.length - held.length} of ${asked.length} doors answered a page the gateway never allowed`}
        </p>
        <table class="doors" data-testid="stranger-doors">
          <thead>
            <tr>
              <th>door</th>
              <th>what it would cost</th>
              <th>what the browser got</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {DOORS.map((d) => {
              const st = seen[d.what];
              return (
                <tr key={d.what} class={st === undefined ? '' : st === 0 ? 'held' : 'open'}>
                  <td class="mono">{d.what}</td>
                  <td class="cost">{d.costs}</td>
                  <td class="mono">{st === undefined ? '…' : st === 0 ? 'nothing — refused' : `HTTP ${st}`}</td>
                  <td>{st === undefined ? 'not asked yet' : st === 0 ? '✓ correct: the door held' : '⚠ LET IN — this door is open to any website'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  },
});

registerProbe({
  id: 'stranger.socket',
  group: 'stranger',
  origin: 'hostile',
  title: 'The realtime socket refuses this origin',
  blurb: 'A WebSocket handshake is not a CORS request: the browser sends it whatever the origin, and the server is the only thing that can say no. The realtime plane must check the Origin header itself.',
  knobs: [{ key: 'waitMs', label: 'handshake timeout (ms)', type: 'number', default: 8000 }],
  async run(ctx) {
    const wait = Number(ctx.knob<number>('waitMs')) || 8000;
    const url = `${ctx.settings.baseUrl.replace(/^http/, 'ws')}/realtime/v1/ws?apikey=${encodeURIComponent(ctx.settings.anonKey)}`;
    const outcome = await new Promise<{ opened: boolean; detail: string }>((resolve) => {
      let ws: WebSocket;
      const done = (opened: boolean, detail: string) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve({ opened, detail });
      };
      const timer = setTimeout(() => done(false, `no handshake within ${wait} ms`), wait);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        resolve({ opened: false, detail: e instanceof Error ? e.message : String(e) });
        return;
      }
      ws.onopen = () => done(true, 'the socket opened from an origin the gateway does not allow');
      ws.onerror = () => done(false, 'refused at the handshake');
      ws.onclose = (ev) => done(false, `closed with code ${ev.code}${ev.reason ? ` (${ev.reason})` : ''}`);
    });
    ctx.view(outcome);
    ctx.expect('the handshake is refused', socketRefused(outcome), outcome.detail);
    return { evidence: { url: url.replace(/apikey=[^&]*/, 'apikey=…'), ...outcome } };
  },
  View({ state }) {
    if (!state) return <div class="card">not run</div>;
    return (
      <div class="card">
        <p class={state.opened ? 'bad' : 'ok'} data-testid="socket-verdict">
          {state.opened ? '⚠ LET IN: the socket opened to this origin' : '✓ correct: the handshake was refused'}
        </p>
        <p class="help">{state.detail}</p>
      </div>
    );
  },
});

registerProbe({
  id: 'stranger.bench',
  group: 'stranger',
  origin: 'hostile',
  title: 'The bench itself is unreadable from here',
  blurb: 'The lab origin serves the same app, and this page must not be able to read it either: a stranger that could fetch the bench could read whatever a logged-in tab left in it.',
  async run(ctx) {
    const lab = ctx.settings.labUrl;
    ctx.expect('a lab origin is configured', !!lab && lab !== location.origin, lab || 'none');
    if (!lab || lab === location.origin) return { ok: false };
    const r = await ctx.api.req(`${lab}/lab-config.json`, { want: 'refused', why: 'the bench is a different origin: this page must not be able to read it' });
    ctx.expect(`${lab}/lab-config.json is refused`, blockedByBrowser({ status: r.status }), r.status === 0 ? 'blocked before the page could read it' : `LET IN: HTTP ${r.status}`);
    return { evidence: { lab, status: r.status } };
  },
});

registerProbe({
  id: 'stranger.credentials',
  group: 'stranger',
  origin: 'hostile',
  title: 'Cookies buy this origin nothing',
  blurb: 'The same doors, asked with credentials: include — the request a stranger makes when it hopes a logged-in tab left a cookie behind. A gateway that reflects whatever Origin it is given, with Allow-Credentials: true, hands that tab over; the list must hold whatever the request carries.',
  async run(ctx) {
    const doors = DOORS.slice(0, 4);
    const seen: Record<string, number> = {};
    for (const d of doors) {
      const r = await ctx.api.req(d.path, { credentials: 'include', want: 'refused', why: 'asked with cookies on purpose: credentials must not widen the origin list' });
      seen[d.what] = r.status;
      ctx.expect(`${d.what} refuses a credentialed request`, blockedByBrowser({ status: r.status }), r.status === 0 ? 'refused, cookies and all' : `LET IN: HTTP ${r.status}`);
      ctx.view({ seen: { ...seen } });
    }
    return { evidence: { origin: location.origin, seen, asked: doors.map((d) => d.path) } };
  },
  View({ state }) {
    const seen: Record<string, number> = state?.seen || {};
    const rows = Object.entries(seen);
    if (!rows.length) return <div class="card">not run</div>;
    return (
      <div class="card">
        <p class={rows.every(([, v]) => v === 0) ? 'ok' : 'bad'} data-testid="credentials-verdict">
          {rows.every(([, v]) => v === 0)
            ? `✓ ${rows.length} doors refused this origin even with cookies attached`
            : '⚠ a credentialed request was answered: a logged-in tab is reachable from any website'}
        </p>
        <table class="doors">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} class={v === 0 ? 'held' : 'open'}>
                <td class="mono">{k}</td>
                <td>{v === 0 ? '✓ refused with credentials' : `⚠ LET IN — HTTP ${v}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});

registerProbe({
  id: 'stranger.token',
  group: 'stranger',
  origin: 'hostile',
  title: 'A real token does not buy a socket either',
  blurb: 'The origin check has to come before authentication. A stolen or leaked token is exactly what a stranger page would be holding, and the handshake must be refused with it in hand — the same 403, for the same reason.',
  async run(ctx) {
    const strong = !!ctx.settings.realtimeToken;
    const key = ctx.settings.realtimeToken || ctx.settings.anonKey;
    const url = `${ctx.settings.baseUrl.replace(/^http/, 'ws')}/realtime/v1/ws?apikey=${encodeURIComponent(key)}`;
    const outcome = await new Promise<{ opened: boolean; detail: string }>((resolve) => {
      let ws: WebSocket;
      const done = (opened: boolean, detail: string) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve({ opened, detail });
      };
      const timer = setTimeout(() => done(false, 'no handshake within 8000 ms'), 8000);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        resolve({ opened: false, detail: e instanceof Error ? e.message : String(e) });
        return;
      }
      ws.onopen = () => done(true, 'the socket opened for a token held by a stranger origin');
      ws.onerror = () => done(false, 'refused at the handshake, before any AUTH frame could be sent');
      ws.onclose = (ev) => done(false, `closed with code ${ev.code}`);
    });
    ctx.view({ ...outcome, strong });
    ctx.expect(strong ? 'the publish-capable realtime token is refused too' : 'the anon key is refused (no realtime token configured to try)', socketRefused(outcome), outcome.detail);
    return { evidence: { credential: strong ? 'publish-capable realtime token' : 'anon key', ...outcome } };
  },
  View({ state }) {
    if (!state) return <div class="card">not run</div>;
    return (
      <div class="card">
        <p class={state.opened ? 'bad' : 'ok'} data-testid="token-verdict">
          {state.opened ? '⚠ LET IN: the token worked from this origin' : '✓ correct: refused before authentication'}
        </p>
        <p class="help">
          {state.strong ? 'tried with the publish-capable realtime token' : 'no realtime token configured here, so this tried the anon key'} — {state.detail}
        </p>
      </div>
    );
  },
});

// ── the blind spot CORS does not cover ──────────────────────────────────
//
// CORS stops a page from *reading* an answer. It does not stop the browser
// from *sending* the request: a "simple" one -- no custom headers, a content
// type the browser does not preflight -- goes out to the server whatever the
// origin list says. Anything that relies on CORS for safety is therefore
// open to a stranger tab; only a server-side refusal closes it. This half
// shows the send happening and the page learning nothing; the bench's own
// "A stranger cannot write" probe checks, from the inside, that the platform
// refused it.
registerProbe({
  id: 'stranger.write',
  group: 'stranger',
  origin: 'hostile',
  title: 'What CORS does not stop: the request still goes out',
  blurb: 'A simple POST — no apikey header, text/plain body — is sent by the browser without asking anyone, and comes back opaque: sent, unreadable. CORS protects the answer, never the request, so the platform has to refuse it itself. The bench checks that it did.',
  async run(ctx) {
    const nonce = `stranger-${Math.random().toString(36).slice(2, 10)}`;
    const r = await ctx.api.req('/rest/v1/lab_notes', {
      method: 'POST',
      mode: 'no-cors',
      noKey: true,
      raw: true,
      body: JSON.stringify({ body: nonce }),
      headers: { 'Content-Type': 'text/plain' },
      want: 'any',
      why: 'sent on purpose without a key: CORS never stops the sending, only the reading',
    });
    // An opaque response reads as status 0 with no headers -- the same thing
    // a refusal looks like from here. That is the point: this page cannot
    // tell whether it worked, and neither can an attacker, which is why the
    // server-side refusal is the one that matters.
    ctx.expect('the browser sent it without a preflight', true, 'a simple request needs no permission to leave');
    ctx.expect('the page was told nothing about the result', r.status === 0, r.status === 0 ? 'opaque: no status, no body, no headers' : `readable: HTTP ${r.status}`);
    ctx.view({ nonce, status: r.status });
    return { evidence: { nonce, status: r.status, note: 'the bench probe "A stranger cannot write" checks that nothing was created' } };
  },
  View({ state }) {
    if (!state) return <div class="card">not run</div>;
    return (
      <div class="card">
        <p class="ok" data-testid="write-verdict">
          ✓ sent, and unreadable from here
        </p>
        <p class="help">
          The browser posted <code class="mono">{state.nonce}</code> to /rest/v1/lab_notes with no key and handed this page an opaque answer. Whether the platform accepted it cannot be seen from this origin — that is what the bench's
          “A stranger cannot write” probe is for.
        </p>
      </div>
    );
  },
});
