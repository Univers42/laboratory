import { GROUPS } from '../lab/types';
import { listProbes } from '../lab/registry';
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
      <div class="legend">
        <span>
          <i class="dot ok" /> passed
        </span>
        <span>
          <i class="dot bad" /> failed
        </span>
        <span>
          <i class="dot skip" /> skipped: opt-in (press Run on it) or not offered by the platform
        </span>
        <span>
          <i class="dot run" /> running
        </span>
      </div>
    </aside>
  );
}
