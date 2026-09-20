import { signal } from '@preact/signals';
import { log, isHostile } from '../lab/store';
import type { LogEntry } from '../lab/client';
import { cultureById } from '../lab/cultures';

export const logOpen = signal(true);

// What a row means, once the probe has said what it wanted.
//
// Half the requests a bench makes are asking for a refusal: the wrong
// password, a call with no key, a burst past the rate limit, a stranger
// origin. The log used to grade every one of them on "did it return 2xx",
// so a bench with fourteen green probes sat above 408 red rows, which reads
// as a platform on fire. A row is now red only when reality disagreed with
// the probe -- including the case that used to be invisible: a request that
// wanted 401 and got 200 is a door standing open, and it is the loud one.
export function verdict(e: LogEntry, strangerOrigin: boolean): 'expected' | 'bad' | 'plain' {
  if (e.met === true) return 'expected';
  if (e.met === false) return 'bad';
  if (!e.status && e.error && strangerOrigin) return 'expected';
  return e.ok ? 'plain' : 'bad';
}

export function RequestLog() {
  const rows = log.value.slice(-200).reverse();
  // On the stranger origin a request that ends without an answer is the
  // point, even when the probe did not spell it out.
  const refusalIsTheGoal = isHostile.value;
  const unexpected = log.value.filter((e) => verdict(e, refusalIsTheGoal) === 'bad').length;
  return (
    <footer class="log" data-testid="request-log">
      <div class="bar">
        <b>Request log</b>
        <span data-testid="log-summary">
          {log.value.length} rows · <b class={unexpected ? 'bad' : 'ok'}>{unexpected}</b> unexpected · newest first · repeats folded into one row with ×n · "pre" is the browser's OPTIONS preflight
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
                <th>wanted</th>
                <th>ms</th>
                <th>pre</th>
                <th>kong up/proxy</th>
                <th>request id / note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const c = e.culture ? cultureById(e.culture) : undefined;
                const v = verdict(e, refusalIsTheGoal);
                const expected = v === 'expected';
                const refused = !e.status && !!e.error;
                let path = e.url;
                try {
                  const u = new URL(e.url);
                  path = u.pathname + u.search;
                } catch {
                  /* keep */
                }
                return (
                  <tr key={e.n} class={(v === 'bad' ? 'bad' : '') + (expected ? ' expected' : '') + (e.ws ? ' ws' : '')} data-verdict={v}>
                    <td>
                      {e.n}
                      {e.count && e.count > 1 ? <b class="times">×{e.count}</b> : null}
                    </td>
                    <td style={c ? `color:${c.color}` : ''}>{c?.name || ''}</td>
                    <td>{e.method}</td>
                    <td class="url" title={e.url}>
                      {path}
                    </td>
                    <td>{e.status || (refused ? 'refused' : e.error ? 'ERR' : '')}</td>
                    <td class="want">{e.want || ''}</td>
                    <td>{e.ms}</td>
                    <td>{e.preflight ? 'pre' : ''}</td>
                    <td>{e.upstreamMs || e.proxyMs ? `${e.upstreamMs ?? '-'}/${e.proxyMs ?? '-'}` : ''}</td>
                    <td>
                      {expected
                        ? e.why || (refused ? 'blocked by the browser — which is what this page is for' : 'the answer the probe asked for')
                        : v === 'bad' && e.met === false
                          ? `wanted ${e.want}, got ${e.status || 'no answer'}${e.error ? ` (${e.error})` : ''}`
                          : e.note || e.error || e.requestId || ''}
                    </td>
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
