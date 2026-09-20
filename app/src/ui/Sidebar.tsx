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
              return (
                <div key={p.id} class={'probe' + (selected.value === p.id ? ' active' : '')} onClick={() => (selected.value = p.id)} data-testid={'probe-' + p.id}>
                  <span class={'dot ' + cls} data-state={cls || 'idle'} />
                  <span>{p.title}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
