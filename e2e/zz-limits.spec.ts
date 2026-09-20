// Last on purpose (alphabetical, one worker): the burst throttles this
// address on the auth route for up to a minute, so nothing may run after.
// Forced through the bridge because it is opt-in in the UI.
import { test, expect } from '@playwright/test';
import { openLab, runProbe, expectOk } from './fixtures';

test('the gateway pushes back with 429 under a burst', async ({ page }) => {
  await openLab(page);
  await page.click('[data-testid="probe-limits.burst"]');
  const r = await runProbe(page, 'limits.burst', true);
  expectOk(r, 'limits.burst');
  const hist = (r.evidence as { hist: Record<string, number> }).hist;
  expect(hist['429'] ?? 0).toBeGreaterThan(0);
  // the limited route's upstream may not exist in this tier (503): what
  // matters is that requests reached Kong's proxying before the 429s began
  const reached = Object.entries(hist).filter(([k]) => k !== '429' && k !== '0').reduce((a, [, v]) => a + v, 0);
  expect(reached).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'histogram', description: JSON.stringify(hist) });
  await page.screenshot({ path: `report/shots/${test.info().project.name}-limits.burst.png` });
});
