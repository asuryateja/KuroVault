import { defineConfig } from '@playwright/test';

export const DATA_DIR = '/tmp/tdc-e2e-data';
export const TG_DATA_DIR = '/tmp/tdc-e2e-tg';
export const TG_URL = 'http://127.0.0.1:18642';
const chromium = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18640',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
  webServer: [
    {
      command: 'node tests/fake-drive.js',
      url: 'http://127.0.0.1:18550/api/v1/health',
      reuseExistingServer: false,
      env: { FAKE_DRIVE_PORT: '18550', FAKE_DRIVE_KEY: 'test-drive-key' },
    },
    {
      command: 'node tests/fake-streamtape.js',
      url: 'http://127.0.0.1:18595/health',
      reuseExistingServer: false,
      env: { FAKE_ST_PORT: '18595', FAKE_ST_LOGIN: 'test-st-login', FAKE_ST_KEY: 'test-st-key' },
    },
    {
      command: `rm -rf ${DATA_DIR} && node --disable-warning=ExperimentalWarning server/index.js`,
      url: 'http://127.0.0.1:18640/api/public/status',
      reuseExistingServer: false,
      env: {
        TDC_PORT: '18640',
        TDC_DATA_DIR: DATA_DIR,
        // Tests simulate many distinct visitors through X-Forwarded-For.
        TDC_TRUST_PROXY: '1',
        TDC_DRIVE_API_URL: 'http://127.0.0.1:18550/api/v1',
        TDC_RATE_AUTH_PER_MINUTE: '30',
        TDC_BLOCK_AFTER_FAILURES: '12',
        TDC_ADMIN_PASSWORD: 'Granite-Harbor-41-Lantern',
      },
    },
    {
      // Direct-Telegram mode against the in-process Telegram simulator.
      command: `rm -rf ${TG_DATA_DIR} && node --disable-warning=ExperimentalWarning server/index.js`,
      url: `${TG_URL}/api/public/status`,
      reuseExistingServer: false,
      env: {
        TDC_PORT: '18642',
        TDC_DATA_DIR: TG_DATA_DIR,
        TDC_TRUST_PROXY: '1',
        TDC_TELEGRAM_ADAPTER: 'fake',
        TDC_ADMIN_PASSWORD: 'Granite-Harbor-41-Lantern',
        TDC_ALLOW_FAKE_TELEGRAM: '1',
        TDC_DRIVE_API_URL: 'http://127.0.0.1:18599/api/v1',
        TDC_RATE_AUTH_PER_MINUTE: '60',
        // This server is by invitation only.
        TDC_INVITE_CODE: 'rook-takes-knight',
        // External-link playback: allow the local fixture hosts, and point Streamtape at the fake API.
        TDC_ALLOW_LOCAL_LINKS: '1',
        TDC_STREAMTAPE_BASE: 'http://127.0.0.1:18595',
      },
    },
  ],
});
