// Abstraction du runtime navigateur.
//
// Objectif : permettre d'externaliser Playwright/Chromium/CloakBrowser dans un
// service separe `tracker-dashboard-browser` sans casser les installations
// existantes.
//
// - Par defaut -> backend DISTANT sur http://127.0.0.1:3001, lance en conteneur
//   parallele avec `--network container:tracker-dashboard`.
// - Si `BROWSER_RUNTIME_URL` est defini, il remplace cette URL.
//   L'app principale
//   resout cookie/TOTP/moteur/proxy depuis la DB, les envoie dans le payload, et
//   le runtime execute le navigateur (il ne touche jamais la DB).
// - L'image principale reste allegee : Playwright/Chromium/CloakBrowser vivent
//   dans l'image tracker-dashboard-browser.

import { resolveProxyForTracker, toSshConfig } from './proxy.js';
import { getSshLocalEndpoint } from './sshTunnel.js';
import { getTrackerCookie, getTrackerTotpSecret, getJsonSetting } from './db.js';
import { type TrackerConfig } from './types.js';

export interface BrowserFetchResult {
  html: string;
  url: string;
  authConfirmed: boolean;
  extraHtml?: string;
}

export interface BrowserRuntimeStatus {
  mode: 'remote' | 'local';
  configured: boolean;
  available: boolean;
  url?: string;
  error?: string;
  runtime?: string;
  playwright?: string;
  chromiumVersion?: string;
  chromiumExecutable?: string;
  revision?: string;
  expectedRevision?: string;
  upToDate?: boolean;
  cloakbrowser?: { available: boolean; version?: string };
}

type ProxyPayload = { server: string; username?: string; password?: string } | null;

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3001';
const RUNTIME_URL = (process.env.BROWSER_RUNTIME_URL || DEFAULT_RUNTIME_URL).replace(/\/+$/, '');
const RUNTIME_TOKEN = process.env.BROWSER_RUNTIME_TOKEN || '';
const EXPECTED_REVISION = process.env.APP_IMAGE_REVISION?.trim() || '';
// Hote sous lequel le runtime peut joindre le tunnel SSH local de l'app principale
// (le runtime tourne dans un autre conteneur, 127.0.0.1 ne conviendrait pas).
const SELF_HOST_FOR_RUNTIME = process.env.SSH_TUNNEL_ADVERTISE_HOST || '';

export function isRemoteRuntimeConfigured(): boolean {
  return true;
}

export const BROWSER_RUNTIME_UNAVAILABLE =
  'Runtime navigateur indisponible. Lancez le conteneur tracker-dashboard-browser en parallele de tracker-dashboard.';

function runtimeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (RUNTIME_TOKEN) headers['X-Browser-Runtime-Token'] = RUNTIME_TOKEN;
  return headers;
}

// Resout le proxy au format Playwright pour le payload distant. Pour SSH, on pointe
// vers le SOCKS local du tunnel etabli par l'app principale ; son hote doit etre
// joignable par le runtime (SSH_TUNNEL_ADVERTISE_HOST), sinon le proxy est omis.
function resolveProxyPayload(trackerId: string): ProxyPayload {
  const proxy = resolveProxyForTracker(trackerId);
  if (!proxy.enabled || !proxy.host || !proxy.port) return null;
  if (proxy.type === 'ssh') {
    const ssh = toSshConfig(proxy);
    const endpoint = ssh ? getSshLocalEndpoint(ssh) : null;
    if (!endpoint) return null;
    const host = SELF_HOST_FOR_RUNTIME || endpoint.host;
    return { server: `socks5://${host}:${endpoint.port}` };
  }
  return {
    server: `${proxy.type}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

function buildOverrides(tracker: TrackerConfig) {
  return {
    cookie: getTrackerCookie(tracker.id) || '',
    totpSecret: getTrackerTotpSecret(tracker.id) || '',
    engine: getJsonSetting('browser_engine', 'chromium' as string),
    proxy: resolveProxyPayload(tracker.id),
  };
}

// Fallback de developpement local : utile uniquement si Playwright est present
// dans node_modules. L'image publiee utilise le runtime navigateur separe.
async function loadLocalBackend(): Promise<typeof import('./browserFetcher.js')> {
  try {
    return await import('./browserFetcher.js');
  } catch {
    throw new Error(BROWSER_RUNTIME_UNAVAILABLE);
  }
}

async function remotePost<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${RUNTIME_URL}${path}`, {
      method: 'POST',
      headers: runtimeHeaders(),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || `runtime HTTP ${response.status}`);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── API consommee par fetcher.ts / server.ts ────────────────────────────────

export async function fetchWithBrowser(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
): Promise<BrowserFetchResult> {
  if (isRemoteRuntimeConfigured()) {
    try {
      return await remotePost<BrowserFetchResult>('/fetch', {
        tracker,
        credentials,
        overrides: buildOverrides(tracker),
      });
    } catch (err) {
      // Erreur de connexion au runtime (absent/injoignable) -> message clair ;
      // une erreur applicative renvoyee par le runtime est propagee telle quelle.
      const msg = err instanceof Error ? err.message : String(err);
      if (/fetch failed|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) {
        throw new Error(BROWSER_RUNTIME_UNAVAILABLE);
      }
      throw err;
    }
  }
  const local = await loadLocalBackend();
  return local.fetchWithBrowser(tracker, credentials);
}

export async function fetchRawHtmlWithBrowser(url: string, trackerId = '__detect__'): Promise<string> {
  if (isRemoteRuntimeConfigured()) {
    try {
      const data = await remotePost<{ html: string }>('/fetch-raw', {
        url,
        trackerId,
        proxy: resolveProxyPayload(trackerId),
      });
      return data.html || '';
    } catch {
      return '';
    }
  }
  const local = await loadLocalBackend();
  return local.fetchRawHtmlWithBrowser(url, trackerId);
}

export async function closeBrowserSession(trackerId: string): Promise<void> {
  if (isRemoteRuntimeConfigured()) {
    await remotePost('/close-session', { trackerId }, 15_000).catch(() => {});
    return;
  }
  const local = await loadLocalBackend();
  await local.closeBrowserSession(trackerId);
}

export async function closeBrowserSessions(): Promise<void> {
  if (isRemoteRuntimeConfigured()) {
    await remotePost('/close-all', {}, 15_000).catch(() => {});
    return;
  }
  const local = await loadLocalBackend();
  await local.closeBrowserSessions();
}

export async function resetBrowserProfile(trackerId: string): Promise<void> {
  if (isRemoteRuntimeConfigured()) {
    await remotePost('/reset-profile', { trackerId }, 30_000);
    return;
  }
  const local = await loadLocalBackend();
  await local.resetBrowserProfile(trackerId);
}

export async function getBrowserRuntimeStatus(): Promise<BrowserRuntimeStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(`${RUNTIME_URL}/version`, {
      headers: RUNTIME_TOKEN ? { 'X-Browser-Runtime-Token': RUNTIME_TOKEN } : {},
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
      return { mode: 'remote', configured: Boolean(process.env.BROWSER_RUNTIME_URL), available: false, url: RUNTIME_URL, expectedRevision: EXPECTED_REVISION || undefined, error: `HTTP ${response.status}` };
    }
    const revision = typeof data.revision === 'string' ? data.revision : undefined;
    return {
      mode: 'remote',
      configured: Boolean(process.env.BROWSER_RUNTIME_URL),
      available: true,
      url: RUNTIME_URL,
      runtime: typeof data.runtime === 'string' ? data.runtime : undefined,
      playwright: typeof data.playwright === 'string' ? data.playwright : undefined,
      chromiumVersion: typeof data.chromiumVersion === 'string' ? data.chromiumVersion : undefined,
      chromiumExecutable: typeof data.chromiumExecutable === 'string' ? data.chromiumExecutable : undefined,
      revision,
      expectedRevision: EXPECTED_REVISION || undefined,
      upToDate: EXPECTED_REVISION && revision ? revision === EXPECTED_REVISION : undefined,
      cloakbrowser: (data.cloakbrowser && typeof data.cloakbrowser === 'object')
        ? data.cloakbrowser as { available: boolean; version?: string }
        : undefined,
    };
  } catch (err) {
    return { mode: 'remote', configured: Boolean(process.env.BROWSER_RUNTIME_URL), available: false, url: RUNTIME_URL, expectedRevision: EXPECTED_REVISION || undefined, error: err instanceof Error ? err.message : String(err) };
  }
}
