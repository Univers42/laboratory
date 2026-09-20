// The probe contract. A probe is data plus one async function; the UI
// renders it, Playwright drives it through window.laboratory, and the
// Slide serialises its Result. Nothing here knows about grobase: the bench
// (src/probes) does.
import type { ApiClient } from './client';
import type { Culture } from './cultures';

export type Group = 'reach' | 'cors' | 'auth' | 'data' | 'realtime' | 'storage' | 'limits' | 'engines';

export const GROUPS: { id: Group; title: string; blurb: string }[] = [
  { id: 'reach', title: 'Reach', blurb: 'Is the platform there, how far away is it, through which door.' },
  { id: 'cors', title: 'CORS', blurb: 'What a browser on this origin is allowed to ask, and what a stranger is refused.' },
  { id: 'auth', title: 'Auth', blurb: 'Sign up, sign in, refresh, sign out, and the ways it must say no.' },
  { id: 'data', title: 'Data', blurb: 'Rows in, rows out, filters, pages, and row-level security between cultures.' },
  { id: 'realtime', title: 'Realtime', blurb: 'Changes, presence and broadcast between two people, on one canvas.' },
  { id: 'storage', title: 'Storage', blurb: 'Buckets, uploads, signed URLs, and the bytes coming back equal.' },
  { id: 'limits', title: 'Limits', blurb: 'The gateway pushing back. Opt-in: it locks the door for a minute.' },
  { id: 'engines', title: 'Engines', blurb: 'The other doors of the multi-engine BaaS, and the tenant you were issued.' },
];

export interface Step {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

export interface Result {
  id: string;
  ok: boolean;
  skipped?: string;
  steps: Step[];
  evidence?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  ms: number;
}

// auth: every culture in the cast signed in · cast2: at least two cultures
// schema: the bench tables exist · tenantKey: a tenant key is configured
// optIn: never part of "Run all" (it changes state you did not ask for)
export type Need = 'auth' | 'cast2' | 'schema' | 'tenantKey' | 'optIn';

export interface KnobSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'toggle';
  options?: string[];
  default: string | number | boolean;
  help?: string;
}

export interface Settings {
  labUrl: string;
  hostileUrl: string;
  baseUrl: string;
  anonKey: string;
  tenantKey: string;
  wafHost: string;
  castSize: number;
  theme: 'dark' | 'light';
  knobs: Record<string, string | number | boolean>;
}

export interface LabCtx {
  settings: Settings;
  api: ApiClient;
  /** the cast: castSize cultures, signed in when the probe needs auth */
  cast: Culture[];
  /** this page's own culture (?culture=linus), always cast[0] */
  me: Culture;
  knob<T = string>(key: string): T;
  /** run one timed step; a throw is a failed step, not a crashed probe */
  step(name: string, fn: () => Promise<string | void>): Promise<boolean>;
  expect(name: string, cond: boolean, detail?: string): boolean;
  /** live state for the probe's View, e.g. cursors or a presence roster */
  view(state: unknown): void;
  signal: AbortSignal;
  steps: Step[];
}

export interface Probe {
  id: string;
  group: Group;
  title: string;
  blurb: string;
  needs?: Need[];
  knobs?: KnobSpec[];
  run(ctx: LabCtx): Promise<{ ok?: boolean; evidence?: Record<string, unknown>; skipped?: string } | void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  View?: (props: { state: any; result?: Result }) => any;
}
