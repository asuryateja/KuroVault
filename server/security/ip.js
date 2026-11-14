// IP classification without any third-party lookups (no visitor data leaves the server).
import { isIP } from 'node:net';

export function normalizeIp(ip) {
  if (!ip) return 'unknown';
  const value = String(ip).trim();
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

export function classifyIp(rawIp) {
  const ip = normalizeIp(rawIp);
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return { ip, version: 4, scope: 'loopback' };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { ip, version: 4, scope: 'private' };
    if (a === 100 && b >= 64 && b <= 127) return { ip, version: 4, scope: 'carrier-nat' };
    if (a === 169 && b === 254) return { ip, version: 4, scope: 'link-local' };
    return { ip, version: 4, scope: 'public' };
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return { ip, version: 6, scope: 'loopback' };
    if (lower.startsWith('fe80')) return { ip, version: 6, scope: 'link-local' };
    if (lower.startsWith('fc') || lower.startsWith('fd')) return { ip, version: 6, scope: 'private' };
    return { ip, version: 6, scope: 'public' };
  }
  return { ip, version: 0, scope: 'unknown' };
}

export function describeAgent(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl\//i.test(s) ? 'curl'
    : /python|requests|httpx|aiohttp/i.test(s) ? 'Script' : /bot|crawl|spider/i.test(s) ? 'Bot' : s ? 'Other' : 'None';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'Unknown';
  const automated = /HeadlessChrome|bot|crawl|spider|curl|python|wget|httpx|go-http/i.test(s);
  return { browser, os, automated };
}
