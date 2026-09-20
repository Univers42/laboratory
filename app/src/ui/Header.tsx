import { settings, okCount, failCount, running, saveSettings, isHostile, overriddenKeys, droppedOverrides, resetSettings, configuredFromServer } from '../lab/store';
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
        <span class={'gateway' + (configuredFromServer.value.baseUrl && configuredFromServer.value.baseUrl !== s.baseUrl ? ' overridden' : '')} title="the gateway every probe talks to">
          → {s.baseUrl}
        </span>
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
      {droppedOverrides.value.length ? (
        <div class="notice warn" data-testid="dropped-banner">
          The bench was reconfigured since you last changed things here ({droppedOverrides.value.join(', ')}). Those saved values are gone and the container's own configuration is in use
          again — that is the fix for a bench where everything is suddenly red.
          <button class="btn small" onClick={() => (droppedOverrides.value = [])}>
            dismiss
          </button>
        </div>
      ) : null}
      {overriddenKeys.value.length ? (
        <div class="notice" data-testid="override-banner">
          You are overriding what this container configured: <b>{overriddenKeys.value.join(', ')}</b>. Probes use your values, not <code>.env</code>.
          <button class="btn small" onClick={resetSettings} data-testid="use-container-values">
            use the bench's values
          </button>
        </div>
      ) : null}
      {isHostile.value ? (
        <div class="hostile-banner">
          This page is served from the <b>stranger origin</b> ({location.origin}), which the gateway never allowed. The probes here ask the opposite question from the bench's: every one of them must be <b>refused</b>, and green means refused. A red dot on this page is a door standing open to any website.
        </div>
      ) : null}
    </>
  );
}
