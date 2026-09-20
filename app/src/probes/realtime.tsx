import { registerProbe } from '../lab/registry';
import { cultureById, CULTURES, type Culture } from '../lab/cultures';
import type { RtEvent } from '../lab/client';
import { sleep, waitFor, httpErr } from './util';

// What the protocol test through the relay established (2026-09-20):
//   - the Postgres producer emits topic `pg/<table>/<inserted|updated|deleted>`
//     (no schema segment; the SDK's default pattern `pg/<schema>/<table>/*`
//     never matches it), payload {table, schema, operation, data, old_data}
//   - TRACK / BROADCAST / UNTRACK are silently ignored by the deployed
//     realtime image: no PRESENCE frame, no broadcast EVENT, no ERROR. The
//     source at d74aa97 implements them; ghcr.io/…/grobase-realtime:latest
//     predates that. The "together" probe detects this and says so.
const TOPIC_KNOB = { key: 'topic', label: 'topic', type: 'text' as const, default: 'pg/lab_notes/*', help: 'pg/<table>/* — the producer emits pg/<table>/<inserted|updated|deleted>' };

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
      ctx.expect('events arrived in order: inserted, updated, deleted', atB.filter((x) => x.row.data?.id === noteId).map((x) => x.type).join(',') === 'inserted,updated,deleted', atB.map((x) => x.type).join(','));
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
  blurb: 'Ada and Linus track presence on the topic and broadcast their cursors to each other. Skipped, with the reason, when the deployed realtime image does not answer TRACK.',
  needs: ['schema', 'cast2'],
  knobs: [TOPIC_KNOB, { key: 'animateMs', label: 'cursor dance (ms)', type: 'number', default: 2500 }],
  View: CanvasView,
  async run(ctx) {
    const { api } = ctx;
    const [a, b] = ctx.cast;
    const topic = String(ctx.knob('topic') || TOPIC_KNOB.default);
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
      await ctx.step(`${a.name} subscribes to ${topic} and TRACKs presence`, () => A.open({ token: a.session!.access_token, topic, presenceMeta: { culture: a.id, name: a.name }, culture: a.id }));
      await sleep(3000);
      if (A.presenceFrames === 0) {
        state.presenceSupported = false;
        push();
        return { skipped: 'no PRESENCE frame 3 s after TRACK (and no ERROR): the deployed realtime image ignores TRACK/BROADCAST. Presence and broadcast exist in the grobase source (d74aa97) but not in the published image.' };
      }
      state.presenceSupported = true;
      await ctx.step(`${b.name} subscribes with presence`, () => B.open({ token: b.session!.access_token, topic, presenceMeta: { culture: b.id, name: b.name }, culture: b.id }));
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
  blurb: 'This page joins the topic as its own culture and writes a heartbeat note carrying its cursor every second into the shared "meet" dish. Anyone else doing the same, from any browser or laptop, shows up here as a moving cursor: realtime through the database, no broadcast needed. Opt-in because alone it waits in vain.',
  needs: ['auth', 'optIn'],
  knobs: [TOPIC_KNOB, { key: 'optIn', label: 'I have (or will have) company', type: 'toggle', default: false }, { key: 'waitMs', label: 'wait for company (ms)', type: 'number', default: 25000 }],
  View: CanvasView,
  async run(ctx) {
    const { api, me } = ctx;
    const token = me.session!.access_token;
    const topic = String(ctx.knob('topic') || TOPIC_KNOB.default);
    const state = newState(topic);
    const push = () => ctx.view({ ...state, cursors: { ...state.cursors }, roster: [...state.roster], counts: { ...state.counts }, feed: state.feed.slice() });
    const conn = api.realtime();
    const others = new Set<string>();
    let theirBeats = 0;
    conn.on((e) => {
      if (e.kind === 'presence') {
        state.counts.presence++;
        membersOf(e).filter((m) => m !== me.id && cultureById(m)).forEach((m) => others.add(m));
      } else if (e.kind === 'broadcast') state.counts.broadcast++;
      else if (e.kind === 'change') {
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
      state.roster = [me.id, ...others];
      push();
    });
    let dishId = '';
    try {
      await ctx.step(`${me.name} subscribes to ${topic} (and TRACKs, in case the server answers)`, () => conn.open({ token, topic, presenceMeta: { culture: me.id, name: me.name }, culture: me.id }));
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
      await ctx.step('someone else shows up (their heartbeats reach this page)', async () => {
        const total = Math.max(3000, Number(ctx.knob<number>('waitMs')) || 25000);
        const t0 = performance.now();
        let i = 0;
        let metAt = 0;
        while (!ctx.signal.aborted) {
          const t = i / 12;
          const pos = { x: Math.round(50 + 38 * Math.cos(2 * Math.PI * t)), y: Math.round(50 + 30 * Math.sin(2 * Math.PI * t)) };
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
      ctx.expect('presence frames (only if this realtime image implements TRACK)', true, conn.presenceFrames > 0 ? `${conn.presenceFrames} PRESENCE frames` : 'none: presence not implemented by the deployed image; the meeting went through the database');
      return { evidence: { topic, met: [...others], theirBeats, presenceFrames: conn.presenceFrames } };
    } finally {
      conn.close();
      if (dishId) await api.req(`/rest/v1/lab_notes?dish_id=eq.${dishId}&author=eq.${me.session!.user.id}`, { method: 'DELETE', token, culture: me.id });
    }
  },
});
