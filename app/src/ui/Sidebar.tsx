import { GROUPS } from '../lab/types';
import { listProbes } from '../lab/registry';
import { isHostile } from '../lab/store';
import { results, running, selected } from '../lab/store';

export function Sidebar() {
  const probes = listProbes();
  return (
    <aside class="side" data-testid="sidebar">
      {GROUPS.map((g) => {
        const ps = probes.filter((p) => p.group === g.id);
        if (!ps.length) return null;
        return (
          <div key={g.id}>
            <div class="group" title={g.blurb}>
              {g.title}
            </div>
            {ps.map((p) => {
              const r = results.value[p.id];
              const cls = running.value.has(p.id) ? 'run' : !r ? '' : r.skipped ? 'skip' : r.ok ? 'ok' : 'bad';
              const why = running.value.has(p.id) ? 'running' : !r ? 'not run yet' : r.skipped ? `skipped: ${r.skipped}` : r.ok ? `ok, ${r.steps.length} steps` : `failed: ${r.error || r.steps.filter((s) => !s.ok).map((s) => s.name).join(', ')}`;
              return (
                <div key={p.id} class={'probe' + (selected.value === p.id ? ' active' : '')} onClick={() => (selected.value = p.id)} data-testid={'probe-' + p.id} title={why}>
                  <span class={'dot ' + cls} data-state={cls || 'idle'} />
                  <span>{p.title}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {/*
        A legend, not a status. Written as bare sentences next to the dots,
        the lines read as things that were happening right now: "skipped:
        opt-in…" and "LET IN: a door open to any website" were both reported
        as errors on a page where nothing was skipped and no door was open.
        Each line now says what the dot means, in that order.
      */}
      <div class="legend" data-testid="legend">
        <div class="legend-title">what the dots mean</div>
        <span>
          <i class="dot ok" /> green = {isHostile.value ? 'the platform refused this page, as it must' : 'the probe passed'}
        </span>
        <span>
          <i class="dot bad" /> red = {isHostile.value ? 'a door let this page in — open to any website' : 'the probe failed'}
        </span>
        <span>
          <i class="dot skip" /> grey = not run: it is opt-in, or the platform does not offer it
        </span>
        <span>
          <i class="dot run" /> amber = running now
        </span>
      </div>
    </aside>
  );
}
