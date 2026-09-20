import { signal } from '@preact/signals';
import { log, isHostile } from '../lab/store';
import { cultureById } from '../lab/cultures';

export const logOpen = signal(true);

export function RequestLog() {
  const rows = log.value.slice(-200).reverse();
  // On the stranger origin every request is *meant* to end without an answer:
  // the browser refuses it before the page can read a byte. Painting those
  // rows red as "ERR" made a passing bench look like a failing one -- the
  // probes were green and the log underneath them was a wall of red.
  const refusalIsTheGoal = isHostile.value;
  return (
    <footer class="log" data-testid="request-log">
      <div class="bar">
        <b>Request log</b>
        <span>
          {log.value.length} entries · newest first · OPTIONS preflights are the browser's, shown as "pre"
          {refusalIsTheGoal ? ' · this is the stranger origin: every row should say refused' : ''}
        </span>
        <span class="spacer" />
        <button class="btn small" onClick={() => (log.value = [])}>
          clear
        </button>
        <button class="btn small" onClick={() => (logOpen.value = !logOpen.value)}>
          {logOpen.value ? 'hide' : 'show'}
        </button>
      </div>
      {logOpen.value ? (
        <div class="rows">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>who</th>
                <th>method</th>
                <th>path</th>
                <th>status</th>
                <th>ms</th>
                <th>pre</th>
                <th>kong up/proxy</th>
                <th>request id / note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const c = e.culture ? cultureById(e.culture) : undefined;
                const refused = !e.status && !!e.error;
                const expected = refused && refusalIsTheGoal;
                let path = e.url;
                try {
                  const u = new URL(e.url);
                  path = u.pathname + u.search;
                } catch {
                  /* keep */
                }
                return (
                  <tr key={e.n} class={(e.ok || expected ? '' : 'bad') + (expected ? ' expected' : '') + (e.ws ? ' ws' : '')}>
                    <td>{e.n}</td>
                    <td style={c ? `color:${c.color}` : ''}>{c?.name || ''}</td>
                    <td>{e.method}</td>
                    <td class="url" title={e.url}>
                      {path}
                    </td>
                    <td>{e.status || (expected ? 'refused' : e.error ? 'ERR' : '')}</td>
                    <td>{e.ms}</td>
                    <td>{e.preflight ? 'pre' : ''}</td>
                    <td>{e.upstreamMs || e.proxyMs ? `${e.upstreamMs ?? '-'}/${e.proxyMs ?? '-'}` : ''}</td>
                    <td>{expected ? 'blocked by the browser — which is what this page is for' : e.note || e.error || e.requestId || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </footer>
  );
}
