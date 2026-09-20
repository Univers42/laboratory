// CORS from a browser's point of view: the lab origin passes, the hostile
// origin (same app, port 5181, not in Kong's list) is refused by the
// browser itself. Green on the hostile page means "blocked as expected".
import { test, expect } from '@playwright/test';
import { openLab, runProbe, expectOk, HOSTILE } from './fixtures';

test('lab origin passes, hostile origin is refused', async ({ page, browser }) => {
  await openLab(page);
  expectOk(await runProbe(page, 'cors.origin'), 'cors.origin on the lab origin');
  await page.click('[data-testid="probe-cors.hostile"]');
  const h = await runProbe(page, 'cors.hostile');
  expectOk(h, 'cors.hostile (iframe)');
  await page.screenshot({ path: `report/shots/${test.info().project.name}-cors-iframe.png` });

  const ctx = await browser.newContext();
  const hp = await ctx.newPage();
  await openLab(hp, 'ada', HOSTILE);
  await expect(hp.locator('.hostile-banner')).toBeVisible();
  await hp.click('[data-testid="probe-cors.origin"]');
  const r = await runProbe(hp, 'cors.origin');
  expectOk(r, 'cors.origin on the hostile origin');
  expect(r.steps[0].detail).toContain('blocked');
  await hp.screenshot({ path: `report/shots/${test.info().project.name}-hostile-origin.png` });
  await ctx.close();
});
