// Entry point: node server/index.js
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config, { logger: { level: process.env.TDC_LOG_LEVEL ?? 'warn' } });

if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && !config.tls && !config.trustProxy) {
  console.warn('\n  ! Listening on a network interface without TLS. Set TDC_TLS_CERT/TDC_TLS_KEY or run behind an HTTPS reverse proxy (TDC_TRUST_PROXY=1, TDC_COOKIE_SECURE=1).\n');
}

await app.listen({ host: config.host, port: config.port });
const address = app.server.address();
const url = `${config.tls ? 'https' : 'http'}://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
console.log(`\n  Kurovault listening on ${url}`);
console.log(`  Data directory: ${config.dataDir}`);
if (config.platform) console.log(`  Host: ${config.platform} — visitor IPs from ${config.clientIpHeader ?? 'X-Forwarded-For (1 proxy hop)'}, secure cookies on`);
if (!app.adminReady()) {
  console.log('\n  ! No admin account yet. Set TDC_ADMIN_PASSWORD (12+ characters) and restart to create the "admin" sign-in.\n');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
