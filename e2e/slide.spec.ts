// "Run all" through the button, then keep the Slide (JSON + Markdown) in
// report/, the artefact a person would download from the header.
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import { openLab } from './fixtures';

test('run all from the header and keep the slide', async ({ page }) => {
  await openLab(page);
  await page.click('[data-testid="run-all"]');
  await page.waitForFunction(
    () => {
      const lab = (window as unknown as { laboratory: { list(): { id: string; needs: string[] }[]; results(): Record<string, unknown> } }).laboratory;
      return lab.list().every((p) => p.needs.includes('optIn') || lab.results()[p.id]);
    },
    null,
    { timeout: 170_000 },
  );
  await expect(page.locator('[data-testid="run-all"]')).toHaveText('Run all');
  const slide = await page.evaluate(() => (window as unknown as { laboratory: { slide(): { json: { results: Record<string, { ok: boolean; skipped?: string }> }; markdown: string } } }).laboratory.slide());
  fs.mkdirSync('report', { recursive: true });
  fs.writeFileSync(`report/slide-${test.info().project.name}.json`, JSON.stringify(slide.json, null, 2));
  fs.writeFileSync(`report/slide-${test.info().project.name}.md`, slide.markdown);
  await page.screenshot({ path: `report/shots/${test.info().project.name}-bench.png` });
  const failed = Object.values(slide.json.results).filter((r) => !r.ok && !r.skipped);
  expect(failed, JSON.stringify(failed, null, 1)).toHaveLength(0);
});
