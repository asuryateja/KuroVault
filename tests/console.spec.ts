// End-to-end journeys through the real server, real database and real browser UI, signed in as the admin.
// Only the Telegram Drive desktop API is simulated (tests/fake-drive.js).
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../playwright.config';

test.describe.configure({ mode: 'serial' });

const OPERATOR = 'admin';
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const PASSWORD = 'Granite-Harbor-41-Lantern';
const OPERATOR_IP = '203.0.113.7';
const SHOT_DIR = process.env.SHOT_DIR;

let context: BrowserContext;
function dbContains(text: string) {
  return ['', '-wal'].some(suffix => {
    try { return readFileSync(join(DATA_DIR, 'console.db' + suffix)).includes(Buffer.from(text)); } catch { return false; }
  });
}
async function rowMenu(page: Page, name: string, item: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).first().click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}
async function visitor(playwright: any, ip: string): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: 'http://127.0.0.1:18640', extraHTTPHeaders: { 'X-Forwarded-For': ip, 'User-Agent': `Mozilla/5.0 (X11; Linux x86_64) e2e-visitor/${ip}` } });
}
async function signInApi(ctx: APIRequestContext, username = OPERATOR, password = PASSWORD) {
  return ctx.post('/api/auth/login', { data: { username, password } });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': OPERATOR_IP } });
});
test.afterAll(async () => {
  if (SHOT_DIR && context) await context.storageState({ path: join(SHOT_DIR, 'state.json') });
  await context?.close();
});

test('every response carries strict security headers', async ({ request }) => {
  const page = await request.get('/');
  expect(page.status()).toBe(200);
  const h = page.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['server']).toBeUndefined();
  const api = await request.get('/api/public/status');
  expect(api.headers()['cache-control']).toBe('no-store');
  const missing = await request.get('/api/does-not-exist');
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.code).toBe('NOT_FOUND');
  const traversal = await request.get('/assets/../server/app.js');
  expect(await traversal.text()).not.toContain('buildApp');
});

test('before sign-in the page runs only the application checks and shows only the visitor’s own connection', async () => {
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Create account' })).toBeVisible();
  await expect(page.getByText('Setup token')).toHaveCount(0);
  const sweep = page.locator('.gate-sweep .sweep-list li');
  await expect(sweep).toHaveCount(4);
  await expect(page.locator('.gate-sweep .sweep-list li.is-queued, .gate-sweep .sweep-list li.is-running')).toHaveCount(0, { timeout: 20_000 });
  for (const label of ['Server runtime', 'Database integrity', 'Telegram link', 'Host resources']) await expect(page.locator('.gate-sweep')).toContainText(label);
  for (const label of ['Security headers', 'Key material', 'Intrusion defenses', 'Audit trail chain']) await expect(page.locator('.gate-sweep')).not.toContainText(label);
  await expect(page.getByText('Secure line')).toHaveCount(0);
  const conn = page.locator('section', { hasText: 'Your connection' }).last();
  await expect(conn).toContainText(OPERATOR_IP);
  await expect(conn).toContainText('Location');
  await expect(page.getByText('This visit is recorded')).toBeVisible();
  // Security internals are not available to visitors at all.
  expect((await page.request.get('/api/public/checks/threats')).status()).toBe(404);
  expect((await (await page.request.get('/api/public/checks')).json()).checks).toHaveLength(4);
  await shot(page, '01-gate');
  await page.close();
});

test('visitors see where they connect from (offline lookup, no third parties)', async ({ playwright }) => {
  const v = await visitor(playwright, '8.8.8.8');
  const conn = await (await v.get('/api/public/connection')).json();
  expect(conn.location.label).toBe('Mountain View, California, United States');
  expect(JSON.stringify(conn)).not.toContain('db-ip');
  const v6 = await visitor(playwright, '2001:4860:4860::8888');
  expect((await (await v6.get('/api/public/connection')).json()).location.country).toBeTruthy();
  await v.dispose();
  await v6.dispose();
});

test('registration refuses reserved names, mismatched or weak passwords, and taken usernames', async ({ playwright }) => {
  const ctx = await visitor(playwright, '198.51.100.66');
  const post = (data: Record<string, string>) => ctx.post('/api/auth/register', { data: { name: 'Mallory', username: 'mallory', password: 'Quiet-River-88', confirm: 'Quiet-River-88', ...data } });
  expect((await (await post({ username: 'admin' })).json()).error.code).toBe('USERNAME_TAKEN');
  expect((await (await post({ username: 'Admin' })).json()).error.code).toBe('USERNAME_TAKEN');
  expect((await (await post({ confirm: 'Quiet-River-89' })).json()).error.code).toBe('PASSWORD_MISMATCH');
  expect((await (await post({ password: 'password', confirm: 'password' })).json()).error.code).toBe('WEAK_PASSWORD');
  expect((await (await post({ name: '' })).json()).error.code).toBe('INVALID_REQUEST');
  expect((await post({})).status()).toBe(200);
  expect((await (await post({})).json()).error.code).toBe('USERNAME_TAKEN');
  await ctx.dispose();
});

test('the admin signs in with just a username and password and lands on the intelligence console', async () => {
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Username').fill(OPERATOR);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.locator('.kpi', { hasText: 'Audit chain' })).toContainText('Intact');
  await expect(page.getByText('Authenticator')).toHaveCount(0);
  await expect(page.locator('.topbar')).toContainText('Administrator');
  for (const label of ['Sign-in attempts', 'Visitors & IPs', 'Sessions & users', 'Audit trail', 'Vault']) await expect(page.locator('.topbar').getByRole('button', { name: label })).toBeVisible();
  await page.close();
});

test('members only see their own Vault and account; admin pages and data are refused', async ({ playwright }) => {
  const m = await visitor(playwright, '198.51.100.70');
  expect((await signInApi(m, 'mallory', 'Quiet-River-88')).status()).toBe(200);
  for (const path of ['/api/console/overview', '/api/console/attempts', '/api/console/visitors', '/api/console/sessions', '/api/console/audit', '/api/console/users', '/api/console/blocks']) {
    const r = await m.get(path);
    expect(r.status(), path).toBe(403);
    expect((await r.json()).error.code).toBe('ADMIN_ONLY');
  }
  const me = await (await m.get('/api/auth/me')).json();
  expect(me.user.role).toBe('user');
  // A member never sees the admin's desktop-app library: their Vault is their own Telegram.
  const files = await m.get('/api/drive/files');
  expect(files.status()).toBe(503);
  expect((await files.json()).error.code).toBe('TELEGRAM_NOT_CONNECTED');
  await m.dispose();

  const browser = context.browser()!;
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:18640', extraHTTPHeaders: { 'X-Forwarded-For': '198.51.100.71' } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Username').fill('mallory');
  await page.getByLabel('Password', { exact: true }).fill('Quiet-River-88');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vault', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar').getByRole('button', { name: 'Audit trail' })).toHaveCount(0);
  await expect(page.locator('.topbar').getByRole('button', { name: 'Sign-in attempts' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Connect Telegram' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use the Telegram Drive desktop app instead' })).toHaveCount(0);
  await page.goto('/#audit');
  await expect(page.getByRole('heading', { name: 'Vault', level: 1 })).toBeVisible();
  await ctx.close();
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const cookies = await context.cookies();
  const session = cookies.find(c => c.name === 'tdc_session');
  expect(session).toBeTruthy();
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe('Strict');
  expect(session!.value.length).toBeGreaterThanOrEqual(43);
});

test('failed sign-ins are recorded with source IP, username tried and result', async ({ playwright }) => {
  const attacker = await visitor(playwright, '198.51.100.23');
  for (const username of ['root', 'operator', 'administrator', 'oracle', 'test', 'support']) {
    const r = await attacker.post('/api/auth/login', { data: { username, password: 'hunter2hunter2' } });
    expect(r.status()).toBe(401);
    expect((await r.json()).error.message).toBe('Username or password is incorrect.');
  }
  const guesser = await visitor(playwright, '192.0.2.44');
  for (let i = 0; i < 2; i += 1) expect((await guesser.post('/api/auth/login', { data: { username: OPERATOR, password: 'Wrong-Password-000' } })).status()).toBe(401);
  await attacker.get('/api/public/status');
  await attacker.dispose();
  await guesser.dispose();

  const page = await context.newPage();
  await page.goto('/#access');
  await expect(page.getByRole('heading', { name: 'Sign-in attempts', level: 1 })).toBeVisible();
  const table = page.locator('.table');
  await expect(table).toContainText('198.51.100.23');
  await expect(table).toContainText('administrator');
  await expect(table).toContainText('Unknown user');
  await expect(table).toContainText('192.0.2.44');
  await expect(table).toContainText('Wrong password');
  await page.getByRole('button', { name: 'Failed' }).click();
  await expect(table.locator('tbody tr').first()).not.toContainText('Success');
  await shot(page, '04-access');

  await page.getByRole('button', { name: 'Visitors & IPs' }).click();
  const row = page.locator('tr', { hasText: '198.51.100.23' });
  await expect(row).toContainText('6');
  await expect(row).toContainText('elevated');
  await expect(row).toContainText('root');
  await row.getByRole('button', { name: '198.51.100.23' }).click();
  await expect(page.locator('.panel', { hasText: 'Request trail' })).toContainText('/api/auth/login');
  await shot(page, '05-visitors');
  await page.close();
});

test('an IP is automatically blocked after repeated failures', async ({ playwright }) => {
  const bot = await visitor(playwright, '192.0.2.99');
  for (let i = 0; i < 12; i += 1) expect((await bot.post('/api/auth/login', { data: { username: `user${i}`, password: 'x'.repeat(12) } })).status()).toBe(401);
  // The status probe stays reachable (so the banned screen can load) and reports the ban…
  const after = await bot.get('/api/public/status');
  expect(after.status()).toBe(200);
  expect((await after.json()).banned).toBe(true);
  // …while every other API route is refused.
  expect((await bot.get('/api/auth/me')).status()).toBe(403);
  expect((await (await bot.get('/api/auth/me')).json()).error.code).toBe('BANNED');
  await bot.dispose();
  const page = await context.newPage();
  await page.goto('/#visitors');
  await expect(page.locator('tr', { hasText: '192.0.2.99' })).toContainText('blocked');
  await page.close();
});

test('sign-in endpoints are rate limited per IP', async ({ playwright }) => {
  const flood = await visitor(playwright, '192.0.2.150');
  const statuses: number[] = [];
  for (let i = 0; i < 32; i += 1) statuses.push((await flood.post('/api/auth/register', { data: { name: 'Flood', username: `flood${i}`, password: 'Quiet-River-88', confirm: 'nope' } })).status());
  expect(statuses.slice(0, 30).every(s => s === 400)).toBe(true);
  expect(statuses.slice(30)).toEqual([429, 429]);
  await flood.dispose();
});

test('forged and cross-site requests are refused and audited', async () => {
  const noToken = await context.request.post('/api/console/sessions/revoke-others', { data: {} });
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).error.code).toBe('CSRF');
  const badOrigin = await context.request.post('/api/console/sessions/revoke-others', { data: {}, headers: { Origin: 'https://evil.example' } });
  expect((await badOrigin.json()).error.code).toBe('BAD_ORIGIN');
  const crossSite = await context.request.post('/api/console/sessions/revoke-others', { data: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  expect((await crossSite.json()).error.code).toBe('CROSS_SITE');
  const page = await context.newPage();
  await page.goto('/#audit');
  await expect(page.locator('.table')).toContainText('Forged request rejected');
  await page.close();
});

test('signing out ends only that browser; other browsers stay signed in', async ({ playwright }) => {
  const one = await visitor(playwright, '203.0.113.50');
  const two = await visitor(playwright, '203.0.113.51');
  expect((await signInApi(one, 'mallory', 'Quiet-River-88')).status()).toBe(200);
  expect((await signInApi(two, 'mallory', 'Quiet-River-88')).status()).toBe(200);
  const csrf = (await (await one.get('/api/auth/me')).json()).csrf;
  expect((await one.post('/api/auth/logout', { data: {}, headers: { 'X-CSRF-Token': csrf } })).status()).toBe(200);
  expect((await one.get('/api/auth/me')).status()).toBe(401);
  expect((await two.get('/api/auth/me')).status()).toBe(200);
  await one.dispose();
  await two.dispose();
});

test('operator sees another live session with its IP and can revoke it remotely', async ({ playwright }) => {
  const other = await visitor(playwright, '203.0.113.200');
  expect((await signInApi(other)).status()).toBe(200);
  expect((await other.get('/api/auth/me')).status()).toBe(200);
  const page = await context.newPage();
  await page.goto('/#sessions');
  const row = page.locator('.panel', { hasText: 'Active sessions' }).locator('tr', { hasText: '203.0.113.200' });
  await expect(row).toBeVisible();
  await expect(page.locator('tr', { hasText: 'this browser' })).toContainText(OPERATOR_IP);
  await shot(page, '06-sessions');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);
  expect((await other.get('/api/auth/me')).status()).toBe(401);
  await other.dispose();
  await page.close();
});

test('Drive: the admin links the desktop app; browse, download, upload and delete work', async ({ request }) => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await expect(page.locator('.panel', { hasText: 'Telegram account' })).toContainText('API hash');
  await page.getByRole('button', { name: 'Use the Telegram Drive desktop app instead' }).click();
  await expect(page.locator('.panel', { hasText: 'Vault source' })).toContainText('key not configured');
  await page.getByLabel('API key (Settings → Advanced in the desktop app)').fill('test-drive-key');
  await page.getByRole('button', { name: 'Save link' }).click();
  await expect(page.getByText('Saved. The key is sealed')).toBeVisible();

  const status = await context.request.get('/api/drive/status');
  const statusText = await status.text();
  expect(statusText).not.toContain('test-drive-key');
  expect((await status.json()).authorized).toBe(true);
  expect(dbContains('test-drive-key')).toBe(false);

  await page.reload();
  await page.getByRole('treeitem', { name: 'Documents' }).click();
  await expect(page.locator('.table')).toContainText('Quarterly report.pdf');
  await expect(page.locator('.table')).toContainText('encrypted');
  const download = await context.request.get('/api/drive/files/41/download?folder_id=1001');
  expect(download.status()).toBe(200);
  expect(Buffer.compare(await download.body(), readFileSync(join(FIXTURES, 'report.pdf')))).toBe(0);
  expect(download.headers()['content-disposition']).toContain('Quarterly report.pdf');

  await page.getByTestId('upload-input').setInputFiles({ name: 'field-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the console') });
  await expect(page.locator('.table')).toContainText('field-notes.txt');
  const uploads = await (await request.get('http://127.0.0.1:18550/api/v1/__uploads')).json();
  expect(uploads.map((u: any) => u.name)).toContain('field-notes.txt');

  await page.getByRole('button', { name: 'Actions for Contracts.zip' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete Contracts.zip?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.table')).not.toContainText('Contracts.zip');
  await shot(page, '07-drive');
  await page.goto('/#audit');
  await expect(page.locator('.table')).toContainText('File deleted');
  await expect(page.locator('.table')).toContainText('File uploaded');
  await expect(page.locator('.table')).toContainText('Drive link reconfigured');
  await page.close();
});

test('archives: a ZIP in the desktop vault opens in place and its video plays', async () => {
  const page = await context.newPage();
  const viewer = await openFromList(page, 'All', 'Season pack.zip');
  const browser = viewer.getByTestId('archive-browser');
  await expect(browser).toContainText('6 files');
  await browser.getByRole('button', { name: 'Open folder Season 1' }).click();
  await browser.getByRole('button', { name: 'Open Season 1/Episode 01.webm' }).click();
  const video = page.getByRole('dialog', { name: 'Viewing Episode 01.webm' }).locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
  const list = await (await page.request.get('/api/archive/52?folder_id=1002')).json();
  const jpg = list.entries.find((e: { path: string }) => e.path === 'Photos/harbor.jpg').index;
  const body = await (await page.request.get(`/api/archive/52/entries/${jpg}/download?folder_id=1002`)).body();
  expect(body.equals(readFileSync(join(FIXTURES, 'photo.jpg')))).toBe(true);
  await page.close();
});

async function openFromList(page: Page, filter: string, name: string) {
  await page.goto('/#drive');
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('group', { name: 'File type' }).getByRole('button', { name: filter, exact: true }).click();
  const row = page.locator('tr', { hasText: name }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  const viewer = page.getByRole('dialog', { name: `Viewing ${name}` });
  await expect(viewer).toBeVisible();
  return viewer;
}
function trackCsp(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  return errors;
}

test('video: streams with byte ranges, plays, seeks, and the viewer animates open and closed', async () => {
  const page = await context.newPage();
  const csp = trackCsp(page);
  const ranges: number[] = [];
  page.on('response', r => { if (r.url().includes('/files/44/stream')) ranges.push(r.status()); });
  const viewer = await openFromList(page, 'Videos', 'Night patrol.webm');
  await expect(viewer.locator('.viewer-panel')).toHaveCSS('opacity', '1');
  const video = viewer.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.6);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(640);
  await video.evaluate((v: HTMLVideoElement) => new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 6; }));
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(5.9);
  await expect(viewer.getByTestId('video-time')).toContainText('0:0');
  expect(ranges).toContain(206);
  await shot(page, '11-video');
  // Custom controls drive the element.
  await viewer.getByTestId('video-player').hover();
  await viewer.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await viewer.getByRole('combobox', { name: 'Playback speed' }).selectOption('1.5');
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer.is-closing')).toHaveCount(1);
  await expect(page.locator('.viewer')).toHaveCount(0);
  expect(csp).toEqual([]);
  await page.close();
});

test('video: MP4 (H.264) plays when the browser has the codec, otherwise explains why', async () => {
  const page = await context.newPage();
  const viewer = await openFromList(page, 'Videos', 'Briefing.mp4');
  const video = viewer.locator('video');
  const supported = await video.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
  if (supported) {
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  } else {
    await expect(viewer.getByRole('alert')).toContainText('cannot play this video format');
  }
  test.info().annotations.push({ type: 'h264', description: supported ? 'played' : 'codec not available in this browser build' });
  await page.close();
});

test('audio: plays with title, artist and a live visualizer', async () => {
  const page = await context.newPage();
  const viewer = await openFromList(page, 'Audio', 'Night Watch.mp3');
  await expect(viewer.getByTestId('audio-title')).toHaveText('Night Watch');
  await expect(viewer.getByTestId('audio-player')).toContainText('Kurovault Ensemble');
  const audio = viewer.locator('audio');
  await audio.evaluate((a: HTMLAudioElement) => a.play().catch(() => undefined));
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.6);
  await expect.poll(() => viewer.getByTestId('audio-viz').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit;
  }), { timeout: 10_000 }).toBeGreaterThan(200);
  await shot(page, '12-audio');
  await viewer.getByRole('button', { name: 'Close viewer' }).click();
  await expect(page.locator('.viewer')).toHaveCount(0);
  await page.close();
});

test('PDF: renders pages to canvas, tracks the page and zooms', async () => {
  const page = await context.newPage();
  const csp = trackCsp(page);
  const viewer = await openFromList(page, 'PDFs', 'Quarterly report.pdf');
  const first = viewer.locator('.pdf-page canvas.is-rendered').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByTestId('pdf-page')).toHaveText(/^1 \/ \d+$/);
  const pages = Number((await viewer.getByTestId('pdf-page').innerText()).split('/')[1]);
  expect(pages).toBeGreaterThanOrEqual(2);
  await expect(viewer.locator('.pdf-page')).toHaveCount(pages);
  const ink = await first.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 0) dark++;
    return dark;
  });
  expect(ink).toBeGreaterThan(500);
  const before = await viewer.locator('.pdf-page').first().evaluate(e => e.getBoundingClientRect().width);
  const zoomBefore = await viewer.getByTestId('pdf-zoom').innerText();
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(viewer.getByTestId('pdf-zoom')).not.toHaveText(zoomBefore);
  await expect.poll(() => viewer.locator('.pdf-page').first().evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThan(before);
  // The page never goes blank while re-rendering at the new zoom, and ends up sharp at the new size.
  await expect(first).toHaveClass(/is-rendered/);
  await expect.poll(() => first.evaluate((c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width), { timeout: 10_000 }).toBeGreaterThan(0.95);
  await page.waitForTimeout(700);
  await shot(page, '13-pdf');
  expect(csp).toEqual([]);
  await page.close();
});

test('images open full size, and arrow keys move between files', async () => {
  const page = await context.newPage();
  const viewer = await openFromList(page, 'Images', 'Harbor at dawn.jpg');
  const img = viewer.getByTestId('image-viewer').locator('img');
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1200);
  await page.close();

  const p2 = await context.newPage();
  const v2 = await openFromList(p2, 'All', 'Harbor at dawn.jpg');
  await expect(v2.locator('.viewer-title strong')).toHaveText('Harbor at dawn.jpg');
  await p2.keyboard.press('ArrowRight');
  await expect(p2.locator('.viewer-title strong')).not.toHaveText('Harbor at dawn.jpg');
  await expect(p2.locator('.viewer-stage.from-next')).toHaveCount(1);
  await p2.close();
});

test('grid view shows thumbnails; encrypted files explain instead of streaming', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.getByRole('treeitem', { name: 'Media' }).click();
  const grid = page.getByTestId('file-grid');
  const thumb = grid.locator('li', { hasText: 'Night patrol.webm' }).locator('img');
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await shot(page, '14-grid');
  await grid.getByRole('button', { name: 'Open Vault footage.mp4' }).click();
  await expect(page.getByTestId('encrypted-note')).toContainText('End-to-end encrypted');
  const r = await context.request.get('/api/drive/files/49/stream?folder_id=1002');
  expect(r.status()).toBe(409);
  await page.close();
});

test('streaming is authenticated, range-correct and never renders active content inline', async ({ request }) => {
  const anon = await request.get('/api/drive/files/44/stream?folder_id=1002');
  expect(anon.status()).toBe(401);
  const part = await context.request.get('/api/drive/files/44/stream?folder_id=1002', { headers: { Range: 'bytes=0-99' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
  expect(part.headers()['content-type']).toBe('video/webm');
  expect(part.headers()['accept-ranges']).toBe('bytes');
  expect((await part.body()).length).toBe(100);
  expect(part.headers()['content-security-policy']).toContain('sandbox');
  for (const id of [47, 48]) {
    const r = await context.request.get(`/api/drive/files/${id}/stream?folder_id=1001`);
    expect(r.headers()['content-type']).toBe('application/octet-stream');
    expect(r.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers()['content-security-policy']).toContain('sandbox');
  }
});

test('folders: create, rename, browse the nested tree and delete with confirmation', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  for (const name of ['Field ops', 'Inbox']) {
    await page.getByRole('button', { name: '+ New folder' }).click();
    const dialog = page.getByRole('dialog', { name: 'New folder' });
    await dialog.getByLabel('Folder name').fill(name);
    await dialog.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.getByRole('treeitem', { name })).toHaveAttribute('aria-selected', 'true');
  }
  await page.getByRole('button', { name: 'Folder actions for Field ops' }).click();
  await page.getByRole('menuitem', { name: 'Rename folder' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename folder' });
  await rename.getByLabel('Folder name').fill('Field operations');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('treeitem', { name: 'Field operations' })).toBeVisible();

  await page.getByRole('button', { name: 'Expand Documents' }).click();
  await page.getByRole('treeitem', { name: 'Reports 2026' }).click();
  await expect(page.getByLabel('Location')).toHaveText(/Documents\s*\/\s*Reports 2026/);
  await expect(page.locator('.table')).toContainText('Budget.xlsx');
  await shot(page, '30-tree');

  await page.getByRole('button', { name: 'Folder actions for Field operations' }).click();
  await page.getByRole('menuitem', { name: 'Delete folder' }).click();
  await page.getByRole('dialog', { name: 'Delete Field operations?' }).getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.getByRole('treeitem', { name: 'Field operations' })).toHaveCount(0);
  await page.goto('/#audit');
  await expect(page.locator('.table')).toContainText('Folder deleted');
  await page.close();
});

test('files: rename, move and copy through the folder picker; favorites, pins and recents', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('treeitem', { name: 'Documents' }).click();
  await rowMenu(page, 'invite.html', 'Rename');
  const rename = page.getByRole('dialog', { name: 'Rename file' });
  await rename.getByLabel('File name').fill('invitation.html');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.table')).toContainText('invitation.html');

  await rowMenu(page, 'invitation.html', 'Move to…');
  const move = page.getByRole('dialog', { name: 'Move invitation.html' });
  await move.getByRole('option', { name: 'Archive' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(page.locator('.table')).not.toContainText('invitation.html');

  await rowMenu(page, 'badge.svg', 'Copy to…');
  const copy = page.getByRole('dialog', { name: 'Copy badge.svg' });
  await copy.getByRole('option', { name: 'Archive' }).click();
  await copy.getByRole('button', { name: 'Copy here' }).click();
  await expect(page.locator('.table')).toContainText('badge.svg');
  await page.getByRole('treeitem', { name: 'Archive' }).click();
  await expect(page.locator('.table')).toContainText('invitation.html');
  await expect(page.locator('.table')).toContainText('badge.svg');

  await page.getByRole('treeitem', { name: 'Documents' }).click();
  await rowMenu(page, 'Quarterly report.pdf', 'Add to Favorites');
  await expect(page.getByRole('status')).toContainText('Added to Favorites');
  await rowMenu(page, 'Quarterly report.pdf', 'Pin');
  await page.locator('.vnav').getByRole('button', { name: /^Favorites/ }).click();
  await expect(page.locator('.table')).toContainText('Quarterly report.pdf');
  await expect(page.locator('.vnav').getByRole('button', { name: /^Favorites/ })).toContainText('1');
  await page.locator('.vnav').getByRole('button', { name: /^Pinned/ }).click();
  await expect(page.locator('.table')).toContainText('Quarterly report.pdf');
  await page.locator('.vnav').getByRole('button', { name: 'Recents' }).click();
  await expect(page.locator('.table')).toContainText('Night patrol.webm');
  await expect(page.locator('.table')).toContainText('Night Watch.mp3');
  await shot(page, '31-recents');
  await page.close();
});

test('bulk: select several files, download a zip, move them, drag one onto a folder, delete', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('treeitem', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select invitation.html' }).check();
  await page.getByRole('checkbox', { name: 'Select badge.svg' }).check();
  const bar = page.getByRole('region', { name: 'Selection actions' });
  await expect(bar).toContainText('2 selected');
  await shot(page, '32-bulk');
  const [zip] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download zip' }).click()]);
  expect(zip.suggestedFilename()).toMatch(/\.zip$/);

  await bar.getByRole('button', { name: 'Move' }).click();
  const move = page.getByRole('dialog', { name: 'Move 2 files' });
  await move.getByRole('option', { name: 'Saved Messages' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(page.locator('.vault-body')).toContainText('Nothing here yet');

  await page.locator('.vnav').getByRole('button', { name: 'Saved Messages' }).click();
  await expect(page.locator('.table')).toContainText('invitation.html');
  // Saved Messages lists only its own files, not every folder.
  await expect(page.locator('.table tbody tr')).toHaveCount(2);
  await expect(page.locator('.table')).not.toContainText('Night patrol.webm');
  // Drag by hand: once the drag starts, the shelf pins under the top bar, so the folder is in reach without scrolling.
  const dragged = page.locator('.file-row', { hasText: 'badge.svg' });
  await dragged.hover();
  await page.mouse.down();
  const from = (await dragged.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y - 30, { steps: 4 });
  await expect(page.locator('body')).toHaveClass(/dragging-files/);
  const folder = page.locator('.tree-row', { hasText: 'Archive' });
  await expect(folder).toBeInViewport();
  await folder.hover();
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/dragging-files/);
  await expect(page.getByRole('status')).toContainText('Moved 1 file');
  await expect(page.locator('.table')).not.toContainText('badge.svg');

  await page.getByRole('checkbox', { name: 'Select invitation.html' }).check();
  await page.getByRole('region', { name: 'Selection actions' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete invitation.html?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.vault-body')).not.toContainText('invitation.html');
  await page.close();
});

test('storage insights: large files, old files, duplicates and empty folders', async () => {
  const page = await context.newPage();
  await page.goto('/#drive');
  await page.getByRole('button', { name: 'List view' }).click();
  await page.locator('.vnav').getByRole('button', { name: 'Large files' }).click();
  await expect(page.locator('.table tbody tr').first()).toContainText('Budget.xlsx');
  await page.locator('.vnav').getByRole('button', { name: 'Old files' }).click();
  await expect(page.locator('.table tbody tr').first()).toContainText('Quarterly report.pdf');
  await page.locator('.vnav').getByRole('button', { name: 'Duplicates' }).click();
  const dup = page.locator('.dup-group', { hasText: 'Quarterly report.pdf' });
  await expect(dup).toContainText('2 copies');
  await expect(page.locator('.dup-group', { hasText: 'badge.svg' })).toBeVisible();
  await shot(page, '33-duplicates');
  await page.locator('.vnav').getByRole('button', { name: 'Empty folders' }).click();
  const inbox = page.locator('tr', { hasText: 'Inbox' });
  await expect(inbox).toBeVisible();
  await inbox.getByRole('button', { name: 'Delete folder' }).click();
  await page.getByRole('dialog', { name: 'Delete Inbox?' }).getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.locator('tr', { hasText: 'Inbox' })).toHaveCount(0);
  await page.close();
});

test('large uploads go up in resumable 16 MB chunks and arrive byte-for-byte', async ({ request }) => {
  const page = await context.newPage();
  const chunkCalls: string[] = [];
  page.on('request', r => { if (/\/api\/drive\/uploads\/[^/]+\/chunks\/\d+$/.test(r.url())) chunkCalls.push(r.url()); });
  await page.goto('/#drive');
  await page.getByRole('treeitem', { name: 'Media' }).click();
  const big = Buffer.alloc(40 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i * 2654435761 >>> 0, i);
  await page.getByTestId('upload-input').setInputFiles({ name: 'big-film.bin', mimeType: 'application/octet-stream', buffer: big });
  const panel = page.getByRole('region', { name: 'Uploads' });
  await expect(panel).toContainText('big-film.bin');
  await expect(panel).toContainText('Done', { timeout: 60_000 });
  expect(chunkCalls.length).toBe(3);
  const uploads = await (await request.get('http://127.0.0.1:18550/api/v1/__uploads')).json();
  const stored = uploads.find((u: any) => u.name === 'big-film.bin');
  expect(stored.size).toBe(big.length);
  expect(stored.sha).toBe(createHash('sha256').update(big).digest('hex'));
  expect(stored.folder_id).toBe(1002);
  await page.close();
});

test('blocklist: operator blocks and unblocks an address', async ({ playwright }) => {
  const page = await context.newPage();
  await page.goto('/#security');
  await page.getByLabel('IP address to block').fill('192.0.2.77');
  await page.getByLabel('Reason').fill('scanner');
  await page.getByLabel('Block duration').selectOption('permanent');
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  const scannerRow = page.locator('tr', { hasText: '192.0.2.77' });
  await expect(scannerRow).toContainText('scanner');
  // A permanent block shows as such and does not expire on its own.
  await expect(scannerRow).toContainText('Permanent');
  const target = await visitor(playwright, '192.0.2.77');
  // Blocked: the status probe still answers (for the banned screen) and reports the ban; real routes 403.
  expect((await (await target.get('/api/public/status')).json()).banned).toBe(true);
  expect((await target.get('/api/auth/me')).status()).toBe(403);
  await page.locator('tr', { hasText: '192.0.2.77' }).getByRole('button', { name: 'Unblock' }).click();
  await expect(page.locator('tr', { hasText: '192.0.2.77' })).toHaveCount(0);
  expect((await (await target.get('/api/public/status')).json()).banned).toBeFalsy();
  await target.dispose();
  await shot(page, '08-security');
  await page.close();
});

test('overview and system diagnostics reflect the recorded activity', async () => {
  const page = await context.newPage();
  await page.goto('/#overview');
  await expect(page.locator('.kpi', { hasText: 'Failed attempts' })).not.toContainText(/^0$/);
  await expect(page.locator('.panel', { hasText: 'Threat sources' })).toContainText('192.0.2.99');
  // The current hour's bar reflects the traffic generated by this suite.
  await expect.poll(async () => Number(await page.locator('.chart-bar').last().getAttribute('height'))).toBeGreaterThan(20);
  await expect(page.locator('.chart-point').first()).toBeVisible();
  await expect(page.locator('.panel', { hasText: 'Threat sources' })).toContainText('Blocked');
  await expect(page.locator('.panel', { hasText: 'System checks' }).locator('li.is-running, li.is-queued')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.panel', { hasText: 'System checks' })).toContainText('accepted');
  await shot(page, '03-overview');
  await page.getByRole('button', { name: 'System' }).click();
  await expect(page.locator('.sweep-list li.is-running, .sweep-list li.is-queued')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.sweep-list')).toContainText('quick_check=ok');
  await shot(page, '09-system');
  await page.close();
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 820, height: 1180, mobile: true },
  { name: 'tablet-landscape', width: 1024, height: 768, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
  { name: 'desktop-xl', width: 2560, height: 1440, mobile: false },
];

test('every screen fits phones, tablets, laptops and large desktops without sideways scrolling', async ({ browser }) => {
  const probe = await context.newPage();
  const userAgent = await probe.evaluate(() => navigator.userAgent);
  await probe.close();
  const state = await context.storageState();
  for (const vp of VIEWPORTS) {
    // Fresh visitor: the pre-login screen.
    const anon = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.90' } });
    const gate = await anon.newPage();
    await gate.goto('/');
    await expect(gate.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    expect(await gate.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${vp.name} gate overflow`).toBeLessThanOrEqual(1);
    if (vp.name === 'phone') await shot(gate, '20-phone-gate');
    await anon.close();

    // Signed-in operator (same browser fingerprint, so the session stays valid).
    const ctx = await browser.newContext({ storageState: state, userAgent, viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, extraHTTPHeaders: { 'X-Forwarded-For': OPERATOR_IP } });
    const page = await ctx.newPage();
    for (const route of ['overview', 'access', 'visitors', 'sessions', 'audit', 'drive', 'security', 'system']) {
      await page.goto(`/#${route}`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.page, .vault').first()).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => { try { return a.effect.getComputedTiming().iterations !== Infinity; } catch { return false; } }).map(a => a.finished.catch(() => {}))));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${vp.name} ${route} overflow`).toBeLessThanOrEqual(1);
      if (route === 'drive') await expect(page.locator('.file-grid, table.rtable').first()).toBeVisible();
      if (route === 'overview') await expect(page.locator('.kpi').first()).toBeVisible();
      if ((vp.name === 'phone' && ['overview', 'visitors', 'drive'].includes(route)) || (vp.name === 'tablet' && route === 'drive') || (vp.name === 'desktop-xl' && route === 'drive')) {
        await page.waitForTimeout(600);
        await shot(page, `2${vp.name === 'phone' ? '1-phone' : vp.name === 'tablet' ? '2-tablet' : '5-xl'}-${route}`);
      }
    }
    // Sections are tabs in the top bar; on phones and small tablets they dock to the bottom edge of the screen.
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    await tabs.getByRole('button', { name: 'Sign-in attempts' }).click();
    await expect(page.getByRole('heading', { name: 'Sign-in attempts', level: 1 })).toBeVisible();
    const tb = (await tabs.boundingBox())!;
    if (vp.width <= 900) expect(Math.round(tb.y + tb.height), `${vp.name} dock sits on the bottom edge`).toBe(vp.height);
    else expect(tb.y, `${vp.name} tabs sit in the top bar`).toBeLessThan(80);
    // Row actions must be on screen (not clipped off the right edge) at every size.
    await page.goto('/#visitors');
    const block = page.getByRole('button', { name: /^(Block|Unblock)$/ }).first();
    await block.scrollIntoViewIfNeeded();
    const bb = await block.boundingBox();
    expect(bb!.x + bb!.width, `${vp.name} visitors action`).toBeLessThanOrEqual(vp.width);
    await page.goto('/#drive');
    await page.getByRole('button', { name: 'List view' }).click();
    const more = page.getByRole('button', { name: /^Actions for / }).first();
    await more.scrollIntoViewIfNeeded();
    const mb = await more.boundingBox();
    expect(mb!.x + mb!.width, `${vp.name} file actions`).toBeLessThanOrEqual(vp.width);
    // Folder browsing: the shelf sits above the files at every size.
    await page.goto('/#drive');
    await expect(page.getByRole('tree', { name: 'Folders' })).toBeVisible();
    await page.getByRole('treeitem', { name: 'Media' }).click();
    await expect(page.locator('.vault-title')).toHaveText('Media');
    // The viewer fills a phone screen and still fits on desktops.
    await page.getByRole('button', { name: 'Grid view' }).click();
    await page.getByTestId('file-grid').getByRole('button', { name: 'Open Night patrol.webm' }).click();
    const panel = page.locator('.viewer-panel');
    await expect(panel).toHaveCSS('opacity', '1');
    const box = await panel.boundingBox();
    if (vp.width <= 720) expect(Math.round(box!.width)).toBe(vp.width);
    else expect(box!.width).toBeLessThanOrEqual(vp.width);
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    if (vp.name === 'phone') await shot(page, '24-phone-video');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await ctx.close();
  }
});

test('the audit trail detects tampering in the database', async () => {
  const before = await (await context.request.get('/api/console/audit')).json();
  expect(before.chain.ok).toBe(true);
  const db = new DatabaseSync(join(DATA_DIR, 'console.db'));
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare("UPDATE audit SET detail = '{\"edited\":true}' WHERE id = 3").run();
  db.close();
  const after = await (await context.request.get('/api/console/audit')).json();
  expect(after.chain.ok).toBe(false);
  expect(after.chain.brokenAt).toBe(3);
  expect(after.chain.reason).toBe('row contents altered');
  const page = await context.newPage();
  await page.goto('/#audit');
  await expect(page.locator('.banner')).toContainText('Tampering detected at entry 3');
  await shot(page, '10-tamper');
  await page.close();
});

test('the account locks after repeated wrong passwords, even with the right one afterwards', async ({ playwright }) => {
  const ctx = await visitor(playwright, '192.0.2.200');
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await ctx.post('/api/auth/login', { data: { username: OPERATOR, password: `Wrong-Guess-${i}-xx` } })).status());
  expect(statuses).toEqual([401, 401, 401, 401, 423]);
  const correct = await ctx.post('/api/auth/login', { data: { username: OPERATOR, password: PASSWORD } });
  expect(correct.status()).toBe(423);
  expect((await correct.json()).error.code).toBe('ACCOUNT_LOCKED');
  await ctx.dispose();
  const attempts = await (await context.request.get('/api/console/attempts?ip=192.0.2.200')).json();
  expect(attempts.attempts[0].result).toBe('locked');
});

test('hardening: hidden from search engines, installable, and sign-ups from one address are capped', async ({ playwright, request }) => {
  const home = await request.get('/');
  expect(home.headers()['x-robots-tag']).toContain('noindex');
  expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /');
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect((await manifest.json()).name).toBe('Kurovault');
  for (const icon of ['/logo.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) expect((await request.get(icon)).status()).toBe(200);

  const ctx = await visitor(playwright, '198.51.100.201');
  const make = (i: number) => ctx.post('/api/auth/register', { data: { name: `Bulk ${i}`, username: `bulk${i}`, password: 'Quiet-River-88', confirm: 'Quiet-River-88' } });
  for (let i = 0; i < 3; i += 1) expect((await make(i)).status()).toBe(200);
  const fourth = await make(3);
  expect(fourth.status()).toBe(429);
  expect((await fourth.json()).error.code).toBe('SIGNUP_LIMIT');
  await ctx.dispose();
});

test('hardening: members manage their own devices; the admin can switch an account off, on, and remove it', async ({ playwright }) => {
  const reg = { name: 'Dana Device', username: 'dana', password: 'Quiet-River-88' };
  const phone = await visitor(playwright, '198.51.100.210');
  const laptop = await visitor(playwright, '198.51.100.211');
  const csrfPhone = (await (await phone.post('/api/auth/register', { data: { ...reg, confirm: reg.password } })).json()).csrf;
  expect((await signInApi(laptop, 'dana', reg.password)).status()).toBe(200);

  // Dana sees both browsers and only her own.
  const mine = (await (await phone.get('/api/auth/sessions')).json()).sessions;
  expect(mine).toHaveLength(2);
  expect(mine.filter((s: any) => s.current)).toHaveLength(1);
  expect((await phone.post('/api/auth/sessions/revoke-others', { data: {} })).status()).toBe(403); // no CSRF token
  expect((await (await phone.post('/api/auth/sessions/revoke-others', { data: {}, headers: { 'X-CSRF-Token': csrfPhone } })).json()).count).toBe(1);
  expect((await laptop.get('/api/auth/me')).status()).toBe(401);
  expect((await phone.get('/api/auth/me')).status()).toBe(200);
  // A member cannot use the admin's account controls.
  expect((await phone.post('/api/console/users/1/disable', { data: {}, headers: { 'X-CSRF-Token': csrfPhone } })).status()).toBe(403);

  // Admin, in the UI: switch Dana off.
  const page = await context.newPage();
  await page.goto('/#sessions');
  const accounts = page.getByRole('table', { name: 'Accounts' });
  const row = accounts.getByRole('row').filter({ hasText: '@dana' });
  await row.getByRole('button', { name: 'Switch off' }).click();
  await expect(row.getByText('switched off')).toBeVisible();
  expect((await phone.get('/api/auth/me')).status()).toBe(401);
  const refused = await signInApi(laptop, 'dana', reg.password);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('ACCOUNT_DISABLED');
  // A wrong password on a switched-off account says nothing about its state.
  expect((await (await signInApi(laptop, 'dana', 'not-the-password')).json()).error.code).toBe('INVALID_CREDENTIALS');

  await row.getByRole('button', { name: 'Switch on' }).click();
  await expect(row.getByText('active')).toBeVisible();
  expect((await signInApi(laptop, 'dana', reg.password)).status()).toBe(200);

  // The admin account itself is protected; Dana can be removed for good.
  const adminCsrf = (await (await context.request.get('/api/auth/me')).json()).csrf;
  expect((await context.request.delete('/api/console/users/1', { headers: { 'X-CSRF-Token': adminCsrf } })).status()).toBe(400);
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove account' }).click();
  await expect(row).toHaveCount(0);
  expect((await laptop.get('/api/auth/me')).status()).toBe(401);
  expect((await signInApi(laptop, 'dana', reg.password)).status()).toBe(401);
  await page.close(); await phone.dispose(); await laptop.dispose();
});

test('hardening: a locked account still lets its owner in from an address they have used before', async ({ playwright }) => {
  const owner = await visitor(playwright, '198.51.100.220');
  const attacker = await visitor(playwright, '198.51.100.221');
  const reg = { name: 'Lock Owner', username: 'lockowner', password: 'Quiet-River-88' };
  expect((await owner.post('/api/auth/register', { data: { ...reg, confirm: reg.password } })).status()).toBe(200);
  let last = 0;
  for (let i = 0; i < 5; i += 1) last = (await signInApi(attacker, 'lockowner', `wrong-guess-${i}`)).status();
  expect(last).toBe(423);
  // Even the right password is refused from the stranger's address while locked…
  expect((await signInApi(attacker, 'lockowner', reg.password)).status()).toBe(423);
  // …but the owner, on an address they signed in from before, is not shut out.
  expect((await signInApi(owner, 'lockowner', reg.password)).status()).toBe(200);
  await owner.dispose(); await attacker.dispose();
});

test('on a phone the sign-in screen shows only the sign-in box', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Create account' })).toBeVisible();
  for (const hidden of ['.cover-title', '.cover-panels', '.cover-art']) await expect(page.locator(hidden).first()).toBeHidden();
  // Nothing sits on top of the two tabs.
  for (const name of ['Sign in', 'Create account']) {
    const covered = await page.getByRole('tab', { name }).evaluate(el => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + 4); return !(top === el || el.contains(top)); });
    expect(covered, `${name} tab is covered`).toBe(false);
  }
  await page.getByRole('tab', { name: 'Create account' }).click();
  await expect(page.locator('.auth-tabs')).toHaveAttribute('data-mode', 'register');
  await expect(page.getByLabel('Confirm password')).toBeVisible();
  await phone.close();
});


test('links: the server refuses URLs that resolve to private or local addresses (SSRF guard)', async ({ playwright }) => {
  const ctx = await visitor(playwright, '198.51.100.55');
  await ctx.post('/api/auth/register', { data: { name: 'Link Guard', username: 'linkguard', password: 'Quiet-River-88', confirm: 'Quiet-River-88' } });
  const token = (await (await ctx.get('/api/auth/me')).json()).csrf;
  const post = (url) => ctx.post('/api/links', { data: { url }, headers: { 'X-CSRF-Token': token } });
  for (const url of ['http://127.0.0.1:9000/x.mp4', 'http://169.254.169.254/latest/meta-data/x.mp4', 'http://localhost/x.mp4', 'http://10.0.0.5/x.mp4', 'http://[::1]/x.mp4']) {
    const res = await post(url);
    expect(res.status(), url).toBe(400);
    expect(['BLOCKED_HOST', 'UNRESOLVABLE'], url).toContain((await res.json()).error.code);
  }
  await ctx.dispose();
});


test('a blocked visitor gets the banned takeover; everyone else is unaffected, and unblocking restores access', async ({ browser }) => {
  const csrf = (await (await context.request.get('/api/auth/me')).json()).csrf;
  expect((await context.request.post('/api/console/blocks', { data: { ip: '203.0.113.77', minutes: 60, reason: 'test ban' }, headers: { 'X-CSRF-Token': csrf } })).status()).toBe(200);

  // The blocked address loads only the shell + status, then sees the banned screen.
  const banned = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.77' } });
  const bp = await banned.newPage();
  const seen: Record<string, number> = {};
  bp.on('response', r => { const m = r.url().match(/\/api\/([^?]+)/); if (m) seen[m[1]] = r.status(); });
  await bp.goto('/');
  await expect(bp.getByRole('heading', { name: 'BANNED' })).toBeVisible();
  expect(seen['public/status']).toBe(200);
  expect(seen['auth/me']).toBe(403);
  // Every other API route truly refuses them.
  expect((await (await banned.request.get('/api/console/users')).json()).error.code).toBe('BANNED');
  expect((await banned.request.post('/api/auth/login', { data: { username: 'admin', password: 'x' } })).status()).toBe(403);
  await banned.close();

  // A different address still reaches the normal gate.
  const other = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.78' } });
  const op = await other.newPage();
  await op.goto('/');
  await expect(op.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await other.close();

  // Unblocking lets the address back in.
  expect((await context.request.delete('/api/console/blocks/203.0.113.77', { headers: { 'X-CSRF-Token': csrf } })).status()).toBe(200);
  const back = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.77' } });
  const kp = await back.newPage();
  await kp.goto('/');
  await expect(kp.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await back.close();
});
