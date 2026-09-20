// The bench holds the gateway and its keys in localStorage. This is the test
// that the owner's screen cannot come back: a saved blob from an earlier
// session must never outlive the configuration it was saved against -- when
// it did, all fourteen probes went red and the screen blamed the schema.
import { test, expect } from '@playwright/test';
import { listProbes, runProbe, openLab } from './fixtures';

const KEY = 'laboratory.settings';
const STALE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.notthekeythisgrobasesigned';

async function served(page: import('@playwright/test').Page) {
  return page.evaluate(() => fetch('/lab-config.json', { cache: 'no-store' }).then((r) => r.json() as Promise<Record<string, string>>));
}

test('a settings blob from an older Laboratory is discarded, not obeyed', async ({ page }) => {
  test.setTimeout(240000);
  // exactly what version 1 wrote: the whole merged object, keys included
  await page.addInitScript(
    ([k, anon]) =>
      localStorage.setItem(
        k,
        JSON.stringify({ labUrl: 'http://localhost:5180', hostileUrl: 'http://localhost:5181', baseUrl: 'http://localhost:5174', anonKey: anon, tenantKey: '', realtimeToken: '', wafHost: '', castSize: 2, theme: 'dark', knobs: {} }),
      ),
    [KEY, STALE_ANON] as const,
  );
  await openLab(page);

  await expect(page.getByTestId('dropped-banner')).toBeVisible();
  const cfg = await served(page);
  const live = await page.evaluate(() => (window as unknown as { laboratory: { settings(): { anonKey: string } } }).laboratory.settings());
  expect(live.anonKey, "the container key wins over the saved one").toBe(cfg.anonKey);

  // and the whole bench is green again, which is the point of all this
  for (const p of await listProbes(page)) {
    const r = await runProbe(page, p.id);
    const bad = (r.steps || []).filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail || ''}`);
    expect(r.ok, `${p.id}: ${r.error || ''} ${bad.join(' | ')}`).toBe(true);
  }
});

test('an override the user typed is kept, flagged, and revertible', async ({ page }) => {
  await openLab(page);
  const cfg = await served(page);

  await page.evaluate(
    ([anon]) => (window as unknown as { laboratory: { configure(p: Record<string, unknown>): void } }).laboratory.configure({ anonKey: anon }),
    [STALE_ANON] as const,
  );
  await expect(page.getByTestId('override-banner')).toContainText('anonKey');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('laboratory.settings') || '{}').overrides.anonKey)).toBe(STALE_ANON);

  await page.getByTestId('revert-anonKey').click();
  await expect(page.getByTestId('override-banner')).toHaveCount(0);
  const live = await page.evaluate(() => (window as unknown as { laboratory: { settings(): { anonKey: string } } }).laboratory.settings());
  expect(live.anonKey).toBe(cfg.anonKey);
});

test('an override is dropped when the container is reconfigured under it', async ({ page }) => {
  // a v2 save whose remembered server value is not what the container serves
  // now: the .env moved, so the override goes and the bench says so
  await page.addInitScript(
    ([k, anon]) => localStorage.setItem(k, JSON.stringify({ v: 2, overrides: { anonKey: anon }, serverSeen: { anonKey: 'a key this container no longer serves' } })),
    [KEY, STALE_ANON] as const,
  );
  await openLab(page);

  await expect(page.getByTestId('dropped-banner')).toContainText('anonKey');
  const cfg = await served(page);
  const live = await page.evaluate(() => (window as unknown as { laboratory: { settings(): { anonKey: string } } }).laboratory.settings());
  expect(live.anonKey).toBe(cfg.anonKey);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('laboratory.settings') || '{}').overrides || {}))).toEqual([]);
});

test('knobs survive a reload, credentials still follow the container', async ({ page }) => {
  await openLab(page);
  await page.evaluate(() => {
    const lab = (window as unknown as { laboratory: { configure(p: Record<string, unknown>): void } }).laboratory;
    lab.configure({ castSize: 3, theme: 'light' });
  });
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { laboratory?: { ready?: boolean } }).laboratory?.ready === true);
  const cfg = await served(page);
  const live = await page.evaluate(() => (window as unknown as { laboratory: { settings(): { castSize: number; theme: string; anonKey: string } } }).laboratory.settings());
  expect(live.castSize).toBe(3);
  expect(live.theme).toBe('light');
  expect(live.anonKey).toBe(cfg.anonKey);
});
