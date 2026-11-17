// Direct-Telegram mode end to end: real server, database and browser UI.
// Only Telegram itself is simulated (server/telegram/adapter-fake.js, enabled by two env vars).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CODE, datasetBytes, featureFilm, PASSWORD as TG_PASSWORD } from '../server/telegram/adapter-fake.js';
import { TG_DATA_DIR, TG_URL } from '../playwright.config';

test.describe.configure({ mode: 'serial' });

const OPERATOR = 'watcher';
const PASSWORD = 'Copper-Lighthouse-58-Meadow';
const API_ID = '2040123';
const API_HASH = '5f1e9c0a7b3d42e8a6c1f0b9d8e7a6b5';
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
let context: BrowserContext;
const SHOT_DIR = process.env.SHOT_DIR;
async function shot(page: Page, name: string) { if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `tg-${name}.png`) }); }
async function rowMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).first().click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
function dbFilesContain(text: string) {
  return readdirSync(TG_DATA_DIR).some(f => {
    try { return readFileSync(join(TG_DATA_DIR, f)).includes(Buffer.from(text)); } catch { return false; }
  });
}
async function listView(page: Page, where?: string) {
  await page.goto('/#drive');
  await page.locator('.vnav').getByRole('tree', { name: 'Channels' }).waitFor();
  if (where === 'Saved Messages') await page.locator('.vnav').getByRole('button', { name: 'Saved Messages', exact: true }).click();
  else if (where) await page.locator('.vnav').getByRole('treeitem', { name: where }).click();
  if (where) await page.getByRole('button', { name: 'List view' }).click();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: TG_URL, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.90' } });
});
test.afterAll(async () => { await context?.close(); });

test('a new member registers with name, username and password and lands in the Vault', async () => {
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada Watcher');
  await page.getByLabel('Username').fill(OPERATOR);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  // By invitation only: no code or a wrong code creates nothing.
  const api = page.context().request;
  const attempt = (extra: Record<string, string>) => api.post('/api/auth/register', { data: { name: 'Eve', username: 'eve', password: 'Quiet-River-88', confirm: 'Quiet-River-88', ...extra } });
  expect((await attempt({})).status()).toBe(403);
  expect((await (await attempt({ invite: 'rook-takes-pawn' })).json()).error.code).toBe('BAD_INVITE');
  await page.getByLabel('Invitation code').fill('rook-takes-knight');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Vault', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar')).toContainText('Ada Watcher');
  await expect(page.locator('.topbar').getByRole('button', { name: 'Audit trail' })).toHaveCount(0);
  await page.close();
});

test('connects a Telegram account with phone code and two-step password; secrets stay sealed', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  const form = page.getByRole('form', { name: 'Connect Telegram' });
  await expect(form).toBeVisible();
  await shot(page, '1-connect');

  // Bad input is refused before anything reaches Telegram.
  await form.getByLabel('API ID').fill('12');
  await form.getByLabel('API hash').fill('nothex');
  await form.getByLabel('Phone number').fill('+15550001111');
  await form.getByRole('button', { name: 'Send login code' }).click();
  await expect(form.locator('.error-note')).toContainText('API ID');

  await form.getByLabel('API ID').fill(API_ID);
  await form.getByLabel('API hash').fill(API_HASH);
  await form.getByRole('button', { name: 'Send login code' }).click();
  const codeForm = page.getByRole('form', { name: 'Telegram login code' });
  await expect(codeForm).toContainText('other Telegram apps');
  await codeForm.getByLabel('Login code').fill('11111');
  await codeForm.getByRole('button', { name: 'Sign in' }).click();
  await expect(codeForm.locator('.error-note')).toBeVisible();
  await codeForm.getByLabel('Login code').fill(CODE);
  await codeForm.getByRole('button', { name: 'Sign in' }).click();
  const pwForm = page.getByRole('form', { name: 'Telegram two-step password' });
  await expect(pwForm).toContainText('Hint: bird');
  await pwForm.getByLabel('Two-step password').fill(TG_PASSWORD);
  await pwForm.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.locator('.vnav-source')).toContainText('@ada_ops');
  await expect(page.getByRole('treeitem', { name: 'Movies Archive' })).toBeVisible();

  const state = await (await page.request.get('/api/telegram/state')).text();
  expect(state).toContain('"connected":true');
  expect(state).not.toContain(API_HASH);
  expect(state).not.toContain('fake-session-valid');
  expect(dbFilesContain(API_HASH)).toBe(false);
  expect(dbFilesContain('fake-session-valid')).toBe(false);
  await page.close();
});

test('the Vault opens on a home organised like Telegram: Saved Messages, channels, groups and chats', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  const home = page.getByTestId('library-home');
  await expect(home).toBeVisible();
  await expect(page.locator('.crumbs')).toContainText('Home');
  await expect(home.getByRole('button', { name: /Saved Messages/ })).toBeVisible();
  for (const [section, chat] of [['Channels', 'Movies Archive'], ['Channels', 'News Feed'], ['Groups', 'Family'], ['Chats', 'Mom'], ['Chats', 'FileStore Bot']]) {
    await expect(home.getByRole('region', { name: section }).getByRole('button', { name: `Open ${chat}` })).toBeVisible();
  }
  await expect(home.getByRole('button', { name: 'Open FileStore Bot' })).toContainText('Bot');
  await expect(home.getByRole('button', { name: 'Open News Feed' })).toContainText('protected');
  // No "All files" list any more.
  await expect(page.locator('.vnav').getByRole('button', { name: 'All files' })).toHaveCount(0);
  // Search narrows the chats.
  await home.getByRole('searchbox', { name: 'Search your chats' }).fill('mom');
  await expect(home.getByRole('button', { name: /^Open / })).toHaveCount(1);
  await home.getByRole('button', { name: 'Open Mom' }).click();
  await expect(page.locator('.vault-title')).toHaveText('Mom');
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.table')).toContainText('Birthday 2026.webm');
  // Sidebar groups chats the same way, and a bot's files are there too.
  await page.locator('.vnav').getByRole('tree', { name: 'Chats' }).getByRole('treeitem', { name: 'FileStore Bot' }).click();
  await expect(page.locator('.table')).toContainText('The Harbor (2026) 1080p.mp4');
  await shot(page, '2-vault');
  await page.close();
});

// Phones: nothing may scroll the page sideways or stick out of the screen, and no field may be under 16px
// (iPhone Safari zooms the whole page in when such a field is tapped, which knocks the layout off-centre).
async function phoneLayoutProblems(page: Page) {
  await page.waitForTimeout(250);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => { try { return a.effect.getComputedTiming().iterations !== Infinity; } catch { return false; } }).map(a => a.finished.catch(() => {}))));
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.closest('.nav, .vault-side, .nav-scrim, .vault-scrim')) continue;
      let contained = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (getComputedStyle(a).overflowX !== 'visible') { const ar = a.getBoundingClientRect(); contained = ar.right <= vw + 1.5 && ar.left >= -1.5; break; } }
      if (!contained && (r.right > vw + 1.5 || r.left < -1.5)) out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out`);
    }
    for (const i of document.querySelectorAll<HTMLElement>('input:not([type=checkbox]):not([type=range]):not([type=file]), select, textarea'))
      if (i.getBoundingClientRect().width && parseFloat(getComputedStyle(i).fontSize) < 16) out.push(`${i.getAttribute('aria-label') ?? i.getAttribute('name') ?? 'field'} is under 16px`);
    return [...new Set(out)].slice(0, 8);
  });
}

for (const vp of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`phone ${vp.width}×${vp.height}: no sideways scrolling, nothing off-screen, no tap-zoom fields`, async ({ browser }) => {
    const state = await context.storageState();
    const opts = { baseURL: TG_URL, viewport: vp, isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.90' } };
    const guest = await browser.newContext(opts);
    const g = await guest.newPage();
    await g.goto('/');
    await expect(g.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await phoneLayoutProblems(g)).toEqual([]);
    await g.getByRole('tab', { name: 'Create account' }).click();
    expect(await phoneLayoutProblems(g)).toEqual([]);
    await guest.close();

    const member = await browser.newContext({ ...opts, storageState: state });
    const page = await member.newPage();
    await page.goto('/#drive');
    expect(await phoneLayoutProblems(page)).toEqual([]);
    await page.locator('.vnav').getByRole('button', { name: 'Saved Messages', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Feature Film.webm' }).first()).toBeVisible();
    expect(await phoneLayoutProblems(page)).toEqual([]);
    await page.getByRole('button', { name: 'Open Feature Film.webm' }).first().click();
    await expect(page.getByRole('button', { name: 'Prepare for smooth playback' })).toBeVisible();
    expect(await phoneLayoutProblems(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open Season 1 pack.zip' }).first().click();
    await page.getByTestId('archive-browser').waitFor();
    expect(await phoneLayoutProblems(page)).toEqual([]);
    await member.close();
  });
}

test('forwarded media gets clean names in Saved Messages', async () => {
  const page = await context.newPage();
  await listView(page, 'Saved Messages');
  const table = page.locator('.table');
  await expect(table).toContainText('Episode 12 — The Long Night.webm');
  await expect(table).toContainText(/Video \d{4}-\d{2}-\d{2} #102\.mp4/);
  await expect(table).toContainText('Night Watch.mp3');
  await expect(page.locator('tr', { hasText: 'Episode 12' }).first()).toContainText('fwd');
  await expect(table).not.toContainText('Harbor documentary.webm');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Grid view' }).click();
  await shot(page, '3-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('treeitem', { name: 'Movies Archive' }).click();
  await expect(table).toContainText('Harbor documentary.webm');
  await page.close();
});

test('video streams from Telegram with byte ranges, plays and seeks', async () => {
  const page = await context.newPage();
  const statuses: number[] = [];
  page.on('response', r => { if (r.url().includes('/files/101/stream')) statuses.push(r.status()); });
  await listView(page, 'Saved Messages');
  await page.getByRole('group', { name: 'File type' }).getByRole('button', { name: 'Videos' }).click();
  await page.locator('tr', { hasText: 'Episode 12' }).first().getByRole('button', { name: 'Open Episode 12 — The Long Night.webm', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Viewing Episode 12 — The Long Night.webm' });
  const video = viewer.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await video.evaluate((v: HTMLVideoElement) => new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 6; }));
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(5.9);
  expect(statuses).toContain(206);
  await viewer.getByRole('button', { name: 'Close viewer' }).click();
  await page.close();
});

async function openArchive(page: Page, name: string, where?: string) {
  await listView(page, where);
  await page.locator('tr', { hasText: name }).first().getByRole('button', { name: `Open ${name}`, exact: true }).click();
  const viewer = page.getByRole('dialog', { name: `Viewing ${name}` });
  const browser = viewer.getByTestId('archive-browser');
  await expect(browser).toBeVisible({ timeout: 20_000 });
  return { viewer, browser };
}

test('HEVC video the browser cannot decode plays from Telegram’s alternative encoding', async () => {
  const page = await context.newPage();
  const urls: string[] = [];
  page.on('request', r => { if (r.url().includes('/files/110/stream')) urls.push(r.url()); });
  await listView(page, 'Saved Messages');
  await page.locator('tr', { hasText: 'Episode 13.mp4' }).first().getByRole('button', { name: 'Open Episode 13.mp4', exact: true }).click();
  const video = page.getByRole('dialog', { name: 'Viewing Episode 13.mp4' }).locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  expect(urls.some(u => u.includes('variant=0'))).toBe(true);
  const meta = (await (await page.request.get('/api/drive/files?folder_id=home&limit=100')).json()).data.find((f: any) => f.id === 110);
  expect(meta.video_codec).toBe('h265');
  expect(meta.variants[0].codec).toBe('vp9');
  await page.close();
});

test('smooth playback: the server prepares a slow video, shows progress, then it plays from the prepared copy', async () => {
  const page = await context.newPage();
  await listView(page, 'Saved Messages');
  await page.locator('tr', { hasText: 'Feature Film.webm' }).first().getByRole('button', { name: 'Open Feature Film.webm', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Smooth playback' });
  await expect(card).toContainText('Watch without buffering');
  await card.getByRole('button', { name: 'Prepare for smooth playback' }).click();
  // Progress is shown while the server fetches the file from Telegram…
  await expect(card).toContainText('Preparing for smooth playback');
  await expect(card.getByRole('progressbar', { name: 'Downloaded to the server' })).toBeVisible();
  await expect(card).toContainText('from Telegram');
  // The bar visibly fills as the download progresses.
  await expect.poll(() => card.locator('.smooth-fill').evaluate(e => e.getBoundingClientRect().width), { timeout: 10_000 }).toBeGreaterThan(20);
  await shot(page, '9-preparing');
  // …until it is safe to play without stopping.
  await expect(card).toContainText('Ready — plays without buffering', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(card).toHaveCount(0);
  const video = page.getByRole('dialog', { name: 'Viewing Feature Film.webm' }).locator('video');
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await expect(page.locator('.smooth-chip')).toContainText('Prepared');

  const status = await (await page.request.get('/api/drive/files/112/prepare?folder_id=')).json();
  expect(status.state).toBe('ready');
  expect(status.percent).toBe(100);
  const film = featureFilm();
  for (const [a, b] of [[0, 999], [5_000_000, 5_000_999], [film.length - 10, film.length - 1]]) {
    const r = await page.request.get('/api/drive/files/112/stream', { headers: { Range: `bytes=${a}-${b}` } });
    expect(r.headers()['x-kurovault-source']).toBe('prepared');
    expect((await r.body()).equals(film.subarray(a, b + 1))).toBe(true);
  }
  await page.close();
});

test('smooth playback: progress, readiness and cancel through the API; only videos and audio can be prepared', async () => {
  const page = await context.newPage();
  await page.goto('/');
  const csrf = (await (await page.request.get('/api/auth/me')).json()).csrf;
  const h = { 'X-CSRF-Token': csrf };
  // Cancel the prepared copy and start again to watch the numbers move.
  await page.request.delete('/api/drive/files/112/prepare', { headers: h });
  expect((await (await page.request.get('/api/drive/files/112/prepare')).json()).state).toBe('none');
  const first = await (await page.request.post('/api/drive/files/112/prepare', { headers: h })).json();
  expect(first.state).toBe('downloading');
  await page.waitForTimeout(1500);
  const mid = await (await page.request.get('/api/drive/files/112/prepare')).json();
  expect(mid.received).toBeGreaterThan(0);
  expect(mid.rate).toBeGreaterThan(0);
  expect(mid.readyAtPercent).toBeGreaterThan(0);
  // Bytes not yet on the server still stream live from Telegram, so nothing ever waits.
  const tail = await page.request.get('/api/drive/files/112/stream', { headers: { Range: `bytes=${featureFilm().length - 100}-` } });
  expect((await tail.body()).equals(featureFilm().subarray(featureFilm().length - 100))).toBe(true);
  await page.request.delete('/api/drive/files/112/prepare', { headers: h });
  expect((await (await page.request.get('/api/drive/files/112/prepare')).json()).state).toBe('none');
  // Non-media files cannot be prepared.
  const pdf = await page.request.post('/api/drive/files/104/prepare', { headers: h });
  expect((await pdf.json()).error.code).toBe('NOT_MEDIA');
  await page.close();
});

test('when a video fails, the player shows the real reason from the server', async () => {
  const page = await context.newPage();
  await page.goto('/');
  // Ask for a quality that does not exist: the server answers with a JSON error, not a video.
  const r = await page.request.get('/api/drive/files/110/stream?variant=9');
  expect(r.status()).toBe(404);
  expect((await r.json()).error.message).toContain('quality');
  await page.close();
});

test('Telegram stays connected: sign out of this browser, sign back in, files are there at once', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.locator('.topbar').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.getByLabel('Username').fill(OPERATOR);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vault', level: 1 })).toBeVisible();
  await expect(page.locator('.vnav-source')).toContainText('@ada_ops');
  await expect(page.getByRole('form', { name: 'Connect Telegram' })).toHaveCount(0);
  await page.close();
});

test('each member has their own Telegram: another account sees nothing of this one', async ({ playwright }) => {
  const other = await playwright.request.newContext({ baseURL: TG_URL, extraHTTPHeaders: { 'X-Forwarded-For': '198.51.100.88' } });
  expect((await other.post('/api/auth/register', { data: { name: 'Bob', username: 'bob', password: 'Silver-Kettle-42', confirm: 'Silver-Kettle-42', invite: 'rook-takes-knight' } })).status()).toBe(200);
  const state = await (await other.get('/api/telegram/state')).json();
  expect(state.keyConfigured).toBe(false);
  expect(state.account).toBeNull();
  for (const path of ['/api/drive/files', '/api/drive/files?folder_id=home', '/api/archive/107', '/api/drive/files/101/stream']) {
    const r = await other.get(path);
    expect(r.status(), path).toBe(503);
    expect((await r.json()).error.code).toBe('TELEGRAM_NOT_CONNECTED');
  }
  expect((await other.get('/api/console/audit')).status()).toBe(403);
  await other.dispose();
});

test('ZIP: browse folders, then play video and audio straight out of the archive', async () => {
  const page = await context.newPage();
  const entryStatuses: number[] = [];
  page.on('response', r => { if (/\/api\/archive\/107\/entries\/\d+\/stream/.test(r.url())) entryStatuses.push(r.status()); });
  const { browser } = await openArchive(page, 'Season 1 pack.zip', 'Saved Messages');
  await expect(browser).toContainText('6 files');
  for (const folder of ['Season 1', 'Music', 'Docs', 'Photos']) await expect(browser.getByRole('button', { name: `Open folder ${folder}` })).toBeVisible();
  await expect(browser).toContainText('readme.txt');
  await shot(page, '6-zip');

  await browser.getByRole('button', { name: 'Open folder Season 1' }).click();
  await expect(browser.getByRole('navigation', { name: 'Archive path' })).toContainText('Season 1');
  if (SHOT_DIR) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, '7-zip-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await browser.getByRole('button', { name: 'Open Season 1/Episode 01.webm' }).click();
  const inner = page.getByRole('dialog', { name: 'Viewing Episode 01.webm' });
  const video = inner.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await video.evaluate((v: HTMLVideoElement) => new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 6; }));
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(5.9);
  expect(entryStatuses).toContain(206);
  await shot(page, '8-zip-video');
  // Next file inside the archive, then Escape closes only the inner viewer.
  await inner.getByRole('button', { name: 'Next file' }).click();
  await expect(page.getByRole('dialog', { name: 'Viewing Episode 02.mp4' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Viewing Episode/ })).toHaveCount(0);
  await expect(browser).toBeVisible();

  // Deflated entries: audio plays, the PDF renders, and search finds files in any folder.
  await browser.getByRole('searchbox', { name: 'Find in archive' }).fill('night');
  await browser.getByRole('button', { name: 'Open Music/Night Watch.mp3' }).click();
  const audio = page.getByRole('dialog', { name: 'Viewing Night Watch.mp3' }).locator('audio');
  await audio.evaluate((a: HTMLAudioElement) => { a.muted = true; return a.play(); });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await page.getByRole('dialog', { name: 'Viewing Night Watch.mp3' }).getByRole('button', { name: 'Close viewer' }).click();
  await browser.getByRole('searchbox', { name: 'Find in archive' }).fill('briefing');
  await browser.getByRole('button', { name: 'Open Docs/briefing.pdf' }).click();
  await expect(page.getByRole('dialog', { name: 'Viewing briefing.pdf' }).locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // Byte-exact extraction through the API, stored and deflated, whole and ranged.
  const list = await (await page.request.get('/api/archive/107')).json();
  const idx = (p: string) => list.entries.find((e: any) => e.path === p).index;
  const pdf = await page.request.get(`/api/archive/107/entries/${idx('Docs/briefing.pdf')}/download`);
  expect(pdf.headers()['content-disposition']).toContain('briefing.pdf');
  expect((await pdf.body()).equals(readFileSync(join(FIXTURES, 'report.pdf')))).toBe(true);
  const part = await page.request.get(`/api/archive/107/entries/${idx('Photos/harbor.jpg')}/stream`, { headers: { Range: 'bytes=1000-2999' } });
  expect(part.status()).toBe(206);
  expect((await part.body()).equals(readFileSync(join(FIXTURES, 'photo.jpg')).subarray(1000, 3000))).toBe(true);
  await page.close();
});

test('RAR: fetched once to the server, then files inside play and extract exactly', async () => {
  const page = await context.newPage();
  const { browser } = await openArchive(page, 'collection.rar', 'Saved Messages');
  await expect(browser.getByRole('navigation', { name: 'Archive path' })).toContainText('RAR');
  await browser.getByRole('button', { name: 'Open folder Movies' }).click();
  await browser.getByRole('button', { name: 'Open Movies/Harbor.webm' }).click();
  const video = page.getByRole('dialog', { name: 'Viewing Harbor.webm' }).locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await page.keyboard.press('Escape');

  const list = await (await page.request.get('/api/archive/108')).json();
  expect(list.kind).toBe('rar');
  const mp3 = list.entries.find((e: any) => e.path === 'Audio/Night Watch.mp3');
  const got = await page.request.get(`/api/archive/108/entries/${mp3.index}/download`);
  expect((await got.body()).equals(readFileSync(join(FIXTURES, 'song.mp3')))).toBe(true);
  const ranged = await page.request.get(`/api/archive/108/entries/${mp3.index}/stream`, { headers: { Range: 'bytes=5000-5999' } });
  expect(ranged.status()).toBe(206);
  expect((await ranged.body()).equals(readFileSync(join(FIXTURES, 'song.mp3')).subarray(5000, 6000))).toBe(true);
  await expect.poll(() => dbFilesContain('archive.opened')).toBe(true);
  await page.close();
});

test('archives: hostile paths are neutralised, non-archives and bad indexes are refused', async () => {
  const page = await context.newPage();
  await page.goto('/');
  const odd = await (await page.request.get('/api/archive/109')).json();
  const paths = odd.entries.map((e: any) => e.path).sort();
  expect(paths).toEqual(['C:/win/path.txt', 'abs/rooted.txt', 'etc/evil.txt', 'ok/фото.txt']);
  expect(paths.join()).not.toContain('..');
  const notArchive = await page.request.get('/api/archive/104');
  expect(notArchive.status()).toBe(415);
  expect((await notArchive.json()).error.code).toBe('NOT_AN_ARCHIVE');
  expect((await page.request.get('/api/archive/107/entries/99999/stream')).status()).toBe(404);
  expect((await page.request.get('/api/archive/107/entries/-1/stream')).status()).toBe(400);
  expect((await page.request.get('/api/archive/107/entries/1/stream?folder_id=../../x')).status()).toBe(400);
  // Text and other non-media files inside an archive are never served inline.
  const html = await page.request.get(`/api/archive/109/entries/0/stream`);
  expect(html.headers()['content-type']).toBe('application/octet-stream');
  expect(html.headers()['content-security-policy']).toContain('sandbox');
  await page.close();
});

test('streams cut off mid-way (seeking, closing the player) never crash the server', async () => {
  const page = await context.newPage();
  await page.goto('/');
  // Start 30 streams and abort each after its first bytes arrive, as a video player does when seeking.
  const aborted = await page.evaluate(async () => {
    let n = 0;
    for (let i = 0; i < 30; i += 1) {
      const ac = new AbortController();
      const res = await fetch(`/api/drive/files/106/stream`, { headers: { Range: `bytes=${(i % 3) * 1048576 + 17}-` }, signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      n += 1;
    }
    // Files inside an archive, cut off the same way.
    for (let i = 0; i < 5; i += 1) {
      const ac = new AbortController();
      const res = await fetch('/api/archive/107/entries/1/stream', { headers: { Range: 'bytes=0-' }, signal: ac.signal });
      await res.body!.getReader().read();
      ac.abort();
    }
    // Thumbnails and a small full stream in parallel.
    await Promise.all([fetch('/api/drive/files/101/thumbnail'), fetch('/api/drive/files/105/thumbnail'), fetch('/api/drive/files/103/stream')]);
    return n;
  });
  expect(aborted).toBe(30);
  await page.waitForTimeout(500);
  const alive = await page.request.get('/api/public/status');
  expect(alive.status()).toBe(200);
  const r = await page.request.get('/api/drive/files/106/stream', { headers: { Range: 'bytes=0-99' } });
  expect(r.status()).toBe(206);
  expect((await r.body()).equals(datasetBytes().subarray(0, 100))).toBe(true);
  await page.close();
});

test('unaligned byte ranges come back exact (Telegram only serves 1 MiB-aligned blocks)', async () => {
  const page = await context.newPage();
  await page.goto('/');
  const data = datasetBytes();
  const cases: [number, number][] = [[0, 0], [5, 1048580], [1048575, 1048576], [2097100, 3145800], [data.length - 7, data.length - 1]];
  for (const [a, b] of cases) {
    const r = await page.request.get('/api/drive/files/106/stream', { headers: { Range: `bytes=${a}-${b}` } });
    expect(r.status()).toBe(206);
    expect(r.headers()['content-range']).toBe(`bytes ${a}-${b}/${data.length}`);
    expect((await r.body()).equals(data.subarray(a, b + 1))).toBe(true);
  }
  const suffix = await page.request.get('/api/drive/files/106/stream', { headers: { Range: 'bytes=-100' } });
  expect((await suffix.body()).equals(data.subarray(data.length - 100))).toBe(true);
  const beyond = await page.request.get('/api/drive/files/106/stream', { headers: { Range: `bytes=${data.length}-` } });
  expect(beyond.status()).toBe(416);
  const whole = await page.request.get('/api/drive/files/106/download');
  expect(whole.status()).toBe(200);
  expect((await whole.body()).equals(data)).toBe(true);
  expect(whole.headers()['content-disposition']).toContain('dataset.bin');
  await page.close();
});

test('every joined chat is there without adding it; protected chats stream but never download', async () => {
  const page = await context.newPage();
  await listView(page);

  await page.getByRole('treeitem', { name: 'News Feed' }).click();
  const row = page.locator('tr', { hasText: 'protected' }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await row.getByRole('button', { name: /^Actions for / }).click();
  await expect(page.getByRole('menuitem', { name: 'Download' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const folder = '-1001000000002';
  const dl = await page.request.get(`/api/drive/files/301/download?folder_id=${folder}`);
  expect(dl.status()).toBe(403);
  expect((await dl.json()).error.code).toBe('PROTECTED_CONTENT');
  const stream = await page.request.get(`/api/drive/files/301/stream?folder_id=${folder}`, { headers: { Range: 'bytes=0-99' } });
  expect(stream.status()).toBe(206);

  // Archives from protected chats: browse and play, but no extraction downloads.
  const kit = await page.request.get(`/api/archive/302?folder_id=${folder}`);
  expect(kit.status()).toBe(200);
  const kitList = await kit.json();
  expect(kitList.protected).toBe(true);
  const ep = kitList.entries.find((e: any) => e.path.endsWith('Episode 01.webm')).index;
  expect((await page.request.get(`/api/archive/302/entries/${ep}/download?folder_id=${folder}`)).status()).toBe(403);
  expect((await page.request.get(`/api/archive/302/entries/${ep}/stream?folder_id=${folder}`, { headers: { Range: 'bytes=0-99' } })).status()).toBe(206);
  const readme = kitList.entries.find((e: any) => e.path === 'readme.txt').index;
  expect((await page.request.get(`/api/archive/302/entries/${readme}/stream?folder_id=${folder}`)).status()).toBe(403);

  // Groups you cannot moderate: delete is refused by Telegram's permissions.
  await page.getByRole('treeitem', { name: 'Family' }).click();
  await expect(page.locator('.table')).not.toContainText('protected');
  await page.locator('tbody tr').first().getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog', { name: /^Delete / }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.error-note').first()).toContainText('permission');
  await page.close();
});

test('upload, rename, move, copy, zip and delete operate on Telegram messages', async () => {
  const page = await context.newPage();
  await listView(page, 'Saved Messages');
  await page.getByTestId('upload-input').setInputFiles(join(FIXTURES, 'report.pdf'));
  await expect(page.getByRole('status')).toContainText('Uploaded report.pdf');
  await expect(page.locator('.table')).toContainText('report.pdf');

  await rowMenu(page, 'Night Watch.mp3', 'Rename');
  const rename = page.getByRole('dialog', { name: 'Rename file' });
  await rename.getByLabel('File name').fill('Night Watch (live).mp3');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.table')).toContainText('Night Watch (live).mp3');

  await rowMenu(page, 'field-report.pdf', 'Copy to…');
  const copy = page.getByRole('dialog', { name: 'Copy field-report.pdf' });
  await copy.getByRole('option', { name: 'Movies Archive' }).click();
  await copy.getByRole('button', { name: 'Copy here' }).click();
  await expect(page.getByRole('status')).toContainText('Copied');

  await rowMenu(page, 'Night Watch (live).mp3', 'Move to…');
  const move = page.getByRole('dialog', { name: 'Move Night Watch (live).mp3' });
  await move.getByRole('option', { name: 'Movies Archive' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(page.locator('.table')).not.toContainText('Night Watch');
  await page.getByRole('treeitem', { name: 'Movies Archive' }).click();
  await expect(page.locator('.table')).toContainText('Night Watch (live).mp3');
  await expect(page.locator('.table')).toContainText('field-report.pdf');

  // Zip of two files, streamed and valid.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select field-report.pdf' }).check();
  await page.getByRole('checkbox', { name: 'Select Harbor documentary.webm' }).check();
  const bar = page.getByRole('region', { name: 'Selection actions' });
  const [zip] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download zip' }).click()]);
  const path = join(TG_DATA_DIR, 'e2e.zip');
  await zip.saveAs(path);
  const listing = execFileSync('unzip', ['-l', path]).toString();
  expect(listing).toContain('field-report.pdf');
  expect(listing).toContain('Harbor documentary.webm');
  execFileSync('unzip', ['-tq', path]);
  await bar.getByRole('button', { name: 'Clear' }).click();

  await rowMenu(page, 'field-report.pdf', 'Delete');
  await page.getByRole('dialog', { name: 'Delete field-report.pdf?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.table')).not.toContainText('field-report.pdf');
  await page.close();
});

test('channels: create, rename and delete your own; others cannot be changed', async () => {
  const page = await context.newPage();
  await listView(page);
  await page.getByRole('button', { name: '+ New channel' }).click();
  const create = page.getByRole('dialog', { name: 'New private channel' });
  await create.getByLabel('Channel name').fill('Night Shift');
  await create.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('treeitem', { name: 'Night Shift' })).toBeVisible();

  await page.getByRole('button', { name: 'Folder actions for Night Shift' }).click();
  await page.getByRole('menuitem', { name: 'Rename channel' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename folder' });
  await rename.getByLabel('Folder name').fill('Late Shift');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('treeitem', { name: 'Late Shift' })).toBeVisible();

  // Chats you do not own offer no rename or delete at all.
  await expect(page.getByRole('button', { name: 'Folder actions for News Feed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Folder actions for Mom' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Folder actions for Late Shift' }).click();
  await page.getByRole('menuitem', { name: 'Delete channel' }).click();
  await page.getByRole('dialog', { name: 'Delete Late Shift?' }).getByRole('button', { name: 'Delete channel' }).click();
  await expect(page.getByRole('treeitem', { name: 'Late Shift' })).toHaveCount(0);
  await page.close();
});

test('security page lists every Telegram session and can terminate one', async () => {
  const page = await context.newPage();
  await page.goto('/#security');
  const panel = page.locator('.panel', { hasText: 'Telegram sessions' });
  await expect(panel).toContainText('198.51.100.40');
  await expect(panel).toContainText('192.0.2.200');
  await expect(panel.locator('tr', { hasText: 'Kurovault server' }).first()).toContainText('this server');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, '5-sessions');
  await panel.getByRole('button', { name: 'Terminate iPhone 16' }).click();
  await expect(panel).toContainText('Signed out iPhone 16');
  await expect(panel.locator('.table')).not.toContainText('198.51.100.40');
  // The audit trail is admin-only; check the entries were written.
  await expect.poll(() => dbFilesContain('telegram.session_terminated')).toBe(true);
  expect(dbFilesContain('telegram.connected')).toBe(true);
  await page.close();
});

test('after Telegram is disconnected, reconnecting needs only the phone number (API ID/hash remembered)', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.locator('.vnav-source').click();
  await page.getByRole('button', { name: 'Disconnect Telegram' }).click();
  const form = page.getByRole('form', { name: 'Connect Telegram' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('Using your saved Telegram app (API ID ••123)');
  await expect(form.getByLabel('API ID')).toHaveCount(0);
  await expect(form.getByLabel('API hash')).toHaveCount(0);
  expect((await page.request.get('/api/drive/files')).status()).toBe(503);
  const state = await (await page.request.get('/api/telegram/state')).text();
  expect(state).not.toContain(API_HASH);
  expect(state).not.toContain(API_ID);

  await form.getByLabel('Phone number').fill('+15550001111');
  await form.getByRole('button', { name: 'Send login code' }).click();
  await page.getByRole('textbox', { name: 'Login code' }).fill(CODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('textbox', { name: 'Two-step password' }).fill(TG_PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('.vnav-source')).toContainText('@ada_ops');
  await page.close();
});

test('disconnect, then sign back in with a QR code — still no API ID needed', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.locator('.vnav-source').click();
  await page.getByRole('button', { name: 'Disconnect Telegram' }).click();
  const form = page.getByRole('form', { name: 'Connect Telegram' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'QR code' }).click();
  const qrResponse = page.waitForResponse(r => r.url().endsWith('/api/telegram/login/qr') && r.request().method() === 'POST' && r.ok());
  await form.getByRole('button', { name: 'Show QR code' }).click();
  const qr = await (await qrResponse).json();
  expect(qr.qr).toMatch(/^data:image\/svg\+xml;base64,/);
  const pwForm = page.getByRole('form', { name: 'Telegram two-step password' });
  await expect(pwForm).toBeVisible({ timeout: 10_000 });
  await pwForm.getByLabel('Two-step password').fill(TG_PASSWORD);
  await pwForm.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('.vnav-source')).toContainText('@ada_ops', { timeout: 10_000 });
  await page.close();
});

test('a different API ID can still be entered when wanted', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.locator('.vnav-source').click();
  await page.getByRole('button', { name: 'Disconnect Telegram' }).click();
  const form = page.getByRole('form', { name: 'Connect Telegram' });
  await form.getByRole('button', { name: 'Use a different API ID' }).click();
  await expect(form.getByLabel('API ID')).toBeVisible();
  await expect(form.getByLabel('API hash')).toBeVisible();
  await page.close();
});



// A tiny public media host for the direct-link tests: serves a real clip with Range support,
// plus a redirect, an octet-stream variant, and a non-media page.
function mediaFixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const path = join(FIXTURES, 'clip.webm');
  const size = statSync(path).size;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>not a video</h1>'); return; }
    if (url.pathname === '/go') { res.writeHead(302, { location: '/clip.webm' }); res.end(); return; }
    const octet = url.pathname === '/octet.bin';
    if (url.pathname !== '/clip.webm' && !octet) { res.writeHead(404); res.end(); return; }
    const type = octet ? 'application/octet-stream' : 'video/webm';
    const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
      createReadStream(path).pipe(res);
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as import('node:net').AddressInfo).port;
    resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
  }));
}
async function csrf() { return (await (await context.request.get('/api/auth/me')).json()).csrf as string; }

test('a public direct link plays in the viewer, with byte-range seeking', async () => {
  const fx = await mediaFixture();
  try {
    const page = await context.newPage();
    const statuses: number[] = [];
    page.on('response', r => { if (/\/api\/links\/\d+\/stream/.test(r.url())) statuses.push(r.status()); });
    await page.goto('/#links');
    await page.getByLabel('Video or audio link').fill(`${fx.base}/clip.webm`);
    await page.getByLabel('Name (optional)').fill('Public clip');
    await page.getByRole('button', { name: 'Get video' }).click();
    await page.getByRole('button', { name: 'Play Public clip' }).click();
    const viewer = page.getByRole('dialog', { name: 'Viewing Public clip' });
    const video = viewer.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
    await video.evaluate((v: HTMLVideoElement) => new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 3; }));
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(2.5);
    expect(statuses).toContain(206);
    await page.close();
  } finally { await fx.close(); }
});

test('links: redirects are followed and octet-stream falls back to the extension; non-media and bad schemes are refused', async () => {
  const fx = await mediaFixture();
  const token = await csrf();
  const post = (url: string) => context.request.post('/api/links', { data: { url }, headers: { 'X-CSRF-Token': token } });
  try {
    expect((await post(`${fx.base}/go`)).status()).toBe(200);
    expect((await post(`${fx.base}/octet.bin?name=x.webm`)).ok()).toBeFalsy(); // octet with no media extension → refused
    expect((await (await post(`${fx.base}/page`)).json()).error.code).toBe('NOT_MEDIA');
    expect((await post('file:///etc/passwd')).status()).toBe(400);
    expect((await post('ftp://example.com/x.mp4')).status()).toBe(400);
  } finally { await fx.close(); }
});

test('Streamtape: connect your own account, list your files, and play one with range seeking', async () => {
  const page = await context.newPage();
  await page.goto('/#links');
  // Wrong key is rejected.
  await page.getByLabel('API login').fill('test-st-login');
  await page.getByLabel('API key').fill('wrong-key');
  await page.getByRole('button', { name: 'Connect Streamtape' }).click();
  await expect(page.getByText(/rejected that API login/i)).toBeVisible();
  // Right credentials connect and list files.
  await page.getByLabel('API key').fill('test-st-key');
  await page.getByRole('button', { name: 'Connect Streamtape' }).click();
  const lib = page.getByRole('region', { name: 'Streamtape library' });
  await expect(lib).toContainText('me@example.com');
  await expect(lib.getByRole('button', { name: 'Play Lecture 01.mp4' })).toBeVisible();
  // A still-processing file is present but not playable.
  await expect(lib.getByRole('button', { name: 'Play Still processing.mp4' })).toBeDisabled();

  const statuses: number[] = [];
  page.on('response', r => { if (/\/api\/streamtape\/files\/.+\/stream/.test(r.url())) statuses.push(r.status()); });
  await lib.getByRole('button', { name: 'Play Lecture 01.mp4' }).click();
  const viewer = page.getByRole('dialog', { name: 'Viewing Lecture 01.mp4' });
  const video = viewer.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await video.evaluate((v: HTMLVideoElement) => new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 3; }));
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(2.5);
  expect(statuses).toContain(206);
  await viewer.getByRole('button', { name: 'Close viewer' }).click();
  await page.close();
});

test('Streamtape: only files in the account can be played; a made-up id is refused', async () => {
  const token = await csrf();
  const res = await context.request.get('/api/streamtape/files/not-a-real-linkid/stream', { headers: { 'X-CSRF-Token': token } });
  expect(res.status()).toBe(404);
});

test('Streamtape: disconnect clears the credentials and the library', async () => {
  const token = await csrf();
  expect((await context.request.post('/api/streamtape/disconnect', { data: {}, headers: { 'X-CSRF-Token': token } })).ok()).toBeTruthy();
  const after = await (await context.request.get('/api/streamtape/account')).json();
  expect(after.connected).toBe(false);
  // Files can no longer be listed without reconnecting.
  expect((await context.request.get('/api/streamtape/files')).status()).toBe(409);
});
