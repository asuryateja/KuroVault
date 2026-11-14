// Same-origin JSON client. The CSRF token lives only in memory.
let csrfToken = '';
export const setCsrf = (token: string) => { csrfToken = token; };
export const getCsrf = () => csrfToken;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

type Listener = (error: ApiError) => void;
const listeners = new Set<Listener>();
export const onApiError = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };

// Sudo: the shell registers a handler that asks for password + code, then we retry once.
let sudoHandler: (() => Promise<boolean>) | null = null;
export const setSudoHandler = (fn: (() => Promise<boolean>) | null) => { sudoHandler = fn; };

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } = {}, retried = false): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const response = await fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new ApiError(response.status, data?.error?.code ?? 'HTTP_' + response.status, data?.error?.message ?? `Request failed (${response.status})`, data?.error ?? {});
    if (error.code === 'SUDO_REQUIRED' && sudoHandler && !retried) {
      if (await sudoHandler()) return api<T>(path, init, true);
    }
    listeners.forEach(fn => fn(error));
    throw error;
  }
  return data as T;
}
