import { registerProbe } from '../lab/registry';
import { cultureById } from '../lab/cultures';
import type { RtEvent } from '../lab/client';
import { sleep, waitFor, httpErr } from './util';

type Cursor = { x: number; y: number; name: string; color: string; from: string };
interface RtState {
  roster: string[];
  cursors: Record<string, Cursor>;
  counts: { change: number; broadcast: number; presence: number };
  topic: string;
}

function membersOf(e: RtEvent): string[] {
  const p = e.payload as { members?: unknown[] } | unknown[];
  const arr = Array.isArray(p) ? p : Array.isArray((p as { members?: unknown[] })?.members) ? (p as { members: unknown[] }).members : [];
  return arr.map((m) => {
    const r = m as { meta?: { culture?: string; name?: string }; member_id?: string; id?: string };
    return String(r?.meta?.culture ?? r?.meta?.name ?? r?.member_id ?? r?.id ?? '?');
  });
}

function newState(topic: string): RtState {
  return { roster: [], cursors: {}, counts: { change: 0, broadcast: 0, presence: 0 }, topic };
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
        <span class="chip">present:</span>
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
      </div>
    </div>
  );
}

const TOPIC_KNOB = { key: 'topic', label: 'topic', type: 'text' as const, default: 'pg/public/lab_notes/*', help: 'pg/<schema>/<table>/* — the wire the SDK uses' };

registerProbe({
  id: 'realtime.together',
  group: 'realtime',
  title: 'Two cultures, one canvas',
  blurb: 'Ada and Linus each open a socket from this page. Presence shows both; a row Ada inserts reaches Linus as a change; their cursors cross the wire as broadcasts.',
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
    let changesAtB = 0;
    let cursorsAtA = 0;
    let cursorsAtB = 0;
    const handler = (who: 'A' | 'B') => (e: RtEvent) => {
      if (e.kind === 'presence') {
        state.counts.presence++;
        const members = membersOf(e);
        const set = who === 'A' ? seenByA : seenByB;
        set.clear();
        members.forEach((m) => set.add(m));
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
      } else if (e.kind === 'change') {
        state.counts.change++;
        if (who === 'B') changesAtB++;
      }
      push();
    };
    A.on(handler('A'));
    B.on(handler('B'));
    let dishId: string | undefined;
    try {
      await ctx.step(`${a.name} subscribes to ${topic} with presence`, () => A.open({ token: a.session!.access_token, topic, presenceMeta: { culture: a.id, name: a.name }, culture: a.id }));
      await ctx.step(`${b.name} subscribes with presence`, () => B.open({ token: b.session!.access_token, topic, presenceMeta: { culture: b.id, name: b.name }, culture: b.id }));
      await ctx.step('presence: each sees the other', async () => {
        await waitFor(() => seenByA.has(b.id) && seenByB.has(a.id), 8000, `${a.name} to see ${b.name} and vice versa (A sees ${[...seenByA]}, B sees ${[...seenByB]})`);
        return `A sees [${[...seenByA]}], B sees [${[...seenByB]}]`;
      });
      await ctx.step(`${a.name} inserts a note; ${b.name} receives the change`, async () => {
        const d = await api.req<{ id: string }[]>('/rest/v1/lab_dishes', { method: 'POST', body: { name: 'realtime dish', is_public: true }, token: a.session!.access_token, headers: { Prefer: 'return=representation' }, culture: a.id });
        if (d.status !== 201 || !d.json?.[0]?.id) throw httpErr(d.status, d.text);
        dishId = d.json[0].id;
        const before = changesAtB;
        const n = await api.req('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dishId, body: 'seen live?' }, token: a.session!.access_token, culture: a.id });
        if (n.status !== 201) throw httpErr(n.status, n.text);
        await waitFor(() => changesAtB > before, 10000, `a change event at ${b.name}`);
        return `${changesAtB - before} change event(s) at ${b.name}`;
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
        return `${i} frames sent each; ${a.name} received ${cursorsAtA} of ${b.name}'s, ${b.name} received ${cursorsAtB} of ${a.name}'s`;
      });
      await ctx.step(`${b.name} leaves; ${a.name} sees the roster shrink`, async () => {
        B.untrack();
        await waitFor(() => !seenByA.has(b.id), 8000, `${b.name} to leave the roster`);
        return `A sees [${[...seenByA]}]`;
      });
      return { evidence: { topic, counts: state.counts, sent: { cursorsAtA, cursorsAtB } } };
    } finally {
      A.close();
      B.close();
      if (dishId) await api.req(`/rest/v1/lab_dishes?id=eq.${dishId}`, { method: 'DELETE', token: a.session!.access_token, culture: a.id });
    }
  },
});

registerProbe({
  id: 'realtime.meet',
  group: 'realtime',
  title: 'Meet someone from another browser',
  blurb: 'This page joins the topic as its own culture and waits for anyone else. Open the lab as Linus in another tab, browser or laptop, run this there too, and watch the rosters and cursors meet. Opt-in because alone it waits in vain.',
  needs: ['auth', 'optIn'],
  knobs: [TOPIC_KNOB, { key: 'optIn', label: 'I have (or will have) company', type: 'toggle', default: false }, { key: 'waitMs', label: 'wait for company (ms)', type: 'number', default: 25000 }],
  View: CanvasView,
  async run(ctx) {
    const { api, me } = ctx;
    const topic = String(ctx.knob('topic') || TOPIC_KNOB.default);
    const state = newState(topic);
    const push = () => ctx.view({ ...state, cursors: { ...state.cursors }, roster: [...state.roster], counts: { ...state.counts } });
    const conn = api.realtime();
    const others = new Set<string>();
    let theirCursors = 0;
    conn.on((e) => {
      if (e.kind === 'presence') {
        state.counts.presence++;
        state.roster = membersOf(e);
        state.roster.filter((m) => m !== me.id).forEach((m) => others.add(m));
      } else if (e.kind === 'broadcast') {
        state.counts.broadcast++;
        const p = e.payload as { culture?: string; x?: number; y?: number };
        if (p?.culture && typeof p.x === 'number') {
          const c = cultureById(p.culture);
          state.cursors[p.culture] = { x: p.x, y: p.y ?? 50, name: c?.name || p.culture, color: c?.color || '#888', from: p.culture };
          if (p.culture !== me.id) {
            theirCursors++;
            others.add(p.culture);
          }
        }
      } else if (e.kind === 'change') state.counts.change++;
      push();
    });
    try {
      await ctx.step(`${me.name} subscribes to ${topic} with presence`, () => conn.open({ token: me.session!.access_token, topic, presenceMeta: { culture: me.id, name: me.name }, culture: me.id }));
      await ctx.step('someone else shows up (presence or a cursor)', async () => {
        const total = Math.max(3000, Number(ctx.knob<number>('waitMs')) || 25000);
        const t0 = performance.now();
        let i = 0;
        while (performance.now() - t0 < total && !ctx.signal.aborted) {
          const t = i / 50;
          const mine = { culture: me.id, x: 50 + 38 * Math.cos(2 * Math.PI * t), y: 50 + 30 * Math.sin(2 * Math.PI * t) };
          conn.broadcast('cursor', mine);
          const c = cultureById(me.id)!;
          state.cursors[me.id] = { ...mine, name: c.name, color: c.color, from: me.id };
          push();
          if (others.size > 0 && (theirCursors > 0 || performance.now() - t0 > 4000)) break;
          i++;
          await sleep(100);
        }
        if (others.size === 0) throw new Error(`nobody joined ${topic} in ${total} ms: open ${location.origin}/?culture=linus somewhere else and run this probe there`);
        // keep dancing a moment so the other side sees us too
        const t1 = performance.now();
        while (performance.now() - t1 < 3000) {
          const t = i / 50;
          conn.broadcast('cursor', { culture: me.id, x: 50 + 38 * Math.cos(2 * Math.PI * t), y: 50 + 30 * Math.sin(2 * Math.PI * t) });
          i++;
          await sleep(100);
        }
        return `met ${[...others].map((o) => cultureById(o)?.name || o).join(', ')} · ${theirCursors} of their cursor frames`;
      });
      return { evidence: { topic, met: [...others], theirCursors, counts: state.counts } };
    } finally {
      conn.close();
    }
  },
});
