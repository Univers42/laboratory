import { signal } from '@preact/signals';
import { log } from '../lab/store';
import { cultureById } from '../lab/cultures';

export const logOpen = signal(true);

export function RequestLog() {
  const rows = log.value.slice(-200).reverse();
  return (
    <footer class="log" data-testid="request-log">
      <div class="bar">
        <b>Request log</b>
        <span>{log.value.length} entries · newest first · OPTIONS preflights are the browser's, shown as "pre"</span>
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
                let path = e.url;
                try {
                  const u = new URL(e.url);
                  path = u.pathname + u.search;
                } catch {
                  /* keep */
                }
                return (
                  <tr key={e.n} class={(e.ok ? '' : 'bad') + (e.ws ? ' ws' : '')}>
                    <td>{e.n}</td>
                    <td style={c ? `color:${c.color}` : ''}>{c?.name || ''}</td>
                    <td>{e.method}</td>
                    <td class="url" title={e.url}>
                      {path}
                    </td>
                    <td>{e.status || (e.error ? 'ERR' : '')}</td>
                    <td>{e.ms}</td>
                    <td>{e.preflight ? 'pre' : ''}</td>
                    <td>{e.upstreamMs || e.proxyMs ? `${e.upstreamMs ?? '-'}/${e.proxyMs ?? '-'}` : ''}</td>
                    <td>{e.note || e.error || e.requestId || ''}</td>
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
