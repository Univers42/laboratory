import { registerProbe } from '../lab/registry';
import { avatarPng, httpErr, sha256 } from './util';

registerProbe({
  id: 'storage.roundtrip',
  group: 'storage',
  title: 'A file goes in and comes back equal',
  blurb: 'A bucket for the culture, a generated PNG avatar uploaded, listed, downloaded and hashed, a signed URL issued, then the object removed.',
  needs: ['auth'],
  async run(ctx) {
    const { api, me } = ctx;
    const token = me.session!.access_token;
    const bucket = `lab-${me.id}`;
    const key = `avatar-${Date.now()}.png`;
    let blob: Blob | undefined;
    let hash = '';
    await ctx.step(`bucket ${bucket} exists or is created`, async () => {
      let r = await api.req<{ name?: string; created?: boolean }>(`/storage/v1/bucket/${bucket}`, { method: 'POST', token, culture: me.id, want: 'any', why: 'either verb shape makes the bucket; the probe falls back to the other' });
      if (r.status === 404 || r.status === 405) r = await api.req(`/storage/v1/bucket`, { method: 'POST', body: { name: bucket }, token, culture: me.id });
      if (r.ok) return `HTTP ${r.status}${r.json?.created === false ? ' (already there)' : ''}`;
      if (r.status === 409 || /exist/i.test(r.text)) return `HTTP ${r.status} (already there)`;
      throw httpErr(r.status, r.text);
    });
    await ctx.step('upload a generated 64×64 PNG', async () => {
      blob = await avatarPng(me.color, me.name[0]);
      hash = await sha256(await blob.arrayBuffer());
      const r = await api.req(`/storage/v1/object/${bucket}/${key}`, { method: 'PUT', body: blob, raw: true, headers: { 'Content-Type': 'image/png' }, token, culture: me.id });
      if (!r.ok) throw httpErr(r.status, r.text);
      ctx.view({ original: URL.createObjectURL(blob), size: blob.size, hash });
      return `${blob.size} bytes, sha256 ${hash.slice(0, 12)}…`;
    });
    await ctx.step('the listing shows it', async () => {
      const r = await api.req(`/storage/v1/list/${bucket}`, { token, culture: me.id });
      if (!r.ok) throw httpErr(r.status, r.text);
      if (!r.text.includes(key)) throw new Error(`${key} not in the listing`);
      return 'listed';
    });
    await ctx.step('download: the bytes are identical', async () => {
      const r = await api.bytes(`/storage/v1/object/${bucket}/${key}`, { token, culture: me.id });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h = await sha256(r.data);
      if (h !== hash) throw new Error(`sha256 ${h.slice(0, 12)}… differs from ${hash.slice(0, 12)}…`);
      ctx.view({ original: URL.createObjectURL(blob!), downloaded: URL.createObjectURL(new Blob([r.data], { type: r.type || 'image/png' })), size: r.data.byteLength, hash });
      return `${r.data.byteLength} bytes, same hash`;
    });
    await ctx.step('a signed URL is issued', async () => {
      const r = await api.req<{ signedUrl?: string; expiresAt?: string }>(`/storage/v1/sign/${bucket}/${key}`, { method: 'POST', body: { method: 'GET', expiresIn: 120 }, token, culture: me.id });
      if (!r.ok || !r.json?.signedUrl) throw httpErr(r.status, r.text);
      let host = r.json.signedUrl;
      try {
        host = new URL(r.json.signedUrl).host;
      } catch {
        /* keep */
      }
      return `for ${host}, expires ${r.json.expiresAt ?? 'later'}`;
    });
    await ctx.step('delete the object; it is gone', async () => {
      const d = await api.req(`/storage/v1/object/${bucket}/${key}`, { method: 'DELETE', token, culture: me.id });
      if (!d.ok) throw httpErr(d.status, d.text);
      const g = await api.bytes(`/storage/v1/object/${bucket}/${key}`, { token, culture: me.id, want: [404, 400, 403], why: 'fetched after the delete on purpose: the object must be gone' });
      if (g.ok) throw new Error('still downloadable after delete');
      return `HTTP ${d.status}, then ${g.status}`;
    });
    return { evidence: { bucket, key, bytes: blob?.size, sha256: hash } };
  },
  View({ state }) {
    return (
      <div class="two">
        <div class="card">
          <h4>uploaded</h4>
          {state?.original ? <img src={state.original} width={64} height={64} alt="uploaded avatar" /> : <span style="color:var(--fg-3)">not yet</span>}
        </div>
        <div class="card">
          <h4>downloaded</h4>
          {state?.downloaded ? <img src={state.downloaded} width={64} height={64} alt="downloaded avatar" /> : <span style="color:var(--fg-3)">not yet</span>}
          {state?.hash ? <div class="mono" style="color:var(--fg-3);font-size:11px">{String(state.hash).slice(0, 24)}…</div> : null}
        </div>
      </div>
    );
  },
});
