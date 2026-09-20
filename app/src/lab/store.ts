// Every piece of state the bench shows, as signals. Settings persist in
// localStorage under laboratory.settings; the rest is per page.
import { signal, computed } from '@preact/signals';
import type { Result, Settings } from './types';
import type { LogEntry } from './client';

const KEY = 'laboratory.settings';

export const defaults: Settings = {
  labUrl: location.origin,
  hostileUrl: '',
  baseUrl: `${location.protocol}//${location.hostname}:5174`,
  anonKey: '',
  tenantKey: '',
  realtimeToken: '',
  wafHost: '',
  castSize: 2,
  theme: 'dark',
  knobs: {},
};

export const settings = signal<Settings>({ ...defaults });
export const results = signal<Record<string, Result>>({});
export const views = signal<Record<string, unknown>>({});
export const log = signal<LogEntry[]>([]);
export const running = signal<Set<string>>(new Set());
export const selected = signal<string>('');
export const configLoaded = signal(false);
export const configuredFromServer = signal<Partial<Settings>>({});

export const okCount = computed(() => Object.values(results.value).filter((r) => r.ok && !r.skipped).length);
export const failCount = computed(() => Object.values(results.value).filter((r) => !r.ok && !r.skipped).length);

export function saveSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  localStorage.setItem(KEY, JSON.stringify(settings.value));
  document.documentElement.dataset.theme = settings.value.theme;
}

export function setKnob(key: string, value: string | number | boolean) {
  saveSettings({ knobs: { ...settings.value.knobs, [key]: value } });
}

export function resetSettings() {
  localStorage.removeItem(KEY);
  settings.value = { ...defaults, ...configuredFromServer.value };
  document.documentElement.dataset.theme = settings.value.theme;
}

// defaults <- /lab-config.json (the container's env) <- what the user saved
export async function loadSettings() {
  let fromServer: Partial<Settings> = {};
  try {
    const r = await fetch('/lab-config.json', { cache: 'no-store' });
    if (r.ok) fromServer = (await r.json()) as Partial<Settings>;
  } catch {
    /* a dev server without the nginx template: defaults stand */
  }
  configuredFromServer.value = fromServer;
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>;
  } catch {
    saved = {};
  }
  settings.value = { ...defaults, ...fromServer, ...saved, knobs: { ...(saved.knobs || {}) } };
  document.documentElement.dataset.theme = settings.value.theme;
  configLoaded.value = true;
}

export function pushLog(entry: LogEntry) {
  const next = log.value.length >= 500 ? log.value.slice(-400) : log.value.slice();
  next.push(entry);
  log.value = next;
}

export function setResult(r: Result) {
  results.value = { ...results.value, [r.id]: r };
}

export function setView(id: string, state: unknown) {
  views.value = { ...views.value, [id]: state };
}

export function setRunning(id: string, on: boolean) {
  const s = new Set(running.value);
  if (on) s.add(id);
  else s.delete(id);
  running.value = s;
}

/** true when this page is served from the hostile origin */
export const isHostile = computed(
  () => !!settings.value.hostileUrl && location.origin === settings.value.hostileUrl && settings.value.hostileUrl !== settings.value.labUrl,
);
