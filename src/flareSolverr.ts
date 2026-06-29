import { getTrackerCookie } from './db.js';
import { parseCookies, type ParsedCookie } from './cookies.js';
import { resolveProxyForTracker, toSshConfig, type ProxySettings } from './proxy.js';
import { getSshLocalEndpoint } from './sshTunnel.js';
import { type TrackerConfig } from './types.js';

const DEFAULT_FLARESOLVERR_URL = 'http://127.0.0.1:8191';

interface FlareCookie {
  name: string;
  value: string;
}

interface FlareSolution {
  url?: string;
  status?: number;
  response?: string;
  cookies?: FlareCookie[];
  userAgent?: string;
}

interface FlareResponse {
  status?: string;
  message?: string;
  session?: string;
  solution?: FlareSolution;
}

export interface FlareSolverrFetchResult {
  html: string;
  url: string;
  extraHtml?: string;
}

export interface FlareSolverrStatus {
  available: boolean;
  url: string;
  version?: string;
  userAgent?: string;
  error?: string;
}

export interface FlareSolverrOverrides {
  baseUrl?: string;
  cookieRaw?: string;
  proxy?: ProxySettings;
  timeoutMs?: number;
}

export function isFlareSolverrCandidate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /challenge|anti-bot|cloudflare|turnstile|cf-chl|just a moment|un instant/i.test(message);
}

function serviceUrl(override?: string): string {
  return (override || process.env.FLARESOLVERR_URL || DEFAULT_FLARESOLVERR_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return /^https?:\/\//.test(relativePath) ? relativePath : new URL(relativePath, base).toString();
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function flareCookies(cookies: ParsedCookie[]): FlareCookie[] {
  return cookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
  }));
}

function flareProxy(proxy: ProxySettings): Record<string, string> | undefined {
  if (!proxy.enabled || !proxy.host || !proxy.port) return undefined;

  let url: string;
  if (proxy.type === 'ssh') {
    const ssh = toSshConfig(proxy);
    const endpoint = ssh ? getSshLocalEndpoint(ssh) : null;
    if (!endpoint) return undefined;
    url = `socks5://${endpoint.host}:${endpoint.port}`;
  } else {
    url = `${proxy.type}://${proxy.host}:${proxy.port}`;
  }

  return {
    url,
    ...(proxy.username ? { username: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
  };
}

async function callFlareSolverr(
  baseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<FlareResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);
  try {
    const response = await fetch(`${baseUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({})) as FlareResponse;
    if (!response.ok || data.status !== 'ok') {
      throw new Error(data.message || `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function solve(
  baseUrl: string,
  session: string,
  url: string,
  cookies: FlareCookie[],
  timeoutMs: number,
): Promise<FlareSolution> {
  const result = await callFlareSolverr(baseUrl, {
    cmd: 'request.get',
    session,
    url,
    cookies,
    maxTimeout: timeoutMs,
    waitInSeconds: 2,
  }, timeoutMs);
  const solution = result.solution;
  if (!solution || typeof solution.response !== 'string' || (solution.status ?? 500) >= 400) {
    throw new Error(`reponse invalide pour ${url}`);
  }
  return solution;
}

export async function fetchWithFlareSolverr(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
  overrides: FlareSolverrOverrides = {},
): Promise<FlareSolverrFetchResult> {
  const baseUrl = serviceUrl(overrides.baseUrl);
  const requestedTimeout = overrides.timeoutMs ?? Number.parseInt(process.env.FLARESOLVERR_TIMEOUT_MS || '90000', 10);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(5_000, Math.min(180_000, requestedTimeout))
    : 90_000;
  const proxy = flareProxy(overrides.proxy ?? resolveProxyForTracker(tracker.id));
  const cookies = flareCookies(parseCookies(overrides.cookieRaw ?? getTrackerCookie(tracker.id)));
  const session = `tracker-dashboard-${tracker.id.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const created = await callFlareSolverr(baseUrl, {
    cmd: 'sessions.create',
    session,
    session_ttl_minutes: 5,
    ...(proxy ? { proxy } : {}),
  }, Math.min(timeoutMs, 30_000));
  const activeSession = created.session || session;

  try {
    const vars: Record<string, string> = {
      username: credentials.username,
      password: credentials.password,
    };
    const primaryUrl = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, vars));
    const primary = await solve(baseUrl, activeSession, primaryUrl, cookies, timeoutMs);

    let extraHtml: string | undefined;
    const extra = tracker.fetch.extraFetch;
    if (extra) {
      if (extra.idExtract) {
        const match = new RegExp(extra.idExtract.regex, 's').exec(primary.response ?? '');
        const id = match?.groups?.['value'];
        if (id) vars.id = id;
      }
      if (!extra.idExtract || vars.id) {
        try {
          const extraUrl = resolveUrl(tracker.baseUrl, interpolate(extra.url, vars));
          const solvedExtra = await solve(baseUrl, activeSession, extraUrl, [], timeoutMs);
          extraHtml = solvedExtra.response;
        } catch {
          // Comme les autres implementations extraFetch : le champ secondaire
          // reste best-effort et ne doit jamais invalider les statistiques principales.
        }
      }
    }

    return {
      html: primary.response ?? '',
      url: primary.url || primaryUrl,
      extraHtml,
    };
  } finally {
    await callFlareSolverr(baseUrl, { cmd: 'sessions.destroy', session: activeSession }, 15_000).catch(() => {});
  }
}

export async function getFlareSolverrStatus(baseUrlOverride?: string): Promise<FlareSolverrStatus> {
  const url = serviceUrl(baseUrlOverride);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${url}/`, { signal: controller.signal });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      available: true,
      url,
      version: typeof data.version === 'string' ? data.version : undefined,
      userAgent: typeof data.userAgent === 'string' ? data.userAgent : undefined,
    };
  } catch (error) {
    return { available: false, url, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
