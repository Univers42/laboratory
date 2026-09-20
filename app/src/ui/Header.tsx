import { settings, okCount, failCount, running, saveSettings, isHostile } from '../lab/store';
import { runAll, slide } from '../lab/registry';
import { cast } from '../lab/cultures';
import { CultureBadge } from './CultureBadge';

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Header() {
  const s = settings.value;
  const busy = running.value.size > 0;
  const me = cast(1)[0];
  return (
    <>
      <header class="top">
        <div class="brand">
          <b>Laboratory</b>
          <span>grobase bench</span>
        </div>
        <span class="gateway" title="the gateway every probe talks to">→ {s.baseUrl}</span>
        <CultureBadge c={me} extra="(this page)" />
        <div class="spacer" />
        <div class="counts">
          <span>
            <b class="ok">{okCount.value}</b> ok
          </span>
          <span>
            <b class="bad">{failCount.value}</b> failed
          </span>
        </div>
        <button class="btn" onClick={() => saveSettings({ theme: s.theme === 'dark' ? 'light' : 'dark' })} title="theme">
          {s.theme === 'dark' ? '☾' : '☀'}
        </button>
        <button
          class="btn"
          onClick={() => {
            const sl = slide();
            download('laboratory-slide.md', sl.markdown, 'text/markdown');
            download('laboratory-slide.json', JSON.stringify(sl.json, null, 2), 'application/json');
          }}
          title="export the run as Markdown + JSON"
        >
          Slide
        </button>
        <button class="btn primary" disabled={busy} onClick={() => void runAll()} data-testid="run-all">
          {busy ? 'Running…' : 'Run all'}
        </button>
      </header>
      {isHostile.value ? (
        <div class="hostile-banner">
          This page is served from the <b>hostile origin</b> ({location.origin}), which is not in the gateway's CORS list. Every cross-origin probe here is expected to be refused by the browser: green means "blocked as expected".
        </div>
      ) : null}
    </>
  );
}
