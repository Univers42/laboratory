// Two browser contexts, two cultures, one topic: Ada and Linus run the
// "meet" probe at the same time and each must see the other's cursor
// arrive through the database. Then the one-page probes: changes (must
// pass) and presence/broadcast (skips with the reason when the deployed
// realtime image lacks them).
import { test, expect } from '@playwright/test';
import { openLab, runProbe, expectOk, setKnob } from './fixtures';

test('Ada and Linus meet on the realtime canvas from two browser contexts', async ({ browser }) => {
  const cA = await browser.newContext();
  const cB = await browser.newContext();
  const a = await cA.newPage();
  const b = await cB.newPage();
  await openLab(a, 'ada');
  await openLab(b, 'linus');
  for (const p of [a, b]) {
    await setKnob(p, 'realtime.meet.waitMs', 40000);
    await p.click('[data-testid="probe-realtime.meet"]');
  }
  const [ra, rb] = await Promise.all([runProbe(a, 'realtime.meet'), runProbe(b, 'realtime.meet')]);
  expectOk(ra, 'Ada meets Linus');
  expectOk(rb, 'Linus meets Ada');
  await expect(a.locator('[data-testid="roster"]')).toContainText('Linus');
  await expect(b.locator('[data-testid="roster"]')).toContainText('Ada');
  await expect(a.locator('[data-testid="cursor-field"] .cursor[data-name="Linus"]')).toBeVisible();
  await expect(b.locator('[data-testid="cursor-field"] .cursor[data-name="Ada"]')).toBeVisible();
  await a.screenshot({ path: `report/shots/${test.info().project.name}-meet-ada.png` });
  await b.screenshot({ path: `report/shots/${test.info().project.name}-meet-linus.png` });

  await a.click('[data-testid="probe-realtime.changes"]');
  expectOk(await runProbe(a, 'realtime.changes'), 'realtime.changes');
  await a.screenshot({ path: `report/shots/${test.info().project.name}-changes.png` });
  await a.click('[data-testid="probe-realtime.together"]');
  const together = await runProbe(a, 'realtime.together');
  const hasToken = await a.evaluate(() => !!(window as unknown as { laboratory: { settings(): { realtimeToken: string } } }).laboratory.settings().realtimeToken);
  if (!hasToken && together.skipped) test.info().annotations.push({ type: 'skipped', description: `realtime.together: ${together.skipped}` });
  else {
    expectOk(together, 'realtime.together');
    await expect(a.locator('[data-testid="roster"]')).toContainText('Ada');
    await a.screenshot({ path: `report/shots/${test.info().project.name}-together.png` });
  }
  await cA.close();
  await cB.close();
});
