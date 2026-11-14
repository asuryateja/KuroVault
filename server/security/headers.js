// Strict response headers for every route.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

export function applySecurityHeaders(reply, { secure }) {
  reply.header('Content-Security-Policy', secure ? CSP : CSP.replace('; upgrade-insecure-requests', ''));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
  reply.header('Origin-Agent-Cluster', '?1');
  reply.header('X-DNS-Prefetch-Control', 'off');
  reply.header('X-Permitted-Cross-Domain-Policies', 'none');
  if (secure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

export const REQUIRED_HEADERS = [
  'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
  'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
];
