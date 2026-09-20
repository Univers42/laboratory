// The probes' own judgements, fed the inputs a healthy platform never
// produces. Everything else in this suite asks "did the probe say ok?", so a
// weakened judgement -- "blocked" that accepts any status, a change order that
// accepts any order, a burst that accepts no 429 -- would pass unnoticed.
// Mutation testing found exactly that (mutants/run.sh); these are the truth
// tables that kill it.
import { test, expect } from '@playwright/test';
import { openLab } from './fixtures';

type Rules = {
  blockedByBrowser(seen: { status?: number } | undefined): boolean;
  changeOrder(t: string[]): string;
  isFullChangeOrder(t: string[]): boolean;
  sawRateLimit(h: Record<string, number>): boolean;
};
const rules = (page: import('@playwright/test').Page, call: (r: Rules) => unknown) =>
  page.evaluate(`(${call.toString()})(window.laboratory.rules)`);

test.beforeEach(async ({ page }) => {
  await openLab(page);
});

test('"blocked as expected" means the browser gave the page nothing', async ({ page }) => {
  expect(await rules(page, (r) => r.blockedByBrowser({ status: 0 }))).toBe(true);
  // a gateway that let the stranger in: 200, 403, even a 500, all mean the
  // request was *not* stopped by the browser, and the probe must go red
  expect(await rules(page, (r) => r.blockedByBrowser({ status: 200 }))).toBe(false);
  expect(await rules(page, (r) => r.blockedByBrowser({ status: 403 }))).toBe(false);
  expect(await rules(page, (r) => r.blockedByBrowser({ status: 500 }))).toBe(false);
  expect(await rules(page, (r) => r.blockedByBrowser(undefined))).toBe(false);
});

test('the change order is the whole life of the row, in order', async ({ page }) => {
  expect(await rules(page, (r) => r.isFullChangeOrder(['inserted', 'updated', 'deleted']))).toBe(true);
  expect(await rules(page, (r) => r.isFullChangeOrder([]))).toBe(false);
  expect(await rules(page, (r) => r.isFullChangeOrder(['inserted']))).toBe(false);
  expect(await rules(page, (r) => r.isFullChangeOrder(['inserted', 'deleted']))).toBe(false);
  expect(await rules(page, (r) => r.isFullChangeOrder(['deleted', 'updated', 'inserted']))).toBe(false);
  expect(await rules(page, (r) => r.isFullChangeOrder(['inserted', 'updated', 'updated', 'deleted']))).toBe(false);
});

test('a burst that met no limit did not test the limit', async ({ page }) => {
  expect(await rules(page, (r) => r.sawRateLimit({ '200': 300, '429': 400 }))).toBe(true);
  expect(await rules(page, (r) => r.sawRateLimit({ '200': 700 }))).toBe(false);
  expect(await rules(page, (r) => r.sawRateLimit({}))).toBe(false);
  expect(await rules(page, (r) => r.sawRateLimit({ '429': 0 }))).toBe(false);
});
