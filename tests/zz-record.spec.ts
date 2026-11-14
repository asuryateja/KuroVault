// Demo recording (only runs when SHOT_DIR is set): reuses the operator session from console.spec.ts.
import { test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = process.env.SHOT_DIR;
test.skip(!SHOT_DIR, 'demo recording only');

async function run(browser: any, name: string, size: { width: number; height: number }, mobile: boolean, steps: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ storageState: join(SHOT_DIR!, 'state.json'), viewport: size, isMobile: mobile, hasTouch: mobile, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.7' }, recordVideo: { dir: join(SHOT_DIR!, `vid-${name}`), size } });
  const page = await ctx.newPage();
  await steps(page);
  await ctx.close();
}

test('record desktop viewer', async ({ browser }) => {
  test.skip(!existsSync(join(SHOT_DIR!, 'state.json')));
  await run(browser, 'desktop', { width: 1280, height: 760 }, false, async page => {
    await page.goto('/#drive');
    await page.getByRole('button', { name: 'Grid view' }).click();
    await page.getByRole('button', { name: 'Expand Documents' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('treeitem', { name: 'Media' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Open Night patrol.webm' }).click();
    await page.waitForTimeout(600);
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await page.waitForTimeout(2600);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1200);
    await page.locator('.viewer-panel').hover();
    await page.getByRole('button', { name: 'Next file' }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Previous file' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Previous file' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Next file' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Next file' }).click();
    await page.waitForTimeout(2600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await page.getByRole('treeitem', { name: 'Documents' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Actions for Quarterly report.pdf' }).first().click();
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open Quarterly report.pdf' }).first().click();
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await page.waitForTimeout(900);
  });
});

test('record phone viewer', async ({ browser }) => {
  test.skip(!existsSync(join(SHOT_DIR!, 'state.json')));
  await run(browser, 'phone', { width: 390, height: 780 }, true, async page => {
    await page.goto('/#drive');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.waitForTimeout(900);
    await page.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: 'Vault' }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Browse folders' }).click();
    await page.waitForTimeout(900);
    await page.getByRole('complementary', { name: 'Vault navigation' }).getByRole('treeitem', { name: 'Media' }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Open Briefing.mp4' }).click();
    await page.waitForTimeout(500);
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Close viewer' }).click();
    await page.waitForTimeout(900);
  });
});
