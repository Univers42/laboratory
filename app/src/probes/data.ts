import { registerProbe } from '../lab/registry';
import { httpErr } from './util';

interface Dish {
  id: string;
  name: string;
  owner: string;
  is_public: boolean;
}
interface Note {
  id: string;
  dish_id: string;
  author: string;
  body: string;
}

registerProbe({
  id: 'data.rls',
  group: 'data',
  title: 'Rows, filters, pages, and who may see them',
  blurb: 'Ada fills a private dish; Linus must see nothing, then everything once she makes it public; anonymous sees only public. CRUD, filters, Range pagination and RPC on the way.',
  needs: ['schema', 'cast2'],
  knobs: [{ key: 'keep', label: 'keep the rows afterwards', type: 'toggle', default: false }],
  async run(ctx) {
    const { api } = ctx;
    const [ada, linus] = ctx.cast;
    const tA = ada.session!.access_token;
    const tL = linus.session!.access_token;
    const rep = { Prefer: 'return=representation' };
    let dish: Dish | undefined;
    let notes: Note[] = [];
    try {
      await ctx.step(`${ada.name} creates a private dish`, async () => {
        const r = await api.req<Dish[]>('/rest/v1/lab_dishes', { method: 'POST', body: { name: `bench ${new Date().toISOString()}` }, token: tA, headers: rep, culture: ada.id });
        if (r.status !== 201 || !r.json?.[0]?.id) throw httpErr(r.status, r.text);
        dish = r.json[0];
        if (dish.owner !== ada.session!.user.id) throw new Error('owner is not Ada (auth.uid() default)');
        return dish.id;
      });
      if (!dish) return;
      await ctx.step(`${ada.name} pins three notes in one request`, async () => {
        const r = await api.req<Note[]>('/rest/v1/lab_notes', {
          method: 'POST',
          body: ['first', 'second', 'third'].map((body, i) => ({ dish_id: dish!.id, body, pos: { x: i * 10, y: i * 5 } })),
          token: tA,
          headers: rep,
          culture: ada.id,
        });
        if (r.status !== 201 || r.json?.length !== 3) throw httpErr(r.status, r.text);
        notes = r.json;
        return `${notes.length} rows`;
      });
      await ctx.step('filter + order + select', async () => {
        const r = await api.req<Note[]>(`/rest/v1/lab_notes?dish_id=eq.${dish!.id}&select=id,body&order=created_at.asc`, { token: tA, culture: ada.id });
        if (r.status !== 200 || r.json?.length !== 3) throw httpErr(r.status, r.text);
        return r.json.map((n) => n.body).join(', ');
      });
      await ctx.step('a page of two via the Range header', async () => {
        const r = await api.req<Note[]>(`/rest/v1/lab_notes?dish_id=eq.${dish!.id}&order=created_at.asc`, { token: tA, headers: { Range: '0-1' }, culture: ada.id });
        if ((r.status !== 206 && r.status !== 200) || r.json?.length !== 2) throw httpErr(r.status, r.text);
        return `HTTP ${r.status}, ${r.json.length} rows`;
      });
      await ctx.step('rpc lab_note_count', async () => {
        const r = await api.req<number>('/rest/v1/rpc/lab_note_count', { method: 'POST', body: { dish: dish!.id }, token: tA, culture: ada.id });
        if (r.status !== 200 || Number(r.json) !== 3) throw httpErr(r.status, r.text);
        return `count ${r.json}`;
      });
      await ctx.step(`${linus.name} sees no private dish, no notes`, async () => {
        const d = await api.req<Dish[]>(`/rest/v1/lab_dishes?id=eq.${dish!.id}`, { token: tL, culture: linus.id });
        const n = await api.req<Note[]>(`/rest/v1/lab_notes?dish_id=eq.${dish!.id}`, { token: tL, culture: linus.id });
        if (d.status !== 200 || n.status !== 200) throw new Error(`HTTP ${d.status}/${n.status}`);
        if ((d.json?.length ?? 1) !== 0 || (n.json?.length ?? 1) !== 0) throw new Error(`RLS leak: ${d.json?.length} dish, ${n.json?.length} notes visible`);
        return '0 dishes, 0 notes';
      });
      await ctx.step(`${linus.name} cannot pin a note on it`, async () => {
        const r = await api.req('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dish!.id, body: 'intruder' }, token: tL, culture: linus.id });
        if (r.status < 400 || r.status >= 500) throw new Error(`expected a refusal, got HTTP ${r.status}`);
        return `HTTP ${r.status}`;
      });
      await ctx.step(`${ada.name} makes the dish public`, async () => {
        const r = await api.req<Dish[]>(`/rest/v1/lab_dishes?id=eq.${dish!.id}`, { method: 'PATCH', body: { is_public: true }, token: tA, headers: rep, culture: ada.id });
        if (r.status !== 200 || !r.json?.[0]?.is_public) throw httpErr(r.status, r.text);
        return 'is_public = true';
      });
      await ctx.step(`${linus.name} now sees the dish and its three notes`, async () => {
        const d = await api.req<Dish[]>(`/rest/v1/lab_dishes?id=eq.${dish!.id}`, { token: tL, culture: linus.id });
        const n = await api.req<Note[]>(`/rest/v1/lab_notes?dish_id=eq.${dish!.id}`, { token: tL, culture: linus.id });
        if (d.json?.length !== 1 || n.json?.length !== 3) throw new Error(`${d.json?.length} dish, ${n.json?.length} notes`);
        return '1 dish, 3 notes';
      });
      await ctx.step(`${linus.name} pins his own note on the public dish`, async () => {
        const r = await api.req<Note[]>('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dish!.id, body: 'hello from Linus' }, token: tL, headers: rep, culture: linus.id });
        if (r.status !== 201 || r.json?.[0]?.author !== linus.session!.user.id) throw httpErr(r.status, r.text);
        notes.push(r.json[0]);
        return r.json[0].id;
      });
      await ctx.step(`${linus.name} cannot delete ${ada.name}'s note`, async () => {
        const r = await api.req<Note[]>(`/rest/v1/lab_notes?id=eq.${notes[0].id}`, { method: 'DELETE', token: tL, headers: rep, culture: linus.id });
        // RLS filters the row out: 200 with an empty representation, nothing deleted
        if (r.status >= 500) throw httpErr(r.status, r.text);
        if ((r.json?.length ?? 0) !== 0) throw new Error('a row was deleted');
        const still = await api.req<Note[]>(`/rest/v1/lab_notes?id=eq.${notes[0].id}`, { token: tA, culture: ada.id });
        if (still.json?.length !== 1) throw new Error('the note is gone');
        return 'nothing deleted';
      });
      await ctx.step('anonymous sees the public dish only', async () => {
        const d = await api.req<Dish[]>(`/rest/v1/lab_dishes?id=eq.${dish!.id}`);
        if (d.status !== 200 || d.json?.length !== 1) throw httpErr(d.status, d.text);
        const w = await api.req('/rest/v1/lab_notes', { method: 'POST', body: { dish_id: dish!.id, body: 'anon' } });
        if (w.status < 400) throw new Error(`anonymous could write: HTTP ${w.status}`);
        return `read 1, write refused HTTP ${w.status}`;
      });
      await ctx.step(`${ada.name} edits then deletes a note`, async () => {
        const u = await api.req<Note[]>(`/rest/v1/lab_notes?id=eq.${notes[1].id}`, { method: 'PATCH', body: { body: 'second (edited)' }, token: tA, headers: rep, culture: ada.id });
        if (u.status !== 200 || u.json?.[0]?.body !== 'second (edited)') throw httpErr(u.status, u.text);
        const d = await api.req(`/rest/v1/lab_notes?id=eq.${notes[2].id}`, { method: 'DELETE', token: tA, culture: ada.id });
        if (d.status !== 204 && d.status !== 200) throw httpErr(d.status, d.text);
        const c = await api.req<number>('/rest/v1/rpc/lab_note_count', { method: 'POST', body: { dish: dish!.id }, token: tA, culture: ada.id });
        if (Number(c.json) !== 3) throw new Error(`count ${c.json}, expected 3`);
        return 'edited one, deleted one, count 3';
      });
      return { evidence: { dish, notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.author })) } };
    } finally {
      if (dish && !ctx.knob<boolean>('keep')) {
        await api.req(`/rest/v1/lab_dishes?id=eq.${dish.id}`, { method: 'DELETE', token: tA, culture: ada.id });
      }
    }
  },
});
