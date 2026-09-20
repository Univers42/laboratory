import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './theme.css';
import './probes';
import { loadSettings, configLoaded, saveSettings, selected, settings } from './lab/store';
import { installBridge, listProbes } from './lab/registry';
import { ApiClient } from './lab/client';
import { Header } from './ui/Header';
import { Sidebar } from './ui/Sidebar';
import { Canvas } from './ui/Canvas';
import { Knobs } from './ui/Knobs';
import { RequestLog, logOpen } from './ui/RequestLog';

// ?auto=<probe id>: a companion frame. The same bench, loaded as another
// culture in a hidden same-origin iframe, runs one probe on its own page
// context (its own sockets, its own in-memory session) and reports the
// result to the page that summoned it. This is how "Meet someone" always
// has company, and it is a genuine second client as far as the platform
// can tell.
function Companion({ id }: { id: string }) {
  useEffect(() => {
    void (async () => {
      const { runProbe } = await import('./lab/registry');
      const r = await runProbe(id, { force: true });
      window.parent?.postMessage({ lab: 'companion', id, ok: r.ok, skipped: r.skipped, steps: r.steps }, location.origin);
    })();
  }, [id]);
  return (
    <div class="embed">
      companion {new URLSearchParams(location.search).get('culture')} running {id}…
    </div>
  );
}

// ?embed=cors: the hostile iframe. Same app, other origin: it makes one
// cross-origin request and tells its parent what the browser let it see.
function Embed() {
  useEffect(() => {
    void (async () => {
      const s = settings.value;
      const base = new URLSearchParams(location.search).get('base') || s.baseUrl;
      const api = new ApiClient(base, s.anonKey);
      const r = await api.req('/auth/v1/health', { want: 'refused', why: 'this iframe is the stranger origin: the browser must give it nothing' });
      const msg = { lab: 'cors', origin: location.origin, status: r.status, ok: r.ok, error: r.status === 0 ? r.text : undefined };
      document.body.dataset.corsStatus = String(r.status);
      window.parent?.postMessage(msg, '*');
    })();
  }, []);
  return (
    <div class="embed">
      hostile origin {location.origin} → {settings.value.baseUrl}/auth/v1/health …
    </div>
  );
}

function App() {
  if (!configLoaded.value) return <div class="embed">loading…</div>;
  const q = new URLSearchParams(location.search);
  if (q.get('embed') === 'cors') return <Embed />;
  if (q.get('auto')) return <Companion id={q.get('auto')!} />;
  return (
    <div class={'app' + (logOpen.value ? '' : ' log-collapsed')}>
      <Header />
      <Sidebar />
      <Canvas />
      <Knobs />
      <RequestLog />
    </div>
  );
}

void loadSettings().then(() => {
  if (!selected.value) selected.value = listProbes()[0]?.id || '';
  installBridge((patch) => saveSettings(patch as any));
  render(<App />, document.getElementById('app')!);
});
