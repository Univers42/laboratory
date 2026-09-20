import { settings, saveSettings, setKnob, resetSettings, selected, overrides, revertSetting } from '../lab/store';
import { probeById, knobKey, knobValue } from '../lab/registry';
import { CULTURES, myCultureId } from '../lab/cultures';

/** a field the user typed over the container's configuration, and the way back */
function Over({ k }: { k: string }) {
  if (!(k in overrides.value)) return null;
  return (
    <button class="over" data-testid={'revert-' + k} title="this value overrides what the container configured; click to follow the container again" onClick={() => revertSetting(k)}>
      overridden ↺
    </button>
  );
}

export function Knobs() {
  const s = settings.value;
  const p = probeById(selected.value);
  const presets: { label: string; url: string }[] = [
    { label: 'relay → tailnet WAF (this lab)', url: `${location.protocol}//${location.hostname}:5174` },
    { label: 'host SSH tunnel → Kong (make baas_access)', url: 'http://127.0.0.1:18000' },
    ...(s.wafHost ? [{ label: 'public Funnel (off-campus DNS)', url: `https://${s.wafHost}` }] : []),
    ...(s.wafHost ? [{ label: 'tailnet direct (needs Tailscale here)', url: `https://${s.wafHost}:8443` }] : []),
  ];
  const cultureHref = (id: string) => {
    const u = new URL(location.href);
    u.searchParams.set('culture', id);
    return u.toString();
  };
  return (
    <aside class="knobs" data-testid="knobs">
      <h3>Gateway</h3>
      <div class="field">
        <label>
          door <Over k="baseUrl" />
        </label>
        <select value={presets.find((x) => x.url === s.baseUrl)?.url || ''} onChange={(e) => saveSettings({ baseUrl: (e.target as HTMLSelectElement).value })}>
          <option value="">custom…</option>
          {presets.map((x) => (
            <option key={x.url} value={x.url}>
              {x.label}
            </option>
          ))}
        </select>
        <input class="mono" value={s.baseUrl} onChange={(e) => saveSettings({ baseUrl: (e.target as HTMLInputElement).value.trim() })} data-testid="knob-baseUrl" />
        <span class="help">every probe talks to this origin; the browser origin stays {location.origin}</span>
      </div>
      <div class="field">
        <label>
          anon key (apikey) <Over k="anonKey" />
        </label>
        <input class="mono" type="password" value={s.anonKey} onChange={(e) => saveSettings({ anonKey: (e.target as HTMLInputElement).value.trim() })} />
      </div>
      <div class="field">
        <label>
          tenant key (X-Baas-Api-Key) <Over k="tenantKey" />
        </label>
        <input class="mono" type="password" value={s.tenantKey} onChange={(e) => saveSettings({ tenantKey: (e.target as HTMLInputElement).value.trim() })} />
      </div>
      <div class="field">
        <label>
          realtime token (presence, broadcast) <Over k="realtimeToken" />
        </label>
        <input class="mono" type="password" value={s.realtimeToken} onChange={(e) => saveSettings({ realtimeToken: (e.target as HTMLInputElement).value.trim() })} />
        <span class="help">from `make realtime_token` in born2root; user sessions cannot publish</span>
      </div>
      <h3>Cast</h3>
      <div class="field">
        <label>cast size (cultures per run)</label>
        <input type="number" min={1} max={4} value={s.castSize} onChange={(e) => saveSettings({ castSize: Math.max(1, Math.min(4, Number((e.target as HTMLInputElement).value) || 1)) })} />
      </div>
      <div class="field">
        <label>this page is</label>
        <select value={myCultureId()} onChange={(e) => (location.href = cultureHref((e.target as HTMLSelectElement).value))}>
          {CULTURES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span class="help">open another tab or browser as someone else and meet on the realtime canvas</span>
      </div>
      {p?.knobs?.length ? (
        <>
          <h3>{p.title}</h3>
          {p.knobs.map((k) => {
            const v = knobValue<string | number | boolean>(p, k.key);
            const key = knobKey(p.id, k.key);
            if (k.type === 'toggle')
              return (
                <div class="field toggle" key={k.key}>
                  <input type="checkbox" checked={!!v} onChange={(e) => setKnob(key, (e.target as HTMLInputElement).checked)} data-testid={'knob-' + key} />
                  <label>{k.label}</label>
                  {k.help ? <span class="help" style="grid-column:1/-1">{k.help}</span> : null}
                </div>
              );
            if (k.type === 'select')
              return (
                <div class="field" key={k.key}>
                  <label>{k.label}</label>
                  <select value={String(v)} onChange={(e) => setKnob(key, (e.target as HTMLSelectElement).value)}>
                    {(k.options || []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  {k.help ? <span class="help">{k.help}</span> : null}
                </div>
              );
            return (
              <div class="field" key={k.key}>
                <label>{k.label}</label>
                <input
                  type={k.type === 'number' ? 'number' : 'text'}
                  value={String(v)}
                  onChange={(e) => setKnob(key, k.type === 'number' ? Number((e.target as HTMLInputElement).value) : (e.target as HTMLInputElement).value)}
                  data-testid={'knob-' + key}
                />
                {k.help ? <span class="help">{k.help}</span> : null}
              </div>
            );
          })}
        </>
      ) : null}
      <h3>Reset</h3>
      <button class="btn small" onClick={resetSettings} data-testid="forget-settings">
        forget my settings
      </button>
      <span class="help">drops every override above and takes the gateway, keys and token this container was started with (.env)</span>
    </aside>
  );
}
