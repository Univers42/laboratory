// The probe registry and the runner. window.laboratory is the Playwright
// bridge: what the suite calls is exactly what the buttons call.
import { ApiClient } from './client';
import { cast as buildCast, ensureSession, CULTURES, type Culture } from './cultures';
import { settings, setResult, setRunning, setView, results, log, isHostile } from './store';
import type { LabCtx, Probe, Result, Step } from './types';
import { RULES } from '../probes/rules';

const REG: Probe[] = [];

export function registerProbe(p: Probe) {
  if (!REG.some((x) => x.id === p.id)) REG.push(p);
}
export function listProbes(): Probe[] {
  return REG.slice();
}
export function probeById(id: string): Probe | undefined {
  return REG.find((p) => p.id === id);
}

export function knobKey(probeId: string, key: string) {
  return `${probeId}.${key}`;
}

export function knobValue<T = string>(p: Probe, key: string): T {
  const spec = p.knobs?.find((k) => k.key === key);
  const v = settings.value.knobs[knobKey(p.id, key)];
  return (v === undefined ? spec?.default : v) as T;
}

type Preflight = { ok: true } | { ok: false; error: string };
let preflight: { key: string; result: Preflight } | undefined;

// One call to lab_ping can fail for three very different reasons, and telling
// them apart is the difference between "apply the schema" and "the key in
// your browser belongs to a grobase that no longer exists". The second wore
// the first's message for a while: a whole bench went red pointing at the
// database while the database was fine.
function diagnose(status: number, text: string): Preflight {
  if (status === 200) return { ok: true };
  if (status === 0)
    return {
      ok: false,
      error: `the gateway did not answer ${location.origin} -- network or CORS (${text.slice(0, 90)}); check "door" in the knobs, and that this origin is in the gateway's CORS list`,
    };
  if (status === 401 || status === 403)
    return {
      ok: false,
      error: `the gateway refused the anon key (HTTP ${status}): it is invalid, expired, or from an earlier grobase. Press "forget my settings" in the knobs; if it persists, fix GROBASE_ANON_KEY in .env and re-run make up`,
    };
  if (status === 404 || /PGRST2\d\d/.test(text))
    return { ok: false, error: 'bench schema missing: make -C born2root sql FILE=schema/001_grobase_bench.sql B2B_CONFIG=profiles/server.toml' };
  return { ok: false, error: `the gateway answered HTTP ${status} to lab_ping: ${text.slice(0, 140)}` };
}

// Cached per (gateway, key) pair, so changing either in the knobs re-checks
// without anything having to remember to invalidate it.
async function gatewayReady(api: ApiClient): Promise<Preflight> {
  const key = `${api.base}|${api.anonKey}`;
  if (preflight?.key === key) return preflight.result;
  const r = await api.req('/rest/v1/rpc/lab_ping', { method: 'POST', body: {} });
  const result = diagnose(r.status, r.text || '');
  preflight = { key, result };
  return result;
}

export async function runProbe(id: string, opts: { force?: boolean } = {}): Promise<Result> {
  const p = probeById(id);
  if (!p) throw new Error(`no probe ${id}`);
  const s = settings.value;
  const api = new ApiClient(s.baseUrl, s.anonKey);
  const startedAt = Date.now();
  const t0 = performance.now();
  const steps: Step[] = [];
  const ac = new AbortController();
  setRunning(id, true);
  const finish = (r: Omit<Result, 'id' | 'startedAt' | 'ms'>): Result => {
    const out: Result = { id, startedAt, ms: Math.round(performance.now() - t0), ...r };
    setResult(out);
    setRunning(id, false);
    return out;
  };
  const ctx: LabCtx = {
    settings: s,
    api,
    cast: buildCast(s.castSize),
    me: buildCast(1)[0],
    knob: <T,>(key: string) => knobValue<T>(p, key),
    steps,
    signal: ac.signal,
    view: (state) => setView(id, state),
    async step(name, fn) {
      const st = performance.now();
      try {
        const detail = await fn();
        steps.push({ name, ok: true, ms: Math.round(performance.now() - st), detail: detail || undefined });
        return true;
      } catch (e) {
        steps.push({ name, ok: false, ms: Math.round(performance.now() - st), detail: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    expect(name, cond, detail) {
      steps.push({ name, ok: cond, detail });
      return cond;
    },
  };
  try {
    const needs = p.needs || [];
    if (needs.includes('optIn') && !opts.force && !knobValue<boolean>(p, 'optIn')) {
      return finish({ ok: true, skipped: 'opt-in: tick "I mean it" in the knobs, or run it alone', steps });
    }
    if (needs.includes('tenantKey') && !s.tenantKey) {
      return finish({ ok: true, skipped: 'no tenant key configured (GROBASE_TENANT_KEY / knobs)', steps });
    }
    if (needs.includes('cast2') && ctx.cast.length < 2) {
      return finish({ ok: true, skipped: 'needs a cast of two: raise "cast size" in the knobs', steps });
    }
    if (needs.includes('schema')) {
      const pf = await gatewayReady(api);
      if (!pf.ok) return finish({ ok: false, error: pf.error, steps });
    }
    if (needs.includes('auth') || needs.includes('cast2')) {
      for (const c of ctx.cast) {
        const ok = await ctx.step(`${c.name} signed in`, async () => {
          const sess = await ensureSession(api, c);
          return sess.user.email;
        });
        if (!ok) {
          // a failed sign-in is usually not about the password: ask the
          // gateway what is actually wrong before blaming the culture.
          const pf = await gatewayReady(api);
          return finish({ ok: false, steps, error: pf.ok ? `${c.name} could not sign in` : pf.error });
        }
      }
    }
    const out = (await p.run(ctx)) || {};
    if (out.skipped) return finish({ ok: true, skipped: out.skipped, steps });
    const ok = out.ok ?? steps.every((x) => x.ok);
    return finish({ ok, steps, evidence: out.evidence });
  } catch (e) {
    return finish({ ok: false, steps, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function runAll(): Promise<Result[]> {
  const out: Result[] = [];
  for (const p of REG) out.push(await runProbe(p.id));
  return out;
}

export function slide(): { json: Record<string, unknown>; markdown: string } {
  const s = settings.value;
  const rs = Object.values(results.value);
  const lines: string[] = [];
  lines.push(`# Laboratory slide — grobase bench`);
  lines.push('');
  lines.push(`- when: ${new Date().toISOString()}`);
  lines.push(`- origin: ${location.origin}${isHostile.value ? ' (hostile)' : ''}`);
  lines.push(`- gateway: ${s.baseUrl}`);
  lines.push(`- cast: ${buildCast(s.castSize).map((c) => c.name).join(', ')}`);
  lines.push('');
  lines.push('| probe | result | ms | steps |');
  lines.push('|---|---|---:|---|');
  for (const p of REG) {
    const r = results.value[p.id];
    const verdict = !r ? 'not run' : r.skipped ? `skipped (${r.skipped})` : r.ok ? 'ok' : 'FAIL';
    const bad = r?.steps.filter((x) => !x.ok).map((x) => `${x.name}${x.detail ? ': ' + x.detail : ''}`).join('; ');
    lines.push(`| ${p.group}/${p.title} | ${verdict} | ${r?.ms ?? ''} | ${r ? `${r.steps.filter((x) => x.ok).length}/${r.steps.length}` : ''}${bad ? ' — ' + bad : ''} |`);
  }
  const json = {
    when: new Date().toISOString(),
    origin: location.origin,
    hostile: isHostile.value,
    gateway: s.baseUrl,
    cast: buildCast(s.castSize).map((c) => c.id),
    results: rs,
    log: log.value.slice(-200),
  };
  return { json, markdown: lines.join('\n') + '\n' };
}

declare global {
  interface Window {
    laboratory: {
      list(): { id: string; group: string; title: string; needs: string[] }[];
      run(id: string, force?: boolean): Promise<Result>;
      runAll(): Promise<Result[]>;
      results(): Record<string, Result>;
      log(): unknown[];
      views(): Record<string, unknown>;
      cultures(): { id: string; name: string; signedIn: boolean }[];
      cast(): string[];
      settings(): unknown;
      slide(): { json: Record<string, unknown>; markdown: string };
      configure(patch: Record<string, unknown>): void;
      rules: typeof RULES;
      ready: boolean;
    };
  }
}

export function installBridge(configure: (patch: Record<string, unknown>) => void) {
  window.laboratory = {
    list: () => REG.map((p) => ({ id: p.id, group: p.group, title: p.title, needs: p.needs || [] })),
    run: (id, force) => runProbe(id, { force }),
    runAll,
    results: () => results.value,
    log: () => log.value,
    views: () => views_(),
    cultures: () => CULTURES.map((c: Culture) => ({ id: c.id, name: c.name, signedIn: !!c.session })),
    cast: () => buildCast(settings.value.castSize).map((c) => c.id),
    settings: () => settings.value,
    slide,
    configure,
    // the probes' own judgements, so a spec can feed them impossible inputs
    rules: RULES,
    ready: true,
  };
}

import { views } from './store';
function views_() {
  return views.value;
}
