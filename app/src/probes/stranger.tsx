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

const DOORS = [
  { path: '/auth/v1/health', what: 'auth' },
  { path: '/rest/v1/lab_dishes?limit=1', what: 'data' },
  { path: '/storage/v1/bucket', what: 'storage' },
  { path: '/graphql/v1', what: 'graphql' },
  { path: '/mongo/v1/health', what: 'mongo' },
  { path: '/v1/tenants/me', what: 'tenant' },
];

registerProbe({
  id: 'stranger.doors',
  group: 'stranger',
  origin: 'hostile',
  title: 'Every door refuses this origin',
  blurb: 'Each route, asked with the public anon key from an origin that is not in the gateway list. The browser must hand the page nothing at all: status 0, no body, no headers.',
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
