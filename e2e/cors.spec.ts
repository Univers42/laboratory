// CORS from a browser's point of view: the lab origin passes, and the
// stranger origin (same app, port 5181, not in the gateway's list) gets
// nothing. The stranger page runs its own bench -- every probe there asks to
// be refused -- because listing the lab's probes on it only produced red dots
// that meant the gateway was working.
import { test, expect } from '@playwright/test';
import { openLab, runProbe, expectOk, listProbes, HOSTILE } from './fixtures';

test('lab origin passes, hostile origin is refused', async ({ page, browser }) => {
  await openLab(page);
  expectOk(await runProbe(page, 'cors.origin'), 'cors.origin on the lab origin');
  await page.click('[data-testid="probe-cors.hostile"]');
  const h = await runProbe(page, 'cors.hostile');
  expectOk(h, 'cors.hostile (iframe)');
  await page.screenshot({ path: `report/shots/${test.info().project.name}-cors-iframe.png` });

  // the stranger origin runs its own bench: same registry, inverted question
  const ctx = await browser.newContext();
  const hp = await ctx.newPage();
  await openLab(hp, 'ada', HOSTILE);
  // the page must say what it is: a different bench, not a broken one
  await expect(hp.locator('.stranger-banner')).toContainText('must be');
  await expect(hp.locator('.stranger-banner')).toContainText('3 probes');
  await expect(hp.getByTestId('to-the-bench')).toHaveAttribute('href', /5180/);

  const ids = (await listProbes(hp)).map((p) => p.id);
  expect(ids, 'the stranger page shows the stranger bench, not the lab one').toEqual(['stranger.doors', 'stranger.socket', 'stranger.bench']);
  for (const id of ids) {
    await hp.click(`[data-testid="probe-${id}"]`);
    expectOk(await runProbe(hp, id), `${id} from ${HOSTILE}`);
  }
  // every REST door, named on the canvas, so a door that quietly opens cannot
  // hide inside a count. The canvas shows the selected probe, so select it.
  await hp.click('[data-testid="probe-stranger.doors"]');
  const doors = await hp.locator('[data-testid="stranger-doors"] tbody tr').allTextContents();
  expect(doors.length).toBe(6);
  expect(doors.join(' '), 'a door that let the stranger in').not.toContain('LET IN');
  // the page must say in words that a full house of refusals is a pass --
  // six rows reading "refused" were reported as six errors
  await expect(hp.getByTestId('doors-verdict')).toContainText('all 6 doors refused');
  await expect(hp.getByTestId('doors-verdict')).toHaveClass(/ok/);
  await hp.click('[data-testid="probe-stranger.socket"]');
  await expect(hp.locator('[data-testid="socket-verdict"]')).toHaveText(/refused/);
  // and the log under it must not read as a wall of failures
  await expect(hp.getByTestId('log-summary')).toContainText('0 unexpected');
  await hp.screenshot({ path: `report/shots/${test.info().project.name}-stranger.png` });
  await ctx.close();
});
