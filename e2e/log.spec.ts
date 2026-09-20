// The request log has to be readable as a verdict.
//
// A full bench run makes hundreds of requests, and roughly half of them ask
// for a refusal on purpose: a wrong password, a call with no key, a burst
// past the rate limit. The log graded them all on "did it return 2xx", so
// fourteen green probes sat above 408 red rows -- which is what a platform
// on fire looks like. These tests pin the two things that fixed it: a probe
// declares the answer it wants, and identical requests fold into one row.
import { test, expect } from '@playwright/test';
import { openLab } from './fixtures';

interface Row {
  method: string;
  status: number;
  ok: boolean;
  want?: string;
  met?: boolean;
  count?: number;
  why?: string;
}

const unexpected = (rows: Row[]) => rows.filter((e) => e.met === false || (e.met === undefined && !e.ok));

test('a green bench leaves no unexplained red row', async ({ page }) => {
  await openLab(page);
  await page.evaluate(() => window.laboratory.runAll());
  // realtime sockets close a moment after their probe returns
  await page.waitForTimeout(2500);
  const rows = (await page.evaluate(() => window.laboratory.log())) as unknown as Row[];
  const results = await page.evaluate(() => window.laboratory.results());
  const red = Object.values(results).filter((r) => !r.ok);
  expect(red.map((r) => r.id), 'every probe must pass before the log is judged').toEqual([]);
  const bad = unexpected(rows);
  expect(
    bad.map((e) => `${e.method} ${e.status} want=${e.want ?? 'none'}`),
    'a request the bench did not ask for: either the platform changed or a probe forgot to say what it wanted',
  ).toEqual([]);
  await expect(page.getByTestId('log-summary')).toContainText('0 unexpected');
});

test('a refusal a probe asked for is not a failure', async ({ page }) => {
  await openLab(page);
  await page.evaluate(() => window.laboratory.run('auth.lifecycle', true));
  const rows = (await page.evaluate(() => window.laboratory.log())) as unknown as Row[];
  const wrongPassword = rows.find((e) => e.want !== undefined && e.status === 400);
  expect(wrongPassword, 'the wrong-password step must declare what it wanted').toBeTruthy();
  expect(wrongPassword!.met).toBe(true);
  expect(wrongPassword!.why, 'and say why that answer is the right one').toBeTruthy();
  // the row is painted as expected, not as an error
  await expect(page.locator('[data-testid="request-log"] tr[data-verdict="expected"]').first()).toBeVisible();
});

test('a burst is one row with a count, not seven hundred rows', async ({ page }) => {
  await openLab(page);
  await page.evaluate(() => window.laboratory.run('limits.burst', true));
  const rows = (await page.evaluate(() => window.laboratory.log())) as unknown as Row[];
  const burst = rows.filter((e) => e.count && e.count > 1);
  expect(burst.length, 'identical requests must fold').toBeGreaterThan(0);
  expect(Math.max(...burst.map((e) => e.count || 1))).toBeGreaterThan(20);
  // folding is what keeps the 500-row cap from evicting everything else
  expect(rows.length, 'the burst must not fill the log').toBeLessThan(120);
  expect(unexpected(rows), 'a rate-limited burst is not a fault').toEqual([]);
});
