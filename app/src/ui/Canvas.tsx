import { probeById, runProbe } from '../lab/registry';
import { results, running, selected, views } from '../lab/store';

export function Canvas() {
  const p = probeById(selected.value);
  if (!p)
    return (
      <main class="canvas">
        <h1>Pick a probe</h1>
        <p class="blurb">Each probe is one check against the platform, rendered live. "Run all" runs every probe that is not opt-in.</p>
      </main>
    );
  const r = results.value[p.id];
  const busy = running.value.has(p.id);
  const state = views.value[p.id];
  return (
    <main class="canvas" data-testid="canvas">
      <h1>{p.title}</h1>
      <p class="blurb">{p.blurb}</p>
      <div class="chips">
        <span class="chip">{p.group}</span>
        {(p.needs || []).map((n) => (
          <span class="chip" key={n}>
            needs {n}
          </span>
        ))}
        <span class="spacer" />
        <button class="btn primary small" disabled={busy} onClick={() => void runProbe(p.id, { force: true })} data-testid="run-probe">
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {r?.skipped ? <div class="skipped">Skipped: {r.skipped}</div> : null}
      {r?.error ? <div class="error">{r.error}</div> : null}
      {p.View ? (
        <div class="view">
          <p.View state={state} result={r} />
        </div>
      ) : null}
      {r?.steps.length ? (
        <ul class="steps" data-testid="steps">
          {r.steps.map((s, i) => (
            <li key={i} data-ok={s.ok}>
              <span class={s.ok ? 'tick' : 'cross'}>{s.ok ? '✓' : '✗'}</span>
              <span>{s.name}</span>
              <span class="ms">{s.ms !== undefined ? `${s.ms} ms` : ''}</span>
              {s.detail ? <span class="detail">{s.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {r?.evidence ? <pre class="evidence">{JSON.stringify(r.evidence, null, 2)}</pre> : null}
      {r ? (
        <p style="color:var(--fg-3);font-size:12px">
          {r.ms} ms · {new Date(r.startedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </main>
  );
}
