import { settings, okCount, failCount, running, saveSettings, isHostile, overriddenKeys, droppedOverrides, resetSettings, configuredFromServer, progress } from '../lab/store';
import { runAll, slide, probeCount, stopRun } from '../lab/registry';
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
  const p = progress.value;
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
        {/*
          A run of the whole bench takes the better part of a minute (the
          burst probe alone sends 700 requests), and a button that only said
          "Running…" with no progress and no way out reads as a page that
          has hung. It now says which probe it is on, and Stop ends the run.
        */}
        {busy ? (
          <>
            <span class="progress" data-testid="run-progress">
              {p ? `${p.done + 1}/${p.total}` : ''} {p?.current || 'running'}…
            </span>
            <button class="btn" onClick={stopRun} data-testid="stop-all">
              Stop
            </button>
          </>
        ) : null}
        <button class="btn primary" disabled={busy} onClick={() => void runAll()} data-testid="run-all">
          {busy ? 'Running…' : 'Run all'}
        </button>
      </header>
      {/*
        Banners live in their own grid row. Dropped straight into .app they
        were auto-placed into the 1fr row, which gave a two-line notice half
        the window and squeezed the three panes into the 230px meant for the
        request log -- the bench looked broken while it was merely talking.
        The wrapper is always rendered so the row exists and collapses to zero
        when there is nothing to say.
      */}
      <div class="banners">
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
        <div class="stranger-banner">
          <span class="tag">🔒 stranger origin</span>
          <span>
            This page is <b>{location.origin}</b>, which the gateway never allowed, so it runs a different bench: <b>{probeCount('hostile')} probes</b> that ask the opposite question. Everything here must be{' '}
            <b>refused</b>, and green means refused — a red dot is a door standing open to any website. The {probeCount('lab')} probes that check the platform <i>works</i> live on the bench.
          </span>
          <span class="spacer" />
          <a class="btn small" href={s.labUrl || 'http://localhost:5180'} data-testid="to-the-bench">
            open the bench →
          </a>
        </div>
      ) : null}
      </div>
    </>
  );
}
