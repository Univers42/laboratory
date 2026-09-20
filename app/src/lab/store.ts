// Every piece of state the bench shows, as signals.
//
// Settings come from two places and the bench must not confuse them: the
// container's /lab-config.json (gateway URL and keys, rendered from .env when
// the container starts) and whatever the person at the keyboard typed over it.
// Version 1 persisted the *merged* result, so a single click on the theme
// button froze that day's anon key in localStorage; when the VM's grobase was
// rebuilt with new keys, every probe went red with "Unauthorized" -- and the
// screen blamed the schema. Version 2 persists only the fields the user
// actually overrode, each remembered next to the server value it replaced, so
// a rotated key drops the override instead of outliving it. Anything dropped
// is announced (droppedOverrides), never silent.
import { signal, computed } from '@preact/signals';
import type { Result, Settings } from './types';
import type { LogEntry } from './client';

const KEY = 'laboratory.settings';
const SAVE_VERSION = 2;

/** the fields /lab-config.json owns; every other setting belongs to the user */
export const SERVER_KEYS = ['labUrl', 'hostileUrl', 'baseUrl', 'anonKey', 'tenantKey', 'realtimeToken', 'wafHost'] as const;
export type ServerKey = (typeof SERVER_KEYS)[number];
const isServerKey = (k: string): k is ServerKey => (SERVER_KEYS as readonly string[]).includes(k);

interface Saved {
  v: number;
  overrides: Record<string, unknown>;
  /** the server value each override replaced, to notice when it moves */
  serverSeen: Record<string, unknown>;
}

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
/** what the user typed over the container's configuration */
export const overrides = signal<Record<string, unknown>>({});
/** overrides discarded at load because the bench's configuration moved under them */
export const droppedOverrides = signal<string[]>([]);

/** the server-owned settings this page is *not* taking from the container */
export const overriddenKeys = computed(() => Object.keys(overrides.value).filter(isServerKey));

export const okCount = computed(() => Object.values(results.value).filter((r) => r.ok && !r.skipped).length);
export const failCount = computed(() => Object.values(results.value).filter((r) => !r.ok && !r.skipped).length);

function persist() {
  const server = configuredFromServer.value as Record<string, unknown>;
  const seen: Record<string, unknown> = {};
  for (const k of Object.keys(overrides.value)) if (isServerKey(k)) seen[k] = server[k];
  const saved: Saved = { v: SAVE_VERSION, overrides: overrides.value, serverSeen: seen };
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* private mode, a full quota: the bench still works, it just forgets */
  }
}

function applyTheme(s: Settings) {
  document.documentElement.dataset.theme = s.theme;
}

export function saveSettings(patch: Partial<Settings>) {
  const next = { ...settings.value, ...patch };
  const server = configuredFromServer.value as Record<string, unknown>;
  const ov = { ...overrides.value };
  for (const k of Object.keys(patch)) {
    const value = (next as Record<string, unknown>)[k];
    // typing the server's own value back in is not an override: it means
    // "follow the container again", so the field goes back to the config.
    if (isServerKey(k) && server[k] !== undefined && value === server[k]) delete ov[k];
    else ov[k] = value;
  }
  overrides.value = ov;
  settings.value = next;
  persist();
  applyTheme(next);
}

export function setKnob(key: string, value: string | number | boolean) {
  saveSettings({ knobs: { ...settings.value.knobs, [key]: value } });
}

/** drop one override and take the container's value for that field again */
export function revertSetting(key: string) {
  const ov = { ...overrides.value };
  delete ov[key];
  overrides.value = ov;
  settings.value = { ...defaults, ...configuredFromServer.value, ...(ov as Partial<Settings>) };
  persist();
  applyTheme(settings.value);
}

export function resetSettings() {
  overrides.value = {};
  droppedOverrides.value = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
  settings.value = { ...defaults, ...configuredFromServer.value };
  applyTheme(settings.value);
}

// defaults <- /lab-config.json (the container's env) <- the user's overrides
export async function loadSettings() {
  let fromServer: Partial<Settings> = {};
  try {
    const r = await fetch('/lab-config.json', { cache: 'no-store' });
    if (r.ok) fromServer = (await r.json()) as Partial<Settings>;
  } catch {
    /* a dev server without the nginx template: defaults stand */
  }
  configuredFromServer.value = fromServer;

  let raw: string | null = null;
  let saved: Partial<Saved> = {};
  try {
    raw = localStorage.getItem(KEY);
    saved = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
  } catch {
    saved = {};
  }

  const server = fromServer as Record<string, unknown>;
  const dropped: string[] = [];
  const ov: Record<string, unknown> = {};
  if (saved.v === SAVE_VERSION && saved.overrides) {
    const seen = saved.serverSeen || {};
    for (const [k, v] of Object.entries(saved.overrides)) {
      if (isServerKey(k) && server[k] !== undefined) {
        // the container now says something else than when this override was
        // made: the .env moved, the VM was rebuilt, the key was rotated. The
        // container wins -- a stale key here is what makes a whole bench red.
        if (server[k] !== seen[k]) {
          dropped.push(k);
          continue;
        }
        if (server[k] === v) continue;
      }
      ov[k] = v;
    }
  } else if (raw) {
    // a v1 blob is a snapshot of everything, so there is no way to tell what
    // the user chose from what was merely copied: none of it is trustworthy.
    dropped.push('settings saved by an older Laboratory');
  }

  const knobs = (ov.knobs as Settings['knobs']) || {};
  settings.value = { ...defaults, ...fromServer, ...(ov as Partial<Settings>), knobs: { ...knobs } };
  overrides.value = ov;
  droppedOverrides.value = dropped;
  persist();
  applyTheme(settings.value);
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
