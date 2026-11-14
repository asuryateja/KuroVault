// Offline IP → city / state / country, using the free DB-IP "IP to City Lite" database (CC BY 4.0).
// Lookups happen on this server; no visitor address is ever sent to a third party.
// Attribution required by the licence: "IP Geolocation by DB-IP" (https://db-ip.com), shown in the UI.
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { classifyIp } from './ip.js';

const require = createRequire(import.meta.url);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function createGeo({ enabled = true } = {}) {
  let maxmind = null;
  let base = null;
  try {
    maxmind = require('maxmind');
    base = dirname(require.resolve('@ip-location-db/dbip-city-mmdb/package.json'));
  } catch { enabled = false; }
  const readers = { 4: null, 6: null };
  const loading = { 4: null, 6: null };
  const cache = new Map();

  function load(v) {
    if (!enabled) return Promise.resolve(null);
    loading[v] ??= maxmind.open(join(base, `dbip-city-ipv${v}.mmdb`), { watchForUpdates: false })
      .then(r => (readers[v] = r))
      .catch(() => null);
    return loading[v];
  }

  function describe(rec) {
    if (!rec) return null;
    const cc = String(rec.country_code ?? '').toUpperCase();
    let country = cc;
    try { country = cc ? regionNames.of(cc) ?? cc : ''; } catch { /* keep code */ }
    const city = String(rec.city ?? '').replace(/\s*\(.*\)\s*$/, '');
    const region = String(rec.state1 ?? '');
    const district = String(rec.state2 ?? '');
    return { city, district, region, country, countryCode: cc, label: [city, region, country].filter(Boolean).join(', ') };
  }

  /** Synchronous lookup; returns null for private addresses or while the database is still loading. */
  function lookup(rawIp) {
    if (!enabled || !rawIp) return null;
    const info = classifyIp(rawIp);
    if (info.scope !== 'public') return null;
    if (cache.has(info.ip)) return cache.get(info.ip);
    const v = isIP(info.ip);
    if (!v) return null;
    const reader = readers[v];
    if (!reader) { void load(v); return null; }
    let out = null;
    try { out = describe(reader.get(info.ip)); } catch { out = null; }
    cache.set(info.ip, out);
    if (cache.size > 20_000) cache.delete(cache.keys().next().value);
    return out;
  }

  return {
    enabled: () => enabled,
    lookup,
    /** Waits until the database for this address family is loaded, then looks it up. */
    async locate(rawIp) {
      const v = isIP(classifyIp(rawIp ?? '').ip);
      if (v) await load(v);
      return lookup(rawIp);
    },
    label: ip => lookup(ip)?.label ?? null,
    preload: () => Promise.all([load(4), load(6)]),
  };
}
