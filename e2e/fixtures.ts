import { expect, type Page } from '@playwright/test';

export const HOSTILE = process.env.HOSTILE_URL || 'http://localhost:5181';

export interface ProbeResult {
  id: string;
  ok: boolean;
  skipped?: string;
  error?: string;
  steps: { name: string; ok: boolean; detail?: string; ms?: number }[];
  evidence?: Record<string, unknown>;
}

/** open the bench as a culture and wait for the window.laboratory bridge */
export async function openLab(page: Page, culture = 'ada', origin = ''): Promise<void> {
  await page.goto(`${origin}/?culture=${culture}`);
  await page.waitForFunction(() => (window as unknown as { laboratory?: { ready?: boolean } }).laboratory?.ready === true);
}

export function listProbes(page: Page): Promise<{ id: string; group: string; title: string; needs: string[] }[]> {
  return page.evaluate(() => (window as unknown as { laboratory: { list(): { id: string; group: string; title: string; needs: string[] }[] } }).laboratory.list());
}

export function runProbe(page: Page, id: string, force = true): Promise<ProbeResult> {
  return page.evaluate(([pid, f]) => (window as unknown as { laboratory: { run(id: string, force: boolean): Promise<ProbeResult> } }).laboratory.run(pid, f), [id, force] as const);
}

export function setKnob(page: Page, key: string, value: unknown): Promise<void> {
  return page.evaluate(
    ([k, v]) => {
      const lab = (window as unknown as { laboratory: { settings(): { knobs: Record<string, unknown> }; configure(p: Record<string, unknown>): void } }).laboratory;
      lab.configure({ knobs: { ...lab.settings().knobs, [k]: v } });
    },
    [key, value] as const,
  );
}

export function expectOk(r: ProbeResult, label: string): void {
  const bad = r.steps.filter((s) => !s.ok).map((s) => `${s.name}${s.detail ? ': ' + s.detail : ''}`);
  expect(r.ok, `${label} failed: ${r.error || ''} ${bad.join(' | ')}`).toBe(true);
}
