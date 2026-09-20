import { registerProbe } from '../lab/registry';
import { isFullChangeOrder, closedCleanly } from './rules';
import { cultureById, CULTURES, type Culture } from '../lab/cultures';
import type { RtEvent } from '../lab/client';
import { sleep, waitFor, httpErr } from './util';

// What the protocol test through the relay established (2026-09-20):
//   - the Postgres producer emits topic `pg/<table>/<inserted|updated|deleted>`
//     (no schema segment; the SDK's default pattern `pg/<schema>/<table>/*`
//     never matches it), payload {table, schema, operation, data, old_data}
//   - TRACK / BROADCAST need a JWT with `can_publish: true` and a namespace
//     grant; GoTrue user tokens have neither, so the realtime plane logs
//     "Track denied (namespace)" and stays silent. The VM owner mints a
//     scoped token (`make realtime_token`, namespaces pg + lab) and the
//     bench carries it as settings.realtimeToken. Presence and broadcast
//     arrive as EVENT frames with event_type "presence" / "broadcast"; a
//     sender receives its own broadcast too.
//   - the published :latest realtime image predates presence entirely; the
//     installer pins the image tagged with the clone's commit.
const TOPIC_KNOB = { key: 'topic', label: 'topic', type: 'text' as const, default: 'pg/lab_notes/*', help: 'pg/<table>/* — the producer emits pg/<table>/<inserted|updated|deleted>' };
const ROOM_KNOB = { key: 'room', label: 'presence topic', type: 'text' as const, default: 'lab/bench/*', help: 'a topic in the lab namespace the realtime token is scoped to' };
const NO_TOKEN = 'no publish-capable realtime token: `make realtime_token` in born2root, then GROBASE_REALTIME_TOKEN in the lab .env (GoTrue sessions cannot TRACK or BROADCAST)';

type Cursor = { x: number; y: number; name: string; color: string; from: string };
interface RtState {
  roster: string[];
  cursors: Record<string, Cursor>;
  counts: { change: number; broadcast: number; presence: number };
  topic: string;
  feed: { t: string; type: string; who: string; color: string; body: string }[];
  presenceSupported?: boolean;
}

function membersOf(e: RtEvent): string[] {
  const p = e.payload as { members?: unknown[] } | unknown[];
  const arr = Array.isArray(p) ? p : Array.isArray((p as { members?: unknown[] })?.members) ? (p as { members: unknown[] }).members : [];
  return arr.map((m) => {
    const r = m as { meta?: { culture?: string; name?: string }; user_id?: string; conn_id?: string };
    return String(r?.meta?.culture ?? r?.meta?.name ?? r?.user_id ?? r?.conn_id ?? '?');
  });
}

function newState(topic: string): RtState {
  return { roster: [], cursors: {}, counts: { change: 0, broadcast: 0, presence: 0 }, topic, feed: [] };
}

/** the row inside a change event, whoever emitted it */
function rowOf(e: RtEvent): { operation?: string; data?: Record<string, unknown>; old_data?: Record<string, unknown>; table?: string } {
  const p = e.payload as Record<string, unknown>;
  return (p && typeof p === 'object' ? p : {}) as ReturnType<typeof rowOf>;
}

function cultureOfUid(uid: unknown, cast: Culture[]): Culture | undefined {
  return cast.find((c) => c.session?.user.id === uid) || CULTURES.find((c) => c.session?.user.id === uid);
}

function CanvasView({ state }: { state?: RtState }) {
  const cursors = Object.values(state?.cursors || {});
  return (
    <div>
      <div class="field-cursor" data-testid="cursor-field">
        {cursors.map((c) => (
          <div key={c.from} class="cursor" data-name={c.name} style={{ left: `${c.x}%`, top: `${c.y}%`, '--c': c.color } as any} />
        ))}
      </div>
      <div class="roster" data-testid="roster">
        <span class="chip">seen:</span>
        {(state?.roster || []).map((id) => {
          const c = cultureById(id);
          return (
            <span key={id} class="badge" style={{ '--c': c?.color || '#888' } as any}>
              <i /> {c?.name || id}
            </span>
          );
        })}
        <span class="chip">changes {state?.counts.change ?? 0}</span>
        <span class="chip">broadcasts {state?.counts.broadcast ?? 0}</span>
        <span class="chip">presence frames {state?.counts.presence ?? 0}</span>
        <span class="chip">{state?.topic || ''}</span>
        {state?.presenceSupported === false ? <span class="chip" style="border-color:var(--warn)">presence/broadcast: not in this realtime image</span> : null}
      </div>
      {state?.feed?.length ? (
        <ul class="steps" style="margin-top:10px" data-testid="feed">
          {state.feed.slice(-8).map((f, i) => (
            <li key={i} style="grid-template-columns:auto auto 1fr">
              <span class="ms">{f.t}</span>
              <span style={`color:${f.color}`}>{f.who}</span>
              <span class="mono">
                {f.type} · {f.body}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── changes: what Ada writes, Linus receives ──────────────────────────────
registerProbe({
  id: 'realtime.changes',
  group: 'realtime',
  title: 'A row Ada writes reaches Linus',
  blurb: 'Two sockets from this page on the notes topic. Ada inserts, edits and deletes; each change arrives at Linus as an event with the row inside, in order.',
  needs: ['schema', 'cast2'],
  knobs: [TOPIC_KNOB],
  View: CanvasView,
  async run(ctx) {
    const { api } = ctx;
    const [a, b] = ctx.cast;
    const topic = String(ctx.knob('topic') || TOPIC_KNOB.default);
    const state = newState(topic);
    const push = () => ctx.view({ ...state, counts: { ...state.counts }, feed: state.feed.slice() });
    const A = api.realtime();
    const B = api.realtime();
    const atB: { type: string; row: ReturnType<typeof rowOf> }[] = [];
    const handler = (who: 'A' | 'B') => (e: RtEvent) => {
      if (e.kind !== 'change') return;
      state.counts.change++;
      const row = rowOf(e);
      if (who === 'B') atB.push({ type: e.type || '', row });
      const c = cultureOfUid(row.data?.author ?? row.data?.owner, ctx.cast);
      state.feed.push({ t: new Date().toLocaleTimeString(), type: `${who} ← ${e.type}`, who: c?.name || '?', color: c?.color || 'var(--fg-3)', body: String(row.data?.body ?? row.data?.name ?? row.data?.id ?? '') });
      if (c && !state.roster.includes(c.id)) state.roster.push(c.id);
      push();
    };
    A.on(handler('A'));
    B.on(handler('B'));
    let dishId: string | undefined;
    let noteId: string | undefined;
    try {
      await ctx.step(`${a.name} subscribes to ${topic}`, () => A.open({ token: a.session!.access_token, topic, culture: a.id }));
      await ctx.step(`${b.name} subscribes to ${topic}`, () => B.open({ token: b.session!.access_token, topic, culture: b.id }));
      await ctx.step(`${a.name} inserts a note; ${b.name} receives "inserted" with the row`, async () => {
        const d = await api.req<{ id: string }[]>('/rest/v1/lab_dishes', { method: 'POST', body: { name: 'realtime dish', is_public: true }, token: a.session!.access_token, headers: { Prefer: 'return=representation' }, culture: a.id });
        if (d.status !== 201 || !d.json?.[0]?.id) throw httpErr(d.status, d.text);
        dishId = d.json[0].id;
        const n = await api.req<{ id: string }[]>('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dishId, body: 'seen live?' }, token: a.session!.access_token, headers: { Prefer: 'return=representation' }, culture: a.id });
        if (n.status !== 201 || !n.json?.[0]?.id) throw httpErr(n.status, n.text);
        noteId = n.json[0].id;
        await waitFor(() => atB.some((x) => x.type === 'inserted' && x.row.data?.id === noteId), 10000, `"inserted" for ${noteId} at ${b.name}`);
        const ev = atB.find((x) => x.row.data?.id === noteId)!;
        return `topic ${ev.row.table ?? ''} · body "${String(ev.row.data?.body)}"`;
      });
      await ctx.step(`${a.name} edits it; ${b.name} receives "updated" with old and new`, async () => {
        const u = await api.req(`/rest/v1/lab_notes?id=eq.${noteId}`, { method: 'PATCH', body: { body: 'seen live, edited' }, token: a.session!.access_token, culture: a.id });
        if (u.status !== 204 && u.status !== 200) throw httpErr(u.status, u.text);
        await waitFor(() => atB.some((x) => x.type === 'updated' && x.row.data?.id === noteId), 10000, `"updated" at ${b.name}`);
        const ev = atB.find((x) => x.type === 'updated' && x.row.data?.id === noteId)!;
        return `new "${String(ev.row.data?.body)}", old "${String(ev.row.old_data?.body ?? '?')}"`;
      });
      await ctx.step(`${a.name} deletes the dish; ${b.name} receives "deleted" for the note (cascade)`, async () => {
        const d = await api.req(`/rest/v1/lab_dishes?id=eq.${dishId}`, { method: 'DELETE', token: a.session!.access_token, culture: a.id });
        if (d.status !== 204 && d.status !== 200) throw httpErr(d.status, d.text);
        dishId = undefined;
        await waitFor(() => atB.some((x) => x.type === 'deleted' && x.row.data?.id === noteId), 10000, `"deleted" at ${b.name}`);
        return 'cascade delivered';
      });
      ctx.expect('events arrived in order: inserted, updated, deleted', isFullChangeOrder(atB.filter((x) => x.row.data?.id === noteId).map((x) => x.type)), atB.map((x) => x.type).join(','));
      return { evidence: { topic, at_linus: atB.map((x) => ({ type: x.type, id: x.row.data?.id })) } };
    } finally {
      A.close();
      B.close();
      if (dishId) await api.req(`/rest/v1/lab_dishes?id=eq.${dishId}`, { method: 'DELETE', token: a.session!.access_token, culture: a.id });
    }
  },
});

// ── together: presence + broadcast, when the server has them ─────────────
registerProbe({
  id: 'realtime.together',
  group: 'realtime',
  title: 'Presence and cursors (broadcast)',
  blurb: 'Ada and Linus join a room with the publish-capable realtime token, each carrying their identity in the presence meta, and broadcast their cursors to each other. Skipped, with the reason, without that token.',
  needs: ['cast2'],
  knobs: [ROOM_KNOB, { key: 'animateMs', label: 'cursor dance (ms)', type: 'number', default: 2500 }],
  View: CanvasView,
  async run(ctx) {
    const { api } = ctx;
    const [a, b] = ctx.cast;
    const rt = ctx.settings.realtimeToken;
    if (!rt) return { skipped: NO_TOKEN };
    const topic = String(ctx.knob('room') || ROOM_KNOB.default);
    const state = newState(topic);
    const push = () => ctx.view({ ...state, cursors: { ...state.cursors }, roster: [...state.roster], counts: { ...state.counts } });
    const A = api.realtime();
    const B = api.realtime();
    const seenByA = new Set<string>();
    const seenByB = new Set<string>();
    let cursorsAtA = 0;
    let cursorsAtB = 0;
    const handler = (who: 'A' | 'B') => (e: RtEvent) => {
      if (e.kind === 'presence') {
        state.counts.presence++;
        const set = who === 'A' ? seenByA : seenByB;
        set.clear();
        membersOf(e).forEach((m) => set.add(m));
        if (who === 'A') state.roster = [...seenByA];
      } else if (e.kind === 'broadcast') {
        state.counts.broadcast++;
        const p = e.payload as { culture?: string; x?: number; y?: number };
        if (p && typeof p.x === 'number' && p.culture) {
          const c = cultureById(p.culture);
          state.cursors[p.culture] = { x: p.x, y: p.y ?? 50, name: c?.name || p.culture, color: c?.color || '#888', from: p.culture };
          if (who === 'A' && p.culture !== a.id) cursorsAtA++;
          if (who === 'B' && p.culture !== b.id) cursorsAtB++;
        }
      } else if (e.kind === 'change') state.counts.change++;
      push();
    };
    A.on(handler('A'));
    B.on(handler('B'));
    try {
      await ctx.step(`${a.name} joins ${topic} with the realtime token and TRACKs presence`, () => A.open({ token: rt, topic, presenceMeta: { culture: a.id, name: a.name, user: a.session!.user.id }, culture: a.id }));
      await ctx.step('a presence snapshot comes back (the token may publish)', async () => {
        await waitFor(() => A.presenceFrames > 0, 4000, 'a presence frame after TRACK (is the token publish-capable and scoped to this namespace?)');
        state.presenceSupported = true;
        return `${A.presenceFrames} frame(s)`;
      });
      await ctx.step(`${b.name} joins with presence`, () => B.open({ token: rt, topic, presenceMeta: { culture: b.id, name: b.name, user: b.session!.user.id }, culture: b.id }));
      await ctx.step('presence: each sees the other', async () => {
        await waitFor(() => seenByA.has(b.id) && seenByB.has(a.id), 8000, `${a.name} to see ${b.name} and vice versa (A sees ${[...seenByA]}, B sees ${[...seenByB]})`);
        return `A sees [${[...seenByA]}], B sees [${[...seenByB]}]`;
      });
      await ctx.step('broadcast: cursors cross the wire', async () => {
        const total = Math.max(500, Number(ctx.knob<number>('animateMs')) || 2500);
        const t0 = performance.now();
        let i = 0;
        while (performance.now() - t0 < total && !ctx.signal.aborted) {
          const t = i / 40;
          A.broadcast('cursor', { culture: a.id, x: 50 + 35 * Math.cos(2 * Math.PI * t), y: 50 + 35 * Math.sin(4 * Math.PI * t) });
          B.broadcast('cursor', { culture: b.id, x: 50 + 35 * Math.cos(2 * Math.PI * t + Math.PI), y: 50 + 35 * Math.sin(2 * Math.PI * t) });
          i++;
          await sleep(80);
        }
        await waitFor(() => cursorsAtA > 0 && cursorsAtB > 0, 5000, `each side to receive the other's cursor (A got ${cursorsAtA}, B got ${cursorsAtB})`);
        return `${i} frames each; ${a.name} received ${cursorsAtA}, ${b.name} received ${cursorsAtB}`;
      });
      await ctx.step(`${b.name} leaves; ${a.name} sees the roster shrink`, async () => {
        B.untrack();
        await waitFor(() => !seenByA.has(b.id), 8000, `${b.name} to leave the roster`);
        return `A sees [${[...seenByA]}]`;
      });
      return { evidence: { topic, counts: state.counts, received: { cursorsAtA, cursorsAtB } } };
    } finally {
      A.close();
      B.close();
    }
  },
});

// ── meet: someone from another browser, through the database ─────────────
registerProbe({
  id: 'realtime.meet',
  group: 'realtime',
  title: 'Meet someone from another browser',
  blurb: 'This page joins the topic as its own culture and writes a heartbeat note carrying its cursor every second into the shared "meet" dish; with the realtime token it also tracks presence in the room. Anyone else doing the same, from any browser or laptop, shows up as a moving cursor. Left alone, it summons a companion: the bench loaded as the next culture in a hidden frame, a real second client with its own session and sockets.',
  needs: ['auth'],
  knobs: [
    TOPIC_KNOB,
    ROOM_KNOB,
    { key: 'companion', label: 'summon a companion when nobody comes', type: 'toggle', default: true, help: 'off: wait for a real person on ?culture=<name> elsewhere' },
    { key: 'waitMs', label: 'wait for company (ms)', type: 'number', default: 25000 },
  ],
  View: CanvasView,
  async run(ctx) {
    const { api, me } = ctx;
    const token = me.session!.access_token;
    const topic = String(ctx.knob('topic') || TOPIC_KNOB.default);
    const state = newState(topic);
    const push = () => ctx.view({ ...state, cursors: { ...state.cursors }, roster: [...state.roster], counts: { ...state.counts }, feed: state.feed.slice() });
    const conn = api.realtime();
    const room = ctx.settings.realtimeToken ? api.realtime() : undefined;
    const roomTopic = String(ctx.knob('room') || ROOM_KNOB.default);
    const others = new Set<string>();
    const present = new Set<string>();
    let theirBeats = 0;
    room?.on((e) => {
      if (e.kind === 'presence') {
        state.counts.presence++;
        present.clear();
        membersOf(e).filter((m) => cultureById(m)).forEach((m) => present.add(m));
        present.forEach((m) => m !== me.id && others.add(m));
        state.roster = [...new Set([me.id, ...present, ...others])];
        push();
      } else if (e.kind === 'broadcast') state.counts.broadcast++;
    });
    conn.on((e) => {
      if (e.kind === 'change') {
        state.counts.change++;
        const row = rowOf(e);
        const body = String(row.data?.body ?? '');
        const m = /^heartbeat:([a-z]+)$/.exec(body);
        if (e.type === 'inserted' && m && cultureById(m[1])) {
          const cid = m[1];
          const c = cultureById(cid)!;
          const pos = (row.data?.pos ?? {}) as { x?: number; y?: number };
          state.cursors[cid] = { x: Number(pos.x ?? 50), y: Number(pos.y ?? 50), name: c.name, color: c.color, from: cid };
          if (cid !== me.id) {
            theirBeats++;
            others.add(cid);
            state.feed.push({ t: new Date().toLocaleTimeString(), type: 'heartbeat', who: c.name, color: c.color, body: `x ${Math.round(Number(pos.x))} y ${Math.round(Number(pos.y))}` });
          }
        }
      }
      state.roster = [...new Set([me.id, ...present, ...others])];
      push();
    });
    let dishId = '';
    let frame: HTMLIFrameElement | undefined;
    try {
      await ctx.step(`${me.name} subscribes to ${topic}`, () => conn.open({ token, topic, culture: me.id }));
      if (room) await ctx.step(`${me.name} joins ${roomTopic} with presence (realtime token)`, () => room.open({ token: ctx.settings.realtimeToken, topic: roomTopic, presenceMeta: { culture: me.id, name: me.name, user: me.session!.user.id }, culture: me.id }));
      await ctx.step('the shared "meet" dish exists', async () => {
        const g = await api.req<{ id: string }[]>('/rest/v1/lab_dishes?name=eq.meet&is_public=is.true&select=id&limit=1', { token, culture: me.id });
        if (g.status !== 200) throw httpErr(g.status, g.text);
        if (g.json?.[0]?.id) {
          dishId = g.json[0].id;
          return `found ${dishId}`;
        }
        const c = await api.req<{ id: string }[]>('/rest/v1/lab_dishes', { method: 'POST', body: { name: 'meet', is_public: true }, token, headers: { Prefer: 'return=representation' }, culture: me.id });
        if (c.status !== 201 || !c.json?.[0]?.id) throw httpErr(c.status, c.text);
        dishId = c.json[0].id;
        return `created ${dishId}`;
      });
      const q = new URLSearchParams(location.search);
      const amCompanion = !!q.get('auto');
      if (ctx.knob<boolean>('companion') && !amCompanion) {
        const next = CULTURES.find((c) => c.id !== me.id)!;
        await ctx.step(`summon ${next.name} in a hidden companion frame`, async () => {
          frame = document.createElement('iframe');
          frame.style.cssText = 'position:fixed;width:1px;height:1px;bottom:0;right:0;opacity:0;pointer-events:none';
          frame.src = `${location.origin}/?culture=${next.id}&auto=realtime.meet`;
          document.body.appendChild(frame);
          return `${location.origin}/?culture=${next.id}&auto=realtime.meet`;
        });
      }
      await ctx.step('someone else shows up (their heartbeats reach this page)', async () => {
        const total = Math.max(3000, Number(ctx.knob<number>('waitMs')) || 25000);
        const t0 = performance.now();
        let i = 0;
        let metAt = 0;
        // each culture starts a quarter turn apart, so two cursors never sit on top of each other
        const phase = (Math.max(0, CULTURES.findIndex((c) => c.id === me.id)) * Math.PI) / 2;
        while (!ctx.signal.aborted) {
          const t = i / 12;
          const pos = { x: Math.round(50 + 38 * Math.cos(2 * Math.PI * t + phase)), y: Math.round(50 + 30 * Math.sin(2 * Math.PI * t + phase)) };
          await api.req('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dishId, body: `heartbeat:${me.id}`, pos }, token, culture: me.id });
          i++;
          if (others.size > 0 && !metAt) metAt = performance.now();
          if (metAt && performance.now() - metAt > 4000) break; // a few more beats so they see us too
          if (!metAt && performance.now() - t0 > total) break;
          await sleep(1000);
        }
        if (others.size === 0) throw new Error(`nobody joined in ${total} ms: open ${location.origin}/?culture=linus somewhere else and run this probe there`);
        return `met ${[...others].map((o) => cultureById(o)?.name || o).join(', ')} · ${theirBeats} of their heartbeats · ${i} of mine`;
      });
      ctx.expect('presence roster (with the realtime token)', !room || present.size > 1 || others.size > 0, room ? `present: ${[...present].join(', ') || 'only me'} · ${room.presenceFrames} presence frame(s)` : 'no realtime token: roster built from heartbeats');
      return { evidence: { topic, roomTopic, met: [...others], present: [...present], theirBeats, presenceFrames: room?.presenceFrames ?? 0, companion: !!frame } };
    } finally {
      conn.close();
      room?.close();
      if (frame) setTimeout(() => frame?.remove(), 6000);
      if (dishId) await api.req(`/rest/v1/lab_notes?dish_id=eq.${dishId}&author=eq.${me.session!.user.id}`, { method: 'DELETE', token, culture: me.id });
    }
  },
});

// ── goodbye: the closing handshake ───────────────────────────────────────
//
// This probe exists because the bench found the gateway failing it. Every
// socket the bench closed came back 1006 (abnormal closure) instead of 1000:
// the realtime service returned from its read loop on the client's Close
// frame and dropped the socket without answering, so a polite goodbye was
// indistinguishable from the network dying. Fixed in grobase
// (ws_handler: the writer owns the sink, so it is the one that answers);
// this keeps it fixed.
registerProbe({
  id: 'realtime.goodbye',
  group: 'realtime',
  title: 'Sockets close with a handshake, not a drop',
  blurb: 'A WebSocket that is closed politely must be answered politely: a Close frame back, code 1000. A server that drops the connection instead leaves every client seeing 1006 — the code for "the network died" — and SDKs reconnect from what was a normal goodbye.',
  knobs: [{ key: 'sockets', label: 'sockets to close', type: 'number', default: 3 }],
  async run(ctx) {
    const n = Math.max(1, Math.min(10, Number(ctx.knob<number>('sockets')) || 3));
    const url = `${ctx.settings.baseUrl.replace(/^http/, 'ws')}/realtime/v1/ws?apikey=${encodeURIComponent(ctx.settings.anonKey)}`;
    const seen: { code: number; wasClean: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const outcome = await new Promise<{ code: number; wasClean: boolean }>((resolve) => {
        const ws = new WebSocket(url);
        const giveUp = setTimeout(() => resolve({ code: 0, wasClean: false }), 10000);
        ws.onclose = (ev) => {
          clearTimeout(giveUp);
          resolve({ code: ev.code, wasClean: ev.wasClean });
        };
        ws.onopen = () => ws.close(1000);
      });
      seen.push(outcome);
      ctx.view({ seen: [...seen], n });
    }
    const clean = seen.filter(closedCleanly).length;
    ctx.expect(`all ${n} sockets closed with a handshake`, clean === n, seen.map((c) => `${c.code}${c.wasClean ? '' : ' (dropped)'}`).join(', '));
    return { evidence: { closes: seen, clean, of: n } };
  },
  View({ state }) {
    const seen: { code: number; wasClean: boolean }[] = state?.seen || [];
    if (!seen.length) return <div class="card">not run</div>;
    return (
      <div class="card">
        <table class="doors" data-testid="goodbye-table">
          <thead>
            <tr>
              <th>socket</th>
              <th>close code</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {seen.map((c, i) => (
              <tr key={i} class={closedCleanly(c) ? 'held' : 'open'}>
                <td class="mono">#{i + 1}</td>
                <td class="mono">{c.code || 'no close'}</td>
                <td>{closedCleanly(c) ? '✓ both sides said goodbye' : '⚠ dropped: the server never answered the Close frame'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});
