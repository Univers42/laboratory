// Every probe the bench registers, minus the opt-in ones, run through the
// same bridge the buttons use. A skipped probe reports why and passes;
// a failed step fails the test with the step's detail in the message.
import { test, expect } from '@playwright/test';
import { openLab, listProbes, runProbe, expectOk } from './fixtures';

test('every probe passes on the lab origin', async ({ page }) => {
  await openLab(page);
  const probes = await listProbes(page);
  expect(probes.length).toBeGreaterThan(8);
  for (const p of probes) {
    if (p.needs.includes('optIn')) continue;
    await test.step(p.id, async () => {
      await page.click(`[data-testid="probe-${p.id}"]`);
      const r = await runProbe(page, p.id, false);
      if (r.skipped) {
        test.info().annotations.push({ type: 'skipped', description: `${p.id}: ${r.skipped}` });
        return;
      }
      expectOk(r, p.id);
      await expect(page.locator(`[data-testid="probe-${p.id}"] .dot`)).toHaveAttribute('data-state', 'ok');
      await page.screenshot({ path: `report/shots/${test.info().project.name}-${p.id}.png` });
    });
  }
  await expect(page.locator('[data-testid="request-log"] tbody tr').first()).toBeVisible();
});
