// Two browser contexts, two cultures, one topic: Ada and Linus run the
// "meet" probe at the same time and each must see the other's presence
// and cursor. Then the one-page two-culture probe for the full wire.
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
  await a.screenshot({ path: `report/shots/${test.info().project.name}-meet-ada.png` });
  await b.screenshot({ path: `report/shots/${test.info().project.name}-meet-linus.png` });

  await a.click('[data-testid="probe-realtime.together"]');
  expectOk(await runProbe(a, 'realtime.together'), 'realtime.together');
  await a.screenshot({ path: `report/shots/${test.info().project.name}-together.png` });
  await cA.close();
  await cB.close();
});
