import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import fs from 'fs';
import path from 'path';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import {
  type TrackerConfig,
  type TrackerStats,
  type FieldExtractor,
  type Credentials,
} from './types.js';
import { getProxyConfig, ensureProxyReady } from './proxy.js';
import { closeAllSshTunnels } from './sshTunnel.js';
import { curlImpersonateGet, CurlSession, fastFetchEnabled } from './curlImpersonate.js';
import { buildCookieHeader } from './browserFetcher.js';
import { getTrackerTotpSecret } from './db.js';
import { generateTotp } from './totp.js';
import { selectUserAgent } from './userAgent.js';
import { closeBrowserSession, closeBrowserSessions, fetchWithBrowser } from './browserFetcher.js';

// ─── Transforms ──────────────────────────────────────────────────────────────

function parseBytes(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  // Normaliser les espaces insecables encodes en entites HTML (&nbsp; &#160; &#xa0;)
  // et le caractere   -> espace, sinon le nombre et l'unite restent colles.
  const s = String(raw)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/ /g, ' ')
    .trim()
    .replace(',', '.');
  const m = s.match(/([\d\s.\u202f]+)\s*([KMGTPE](?:i?B|io|o)|B|o)/i);
  if (!m) return parseFloat(s) || 0;
  const n = parseFloat(m[1].replace(/[\s\u202f]/g, ''));
  const u = m[2].toUpperCase();
  const map: Record<string, number> = {
    B: 1,
    O: 1,
    KB: 1e3,   MB: 1e6,   GB: 1e9,   TB: 1e12,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KO: 1e3,   MO: 1e6,   GO: 1e9,   TO: 1e12,
    KIO: 1024, MIO: 1024 ** 2, GIO: 1024 ** 3, TIO: 1024 ** 4,
  };
  return Math.round(n * (map[u] ?? 1));
}

function applyTransform(raw: unknown, tf?: string): string | number {
  if (raw === undefined || raw === null || raw === '') return '';
  switch (tf) {
    case 'bytes':   return parseBytes(raw);
    case 'number': {
      const s = String(raw).trim();
      if (/^(infinite|infinity|inf|∞)$/i.test(s)) return '∞';
      return parseFloat(s.replace(',', '.')) || 0;
    }
    case 'integer': return parseInt(String(raw), 10) || 0;
    default:        return String(raw);
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc == null) return undefined;
    const arr = key.match(/^(.+)\[(\d+)\]$/);
    if (arr) return (acc as Record<string, unknown[]>)[arr[1]]?.[parseInt(arr[2])];
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function extractJson(
  json: unknown,
  fields: Record<string, FieldExtractor>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ext] of Object.entries(fields)) {
    if (!ext.path) continue;
    out[name] = applyTransform(getPath(json, ext.path), ext.transform);
  }
  return out;
}

function extractHtml(
  html: string,
  fields: Record<string, FieldExtractor>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ext] of Object.entries(fields)) {
    if (!ext.regex) continue;
    const match = new RegExp(ext.regex, 's').exec(html);
    const val   = match?.groups?.['value'] ?? match?.[1];
    out[name]   = applyTransform(val, ext.transform);
  }
  return out;
}

function hasExtractedValues(fields: Record<string, string | number>): boolean {
  return Object.values(fields).some(value => (
    value !== '' && value !== undefined && value !== null
  ));
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('tls_get_more_records') ||
    message.includes('packet length too long') ||
    message.includes('EPROTO')
  ) {
    return `${message} - erreur TLS/proxy probable : verifier le type du proxy configure (HTTP vs HTTPS vs SOCKS)`;
  }
  return message;
}

function missingExtractedFields(
  configuredFields: Record<string, FieldExtractor>,
  extractedFields: Record<string, string | number>,
): string[] {
  return Object.keys(configuredFields).filter(key => {
    if (key === 'bufferBytes' && extractedFields.uploadedBytes !== '' && extractedFields.downloadedBytes !== '') {
      return false;
    }
    // L'absence de MP non lu est le cas normal : pas de regex match attendu quand 0 message.
    // On ne le compte donc jamais comme champ manquant (sinon log + dump 'partial' a chaque refresh).
    if (key === 'unreadMessages') {
      return false;
    }
    const value = extractedFields[key];
    return value === '' || value === undefined || value === null;
  });
}

// Requête secondaire optionnelle (fetch.unreadFetch) : récupère le compteur de MP
// non lus depuis un endpoint dédié quand il n'est pas dans la réponse principale
// (ex. C411). Réutilise le client authentifié (cookies/token via headers). Best-effort :
// toute erreur renvoie '' (champ vide → badge masqué), sans jamais casser le tracker.
async function fetchUnreadMessages(
  client: AxiosInstance,
  tracker: TrackerConfig,
  headers: Record<string, string>,
): Promise<string | number> {
  const uf = tracker.fetch.unreadFetch;
  if (!uf) return '';
  try {
    const url = resolveUrl(tracker.baseUrl, uf.url);
    const res = await client.get<string>(url, { responseType: 'text', headers });
    if (res.status >= 400) return '';
    // On réutilise les extracteurs existants via un champ unique "unreadMessages".
    const single: Record<string, FieldExtractor> = {
      unreadMessages: { path: uf.path, regex: uf.regex, transform: uf.transform },
    };
    const rt = uf.responseType ?? (uf.path ? 'json' : 'html');
    let out: Record<string, string | number>;
    if (rt === 'json') {
      let json: unknown;
      try { json = JSON.parse(res.data); } catch { return ''; }
      out = extractJson(json, single);
    } else {
      out = extractHtml(res.data, single);
    }
    return out.unreadMessages ?? '';
  } catch {
    return '';
  }
}

function writeDebugDump(
  tracker: TrackerConfig,
  url: string,
  html: string,
  extractedFields: Record<string, string | number>,
  reason = 'extract',
): string | null {
  try {
    const dir = path.join(process.cwd(), 'config', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const safeId = tracker.id.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = path.join(dir, `${safeId}-${reason}-last.html`);
    const metaPath = path.join(dir, `${safeId}-${reason}-last.json`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(metaPath, JSON.stringify({
      trackerId: tracker.id,
      trackerName: tracker.name,
      reason,
      url,
      dumpedAt: new Date().toISOString(),
      htmlLength: html.length,
      configuredFields: tracker.fetch.fields,
      extractedFields,
    }, null, 2));
    return htmlPath;
  } catch {
    return null;
  }
}

function writeLoginDebugDump(
  tracker: TrackerConfig,
  url: string,
  html: string,
  details: Record<string, unknown>,
): string | null {
  const path = writeDebugDump(tracker, url, html, {}, 'login');
  if (!path) return null;
  try {
    const metaPath = path.replace(/\.html$/, '.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      trackerId: tracker.id,
      trackerName: tracker.name,
      reason: 'login',
      url,
      dumpedAt: new Date().toISOString(),
      htmlLength: html.length,
      ...details,
    }, null, 2));
  } catch {
    // Keep login diagnostics best-effort only.
  }
  return path;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function resolveUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  // Si c'est déjà une URL absolue, on la retourne telle quelle
  if (/^https?:\/\//.test(relativePath)) return relativePath;
  return new URL(relativePath, base).toString();
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractHiddenInputs(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $('input[name]').each((_, input) => {
    const name = $(input).attr('name');
    if (!name) return;
    const type = ($(input).attr('type') ?? 'text').toLowerCase();
    const shouldCarry =
      type === 'hidden' ||
      (type === 'text' && name.startsWith('_'));
    if (!shouldCarry) return;
    fields[name] = $(input).attr('value') ?? '';
  });
  return fields;
}

function hasFailurePattern(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (text.toLowerCase().includes(p.toLowerCase())) return p;
  }
  return null;
}

function hasBrowserAuthFailure(
  tracker: TrackerConfig,
  url: string,
  html: string,
): string | null {
  const pathName = new URL(url).pathname;
  if (tracker.id === 'yggreborn' && pathName.startsWith('/account')) return null;
  if (pathName.includes('login') || pathName.includes('sign-in') || pathName.includes('signin')) return 'login-url';
  if (['kufirc', 'happyfappy', 'empornium'].includes(tracker.id)) {
    const lower = html.toLowerCase();
    const hasLoginLink = lower.includes('href="/login"') || lower.includes("href='/login'");
    const hasLogoutLink = lower.includes('href="/logout"') || lower.includes("href='/logout'");
    if (hasLoginLink && !hasLogoutLink) return 'public-home';
  }
  return hasFailurePattern(html, tracker.login.failurePatterns);
}

function isAnubisChallenge(html: string): boolean {
  return html.includes('id="anubis_challenge"') ||
    html.includes('/.within.website/x/cmd/anubis/') ||
    html.includes("Vérification que vous n&#39;êtes pas un robot") ||
    html.includes("Verification que vous n&#39;etes pas un robot");
}

// ─── 2FA en deux etapes (Laravel Fortify / UNIT3D) ─────────────────────────────
// Apres le login user+password, certains trackers redirigent vers une page dediee
// "two-factor-challenge" ou il faut soumettre le code TOTP avec un nouveau CSRF.
function isTwoFactorPage(html: string): boolean {
  return /two-factor-challenge/i.test(html) ||
    /Two[\s-]?Factor Authentication/i.test(html) ||
    (/name=["']code["']/i.test(html) && /recovery_code/i.test(html));
}

function extractCsrfToken(html: string): string {
  const m = /(?:name="_token"[^>]*?\svalue="|name="csrf-token"[^>]*?\scontent=")(?<value>[^"]+)"/.exec(html);
  return m?.groups?.['value'] ?? '';
}

function extractFormAction(html: string): string {
  const m = /<form[^>]*\baction=["']([^"']+)["']/i.exec(html);
  return m?.[1] ?? '';
}

// Page anti-bot / challenge JS (Cloudflare & co) : signaux frequents quand l'IP du
// client est filtree -> la vraie page (avec le token CSRF) n'est jamais servie.
function isAntiBotPage(html: string): boolean {
  const h = html.toLowerCase();
  return h.includes('cf-turnstile') ||
    h.includes('challenge-platform') ||
    h.includes('just a moment') ||
    h.includes('attention required') ||
    h.includes('cf-chl-') ||
    h.includes('/cdn-cgi/challenge-platform') ||
    h.includes('please enable javascript and cookies to continue') ||
    h.includes('ddos-guard');
}

// ─── Session cache ────────────────────────────────────────────────────────────

interface Session {
  client: AxiosInstance;
  jar: CookieJar;
  loggedInAt: number;
  /** Jeton "Authorization: Bearer" recupere au login (cf. login.tokenField) */
  bearerToken?: string;
}

// Sessions gardées en mémoire — une par tracker
const sessions = new Map<string, Session>();

// Relogin si la session a plus de 4h
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function requestUrl(config: InternalAxiosRequestConfig): string | null {
  if (!config.url) return null;
  try {
    return new URL(config.url, config.baseURL).toString();
  } catch {
    return null;
  }
}

async function storeResponseCookies(
  jar: CookieJar,
  response: AxiosResponse,
): Promise<void> {
  const url = response.config ? requestUrl(response.config) : null;
  const setCookie = response.headers['set-cookie'];
  if (!url || !setCookie) return;

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  await Promise.all(cookies.map(cookie => jar.setCookie(cookie, url)));
}

function attachCookieJar(client: AxiosInstance, jar: CookieJar): void {
  client.interceptors.request.use(async config => {
    const url = requestUrl(config);
    if (!url) return config;

    const cookie = await jar.getCookieString(url);
    if (cookie) config.headers.set('Cookie', cookie);
    return config;
  });

  client.interceptors.response.use(
    async response => {
      await storeResponseCookies(jar, response);
      return response;
    },
    async error => {
      if (error.response) {
        await storeResponseCookies(jar, error.response);
      }
      throw error;
    },
  );
}

function createSession(trackerId?: string): Session {
  const jar    = new CookieJar();
  const client = axios.create({
    withCredentials: true,
    timeout: 45_000,
    maxRedirects: 10,
    validateStatus: () => true, // on gère les erreurs nous-mêmes
    ...getProxyConfig(trackerId),
    headers: {
      'User-Agent': selectUserAgent(),
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  attachCookieJar(client, jar);
  return { client, jar, loggedInAt: 0 };
}

function getSession(trackerId: string): Session {
  if (!sessions.has(trackerId)) {
    sessions.set(trackerId, createSession(trackerId));
  }
  return sessions.get(trackerId)!;
}

export function invalidateSession(trackerId: string): void {
  // Recrée une session propre (nouveau jar = plus de vieux cookies)
  sessions.set(trackerId, createSession(trackerId));
  closeBrowserSession(trackerId).catch(() => {});
}

export function invalidateAllSessions(): void {
  sessions.clear();
  closeBrowserSessions().catch(() => {});
  closeAllSshTunnels(); // un changement de proxy doit fermer les tunnels SSH existants
  console.log('[Proxy] Sessions invalidées — reconnexion au prochain refresh');
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(
  tracker: TrackerConfig,
  creds: { username: string; password: string },
  session: Session,
): Promise<void> {
  const { client, jar } = session;
  const cfg        = tracker.login;
  const base       = tracker.baseUrl;
  let refererUrl   = resolveUrl(base, cfg.url);

  const vars: Record<string, string> = {
    username: creds.username,
    password: creds.password,
  };
  // 2FA : si un secret TOTP est enregistre pour ce tracker, on genere le code
  // courant. Disponible via le placeholder {{otp}} dans le body, et injecte
  // automatiquement dans login.otpField si defini.
  const totpSecret = getTrackerTotpSecret(tracker.id);
  if (totpSecret) {
    const code = generateTotp(totpSecret);
    if (code) vars.otp = code;
  }
  let hiddenInputs: Record<string, string> = {};

  // ── 1. Pre-step (CSRF token, etc.) ─────────────────────────────────────────
  if (cfg.preStep) {
    const preUrl = resolveUrl(base, cfg.preStep.url);
    refererUrl = preUrl;
    const preRes = await client.get<string>(preUrl, { responseType: 'text' });
    if (cfg.preStep.includeHiddenInputs) {
      hiddenInputs = extractHiddenInputs(preRes.data);
    }

    for (const [key, ext] of Object.entries(cfg.preStep.extract)) {
      const match = new RegExp(ext.regex, 's').exec(preRes.data);
      vars[key]   = match?.groups?.['value'] ?? match?.[1] ?? '';
      if (!vars[key]) {
        // La page de pre-login ne contient pas le token attendu. Quasi toujours :
        // ce n'est PAS la vraie page de login mais une page anti-bot / challenge /
        // blocage (selon l'IP), ou une page d'erreur. On dump pour diagnostic et on
        // donne un message actionnable plutot qu'un cryptique "impossible d'extraire".
        const dumpPath = writeDebugDump(tracker, preUrl, preRes.data, {}, 'prelogin');
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        if (isAnubisChallenge(preRes.data) || isAntiBotPage(preRes.data)) {
          throw new Error(`Pre-login : page de login non servie (challenge anti-bot / Cloudflare ou IP bloquee) — fournir un cookie de session pour ce tracker${suffix}`);
        }
        throw new Error(`Pre-login : token "${key}" introuvable sur ${preUrl} (page de login inattendue : anti-bot, redirection, ou site indisponible)${suffix}`);
      }
    }
  }

  // ── 1bis. GET preliminaires (cookies anti-bot/session, best-effort) ─────────
  for (const preVisitUrl of cfg.preVisitUrls ?? []) {
    try {
      const r = await client.get<string>(resolveUrl(base, preVisitUrl), { responseType: 'text' });
      await storeResponseCookies(jar, r);
    } catch {
      // best-effort uniquement
    }
  }

  // ── 2. POST login ───────────────────────────────────────────────────────────
  const loginUrl = resolveUrl(base, cfg.postUrl ?? cfg.url);
  const bodyObj: Record<string, string> = { ...hiddenInputs };
  for (const [k, v] of Object.entries(cfg.body)) {
    bodyObj[k] = interpolate(v, vars);
  }
  // Injection auto du code 2FA dans le champ configure (si pas deja present)
  if (vars.otp && cfg.otpField && !(cfg.otpField in bodyObj)) {
    bodyObj[cfg.otpField] = vars.otp;
  }

  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Origin': new URL(base).origin,
    'Referer': refererUrl,
  };
  if (cfg.csrfHeader && vars._csrf) jsonHeaders[cfg.csrfHeader] = vars._csrf;

  let loginRes;
  if ((cfg.contentType ?? 'form') === 'json') {
    loginRes = await client.post<string>(loginUrl, bodyObj, {
      responseType: 'text',
      maxRedirects: 0,
      headers: jsonHeaders,
    });
    await storeResponseCookies(jar, loginRes);

    // ── 2bis. Login API JSON (C411/Torr9-style) : MFA en 2 etapes, champ de
    // succes, et jeton Bearer eventuel — flux entierement distinct du HTML.
    let resultJson = parseJsonRecord(loginRes.data);

    if (cfg.mfaStep && resultJson?.[cfg.mfaStep.triggerField]) {
      if (!vars.otp) {
        const dumpPath = writeLoginDebugDump(tracker, loginUrl, loginRes.data, { reason: 'mfa-no-secret' });
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`2FA requise par le tracker mais aucun secret TOTP enregistre — renseigne le secret 2FA dans Options avancees${suffix}`);
      }
      const mfaUrl = resolveUrl(base, cfg.mfaStep.url);
      const mfaRes = await client.post<string>(mfaUrl, { [cfg.mfaStep.codeField]: vars.otp }, {
        responseType: 'text',
        maxRedirects: 0,
        headers: jsonHeaders,
      });
      await storeResponseCookies(jar, mfaRes);
      resultJson = parseJsonRecord(mfaRes.data);
      const mfaSuccessField = cfg.mfaStep.successField ?? 'success';
      if (!resultJson?.[mfaSuccessField]) {
        const dumpPath = writeLoginDebugDump(tracker, mfaUrl, mfaRes.data, {
          status: mfaRes.status,
          reason: `champ JSON "${mfaSuccessField}" absent/false apres MFA`,
        });
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`Login échoué — MFA: champ JSON "${mfaSuccessField}" absent/false${suffix}`);
      }
    } else if (cfg.successField) {
      if (!resultJson?.[cfg.successField]) {
        const dumpPath = writeLoginDebugDump(tracker, loginUrl, loginRes.data, {
          status: loginRes.status,
          reason: `champ JSON "${cfg.successField}" absent/false`,
        });
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`Login échoué — champ JSON "${cfg.successField}" absent/false${suffix}`);
      }
    } else if (loginRes.status >= 400) {
      throw new Error(`Login échoué — HTTP ${loginRes.status}`);
    }

    if (cfg.tokenField && resultJson?.[cfg.tokenField]) {
      session.bearerToken = String(resultJson[cfg.tokenField]);
    }

    session.loggedInAt = Date.now();
    console.log(`  [${tracker.name}] Login OK`);
    return;
  } else {
    loginRes = await client.post<string>(
      loginUrl,
      new URLSearchParams(bodyObj).toString(),
      {
        responseType: 'text',
        maxRedirects: 0,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': new URL(base).origin,
          'Referer': refererUrl,
        },
      },
    );
  }

  // ── 3. Vérifier l'échec ─────────────────────────────────────────────────────
  await storeResponseCookies(jar, loginRes);

  let verificationHtml = loginRes.data;
  let landedUrl = loginUrl;
  const location = loginRes.headers.location;
  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    landedUrl = resolveUrl(loginUrl, Array.isArray(location) ? location[0] : location);
    const redirectedRes = await client.get<string>(landedUrl, {
      responseType: 'text',
      maxRedirects: 0,
    });
    await storeResponseCookies(jar, redirectedRes);
    verificationHtml = redirectedRes.data;
  }

  // ── 3bis. 2FA en deux etapes (Fortify/UNIT3D) ───────────────────────────────
  if (isTwoFactorPage(verificationHtml)) {
    if (!vars.otp) {
      const dumpPath = writeLoginDebugDump(tracker, landedUrl, verificationHtml, { reason: '2fa-no-secret' });
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`2FA requise par le tracker mais aucun secret TOTP enregistre — renseigne le secret 2FA dans Options avancees${suffix}`);
    }
    const token = extractCsrfToken(verificationHtml);
    const action = extractFormAction(verificationHtml);
    const challengeUrl = action ? resolveUrl(landedUrl, action) : (landedUrl !== loginUrl ? landedUrl : resolveUrl(base, 'two-factor-challenge'));
    const twoFaBody: Record<string, string> = { [cfg.otpField || 'code']: vars.otp };
    if (token) twoFaBody['_token'] = token;
    const twoFaRes = await client.post<string>(challengeUrl, new URLSearchParams(twoFaBody).toString(), {
      responseType: 'text',
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': new URL(base).origin,
        'Referer': challengeUrl,
      },
    });
    await storeResponseCookies(jar, twoFaRes);
    verificationHtml = twoFaRes.data;
    const twoFaLoc = twoFaRes.headers.location;
    if (twoFaRes.status >= 300 && twoFaRes.status < 400 && twoFaLoc) {
      const after2faUrl = resolveUrl(challengeUrl, Array.isArray(twoFaLoc) ? twoFaLoc[0] : twoFaLoc);
      const after2faRes = await client.get<string>(after2faUrl, { responseType: 'text', maxRedirects: 0 });
      await storeResponseCookies(jar, after2faRes);
      verificationHtml = after2faRes.data;
    }
  } else if (cfg.otpStep && landedUrl.includes(cfg.otpStep.urlContains)) {
    // ── 3ter. 2FA via page dediee (Nexum: /login/2fa) ─────────────────────────
    if (!vars.otp) {
      const dumpPath = writeLoginDebugDump(tracker, landedUrl, verificationHtml, { reason: 'otpStep-no-secret' });
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`2FA requise par le tracker mais aucun secret TOTP enregistre — renseigne le secret 2FA dans Options avancees${suffix}`);
    }
    const otpToken = extractCsrfToken(verificationHtml);
    const otpBody: Record<string, string> = { ...extractHiddenInputs(verificationHtml) };
    otpBody[cfg.otpStep.field] = vars.otp;
    if (otpToken) otpBody['_token'] = otpToken;
    const otpRes = await client.post<string>(landedUrl, new URLSearchParams(otpBody).toString(), {
      responseType: 'text',
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': new URL(base).origin,
        'Referer': landedUrl,
      },
    });
    await storeResponseCookies(jar, otpRes);
    verificationHtml = otpRes.data;
    const otpLoc = otpRes.headers.location;
    if (otpRes.status >= 300 && otpRes.status < 400 && otpLoc) {
      landedUrl = resolveUrl(landedUrl, Array.isArray(otpLoc) ? otpLoc[0] : otpLoc);
      const afterOtpRes = await client.get<string>(landedUrl, { responseType: 'text', maxRedirects: 0 });
      await storeResponseCookies(jar, afterOtpRes);
      verificationHtml = afterOtpRes.data;
    }
    if (landedUrl.includes(cfg.otpStep.urlContains)) {
      const dumpPath = writeLoginDebugDump(tracker, landedUrl, verificationHtml, {
        reason: 'otpStep-2fa-refusee',
        otp: vars.otp,
        status: otpRes.status,
        location: otpRes.headers.location ?? null,
      });
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Login échoué — 2FA refusée (code TOTP invalide/expiré ou tentatives bloquées)${suffix}`);
    }
  }

  const failed = hasFailurePattern(verificationHtml, cfg.failurePatterns);
  if (failed) {
    const dumpPath = writeLoginDebugDump(tracker, loginUrl, verificationHtml, {
      failedPattern: failed,
      status: loginRes.status,
      location: loginRes.headers.location ?? null,
      hiddenInputNames: Object.keys(hiddenInputs),
      bodyFieldNames: Object.keys(bodyObj),
    });
    const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
    throw new Error(`Login échoué — "${failed}" trouvé dans la réponse${suffix}`);
  }
  if (loginRes.status >= 400 && loginRes.status !== 302) {
    const dumpPath = writeLoginDebugDump(tracker, loginUrl, verificationHtml, {
      status: loginRes.status,
      location: loginRes.headers.location ?? null,
      hiddenInputNames: Object.keys(hiddenInputs),
      bodyFieldNames: Object.keys(bodyObj),
    });
    const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
    throw new Error(`Login échoué — HTTP ${loginRes.status}${suffix}`);
  }

  session.loggedInAt = Date.now();
  console.log(`  [${tracker.name}] Login OK`);
}

// ─── Ping (reachability) ──────────────────────────────────────────────────────

type SiteReachability = NonNullable<TrackerStats['siteReachability']>;

/**
 * Ping rapide via HEAD (fallback GET) sur baseUrl pour distinguer
 * "site joignable" d'une erreur reseau / proxy / serveur.
 *
 * Joignable : reponse HTTP 1xx/2xx/3xx ou 4xx hors 403/451.
 * Non joignable :
 *  - 'network'       : echec reseau / TLS / proxy / DNS / timeout
 *  - 'http_5xx'      : reponse >= 500 (panne serveur / blocage Cloudflare)
 *  - 'http_forbidden': 403 ou 451 (acces refuse - IP bannie ou geo-block)
 */
export async function pingTracker(tracker: TrackerConfig): Promise<SiteReachability> {
  const url = tracker.baseUrl;
  const config = {
    timeout: 10_000,
    maxRedirects: 5,
    validateStatus: () => true,
    ...getProxyConfig(tracker.id),
    headers: {
      'User-Agent': selectUserAgent(),
      'Accept': 'text/html,*/*;q=0.8',
    },
  };

  const classify = (status: number): SiteReachability => {
    if (status === 403 || status === 451) return { reachable: false, reason: 'http_forbidden', statusCode: status };
    if (status >= 500) return { reachable: false, reason: 'http_5xx', statusCode: status };
    return { reachable: true, statusCode: status };
  };

  let headStatus: number | null = null;
  try {
    const res = await axios.head(url, config);
    headStatus = res.status;
    const classified = classify(res.status);
    // Si HEAD est OK (joignable ou interdit explicitement), on tranche directement.
    // Pour un 5xx, on retente en GET car certains serveurs renvoient 5xx sur HEAD mais 200 sur GET.
    if (classified.reachable || classified.reason !== 'http_5xx') return classified;
  } catch {
    // Echec reseau sur HEAD - on tente GET avant de declarer 'network'
  }

  try {
    const res = await axios.get(url, { ...config, responseType: 'text' });
    return classify(res.status);
  } catch {
    // GET a echoue aussi : si HEAD avait renvoye un 5xx, on garde cette info
    if (headStatus !== null && headStatus >= 500) {
      return { reachable: false, reason: 'http_5xx', statusCode: headStatus };
    }
    return { reachable: false, reason: 'network' };
  }
}

// ─── Fetch principal ──────────────────────────────────────────────────────────

export async function fetchTracker(
  tracker: TrackerConfig,
  creds: { username: string; password: string },
): Promise<TrackerStats> {
  // Proxy SSH : etablir le tunnel SSH + SOCKS5 local avant tout (HTTP comme navigateur).
  await ensureProxyReady(tracker.id);
  let session = getSession(tracker.id);
  const vars: Record<string, string> = {
    username: creds.username,
    password: creds.password,
  };

  const buildStatsFromHtml = (url: string, html: string): TrackerStats => {
    if (isAnubisChallenge(html)) {
      const dumpPath = writeDebugDump(tracker, url, html, {}, 'anubis');
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Challenge Anubis recu depuis ${url} - validation JavaScript navigateur requise${suffix}`);
    }

    let fields: Record<string, string | number>;
    if (tracker.fetch.responseType === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(html);
      } catch {
        throw new Error('Reponse attendue en JSON, recu du HTML (mauvais endpoint ?)');
      }
      fields = extractJson(json, tracker.fetch.fields);
    } else {
      fields = extractHtml(html, tracker.fetch.fields);
    }

    if (!hasExtractedValues(fields)) {
      const dumpPath = writeDebugDump(tracker, url, html, fields);
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Aucune donnee extraite depuis ${url} - selecteurs/regex a ajuster${suffix}`);
    }

    const missingFields = missingExtractedFields(tracker.fetch.fields, fields);
    if (missingFields.length > 0) {
      const dumpPath = writeDebugDump(tracker, url, html, fields, 'partial');
      console.log(`  [${tracker.name}] Champs manquants: ${missingFields.join(', ')}${dumpPath ? ` - dump: ${dumpPath}` : ''}`);
    }

    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'ok',
      lastUpdated: new Date().toISOString(),
      lastLoginAt: session.loggedInAt ? new Date(session.loggedInAt).toISOString() : undefined,
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields,
    };
  };

  // Fast-path curl-impersonate : pour un tracker en mode navigateur disposant d'un
  // cookie de session, on tente d'abord une requete HTTP impersonee (sans Chromium).
  // Si la page est rendue cote serveur et la session valide -> stats directes.
  // Sinon (SPA, session morte, binaire absent) -> on retombe sur le navigateur.
  const tryCurlFastPath = async (): Promise<TrackerStats | null> => {
    if (!fastFetchEnabled()) return null;
    const cookie = buildCookieHeader(tracker.id);
    if (!cookie) return null;
    const url = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, vars));
    // Pas de userAgent ici : le wrapper curl-impersonate pose deja un UA Chrome
    // coherent avec son empreinte TLS. Le surcharger casserait la coherence.
    const result = await curlImpersonateGet(tracker.id, url, {
      cookie,
      timeoutMs: 30_000,
    }).catch(() => null);
    if (!result || result.status >= 400 || !result.body) return null;
    if (hasFailurePattern(result.body, tracker.login.failurePatterns)) return null;
    if (isAnubisChallenge(result.body)) return null;
    try {
      const stats = buildStatsFromHtml(url, result.body); // throw si aucune valeur extraite
      console.log(`  [${tracker.name}] Fast-path curl-impersonate OK (navigateur evite)`);
      return stats;
    } catch {
      return null;
    }
  };

  // Login + fetch HTTP via curl-impersonate (empreinte TLS de vrai Chrome) : passe
  // le filtrage passif Cloudflare/anti-bot que rejette l'empreinte Node d'axios.
  // Rejoue tout le flux (page CSRF -> POST -> stats) avec un jar de cookies. En cas
  // d'echec/binaire absent -> null, et la voie axios prouvee prend le relais.
  const attemptHttpViaCurl = async (): Promise<TrackerStats | null> => {
    if (!fastFetchEnabled()) { console.log(`  [${tracker.name}] curl: fast-fetch désactivé`); return null; }
    const cfg = tracker.login;
    // 2FA via page dediee (Nexum) : non reproduit ici, on laisse la voie axios
    // (doLogin) gerer ce cas.
    if (cfg.otpStep) return null;
    if (cfg.cookieOnly) return null;
    if (!(await CurlSession.available(tracker.curlBinary))) { console.log(`  [${tracker.name}] curl: binaire indisponible`); return null; }
    console.log(`  [${tracker.name}] curl: tentative login via ${tracker.curlBinary || 'curl_chrome116'}`);
    const base = tracker.baseUrl;
    const cvars: Record<string, string> = { username: creds.username, password: creds.password };
    const totpSecret = getTrackerTotpSecret(tracker.id);
    if (totpSecret) {
      const code = generateTotp(totpSecret);
      if (code) {
        cvars.otp = code;
        cvars.totp = code; // alias pour {{totp}} dans le body
      }
    }

    const sess = new CurlSession(tracker.id, tracker.curlBinary);
    try {
      let referer = resolveUrl(base, cfg.url);
      let hiddenInputs: Record<string, string> = {};

      if (cfg.preStep) {
        const preUrl = resolveUrl(base, cfg.preStep.url);
        referer = preUrl;
        const pre = await sess.request(preUrl, { timeoutMs: 30_000 });
        if (!pre || pre.status >= 400 || !pre.body) { console.log(`  [${tracker.name}] curl: preStep échoué status=${pre?.status}`); return null; }
        console.log(`  [${tracker.name}] curl: preStep OK status=${pre.status} len=${pre.body.length} antibot=${isAntiBotPage(pre.body)} body=${pre.body.slice(0,300)}`);
        if (isAntiBotPage(pre.body)) { console.log(`  [${tracker.name}] curl: preStep anti-bot`); return null; }
        if (cfg.preStep.includeHiddenInputs) hiddenInputs = extractHiddenInputs(pre.body);
        for (const [key, ext] of Object.entries(cfg.preStep.extract)) {
          const m = new RegExp(ext.regex, 's').exec(pre.body);
          cvars[key] = m?.groups?.['value'] ?? m?.[1] ?? '';
          console.log(`  [${tracker.name}] curl: preStep extract key=${key} found=${!!cvars[key]}`);
          if (!cvars[key]) { console.log(`  [${tracker.name}] curl: preStep token '${key}' introuvable`); return null; }
        }
      }

      for (const preVisitUrl of cfg.preVisitUrls ?? []) {
        await sess.request(resolveUrl(base, preVisitUrl), { timeoutMs: 30_000 }).catch(() => null);
      }

      const bodyObj: Record<string, string> = { ...hiddenInputs };
      for (const [k, v] of Object.entries(cfg.body)) bodyObj[k] = interpolate(v, cvars);
      if (cvars.otp && cfg.otpField && !(cfg.otpField in bodyObj)) bodyObj[cfg.otpField] = cvars.otp;

      const loginUrl = resolveUrl(base, cfg.postUrl ?? cfg.url);
      const isJson = (cfg.contentType ?? 'form') === 'json';
      const data = isJson ? JSON.stringify(bodyObj) : new URLSearchParams(bodyObj).toString();
      const postHeaders: Record<string, string> = {
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        'Origin': new URL(base).origin,
        'Referer': referer,
      };
      if (cfg.csrfHeader && cvars._csrf) postHeaders[cfg.csrfHeader] = cvars._csrf;
      const postRes = await sess.request(loginUrl, {
        method: 'POST',
        data,
        headers: postHeaders,
        timeoutMs: 30_000,
        maxRedirects: isJson ? 0 : undefined,
      });
      if (!postRes) { console.log(`  [${tracker.name}] curl: POST login null`); return null; }
      console.log(`  [${tracker.name}] curl: POST status=${postRes.status} len=${postRes.body.length} 2fa=${isTwoFactorPage(postRes.body)} body=${postRes.body.slice(0,300)}`);

      if (!isJson && !cfg.mfaStep && hasFailurePattern(postRes.body, cfg.failurePatterns)) {
        const dumpPath = writeLoginDebugDump(tracker, loginUrl, postRes.body, {
          reason: 'curl-login-failed',
          status: postRes.status,
          bodyFieldNames: Object.keys(bodyObj),
        });
        console.log(`  [${tracker.name}] curl: login échoué (formulaire de login retourné) - dump: ${dumpPath}`);
        return null;
      }

      // Flux JSON multi-etapes (MFA TOTP / jeton Bearer) : reponse API pure,
      // pas de page HTML a parser.
      if (isJson && (cfg.mfaStep || cfg.successField || cfg.tokenField)) {
        let resultJson = parseJsonRecord(postRes.body);

        if (cfg.mfaStep && resultJson?.[cfg.mfaStep.triggerField]) {
          if (!cvars.otp) { console.log(`  [${tracker.name}] curl: MFA requise mais pas de TOTP configuré`); return null; }
          const mfaUrl = resolveUrl(base, cfg.mfaStep.url);
          const mfaHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'Origin': new URL(base).origin,
            'Referer': referer,
          };
          if (cfg.csrfHeader && cvars._csrf) mfaHeaders[cfg.csrfHeader] = cvars._csrf;
          const mfaRes = await sess.request(mfaUrl, {
            method: 'POST',
            data: JSON.stringify({ [cfg.mfaStep.codeField]: cvars.otp }),
            headers: mfaHeaders,
            timeoutMs: 30_000,
            maxRedirects: 0,
          });
          if (!mfaRes) { console.log(`  [${tracker.name}] curl: MFA POST null`); return null; }
          console.log(`  [${tracker.name}] curl: MFA status=${mfaRes.status} len=${mfaRes.body.length} body=${mfaRes.body.slice(0,300)}`);
          resultJson = parseJsonRecord(mfaRes.body);
          const mfaSuccessField = cfg.mfaStep.successField ?? 'success';
          if (!resultJson?.[mfaSuccessField]) {
            console.log(`  [${tracker.name}] curl: MFA échouée, champ "${mfaSuccessField}" absent/false - body=${mfaRes.body.slice(0,300)}`);
            return null;
          }
        }

        let bearerToken: string | undefined;
        if (cfg.tokenField && resultJson?.[cfg.tokenField]) bearerToken = String(resultJson[cfg.tokenField]);

        const url = resolveUrl(base, interpolate(tracker.fetch.url, cvars));
        const fetchHeaders: Record<string, string> = { Referer: loginUrl };
        if (bearerToken) {
          fetchHeaders['Authorization'] = `Bearer ${bearerToken}`;
          fetchHeaders['Accept'] = 'application/json';
        }
        const fetchRes = await sess.request(url, { headers: fetchHeaders, timeoutMs: 30_000 });
        if (!fetchRes || fetchRes.status >= 400 || !fetchRes.body) { console.log(`  [${tracker.name}] curl: fetch échoué status=${fetchRes?.status}`); return null; }
        console.log(`  [${tracker.name}] curl: fetch OK status=${fetchRes.status} bodyLen=${fetchRes.body.length}`);
        if (hasFailurePattern(fetchRes.body, cfg.failurePatterns)) { console.log(`  [${tracker.name}] curl: failure pattern détecté - début body: ${fetchRes.body.slice(0,300)}`); return null; }

        if (cfg.successField) {
          const fetchJson = parseJsonRecord(fetchRes.body);
          if (!fetchJson?.[cfg.successField]) {
            console.log(`  [${tracker.name}] curl: champ JSON "${cfg.successField}" absent/false sur fetch - body=${fetchRes.body.slice(0,300)}`);
            return null;
          }
        }

        try {
          const stats = buildStatsFromHtml(url, fetchRes.body);
          console.log(`  [${tracker.name}] Login+fetch via curl-impersonate OK (JSON/MFA)`);
          return stats;
        } catch {
          return null;
        }
      }

      // 2FA en deux etapes (Fortify/UNIT3D) : si on a atterri sur la page de challenge
      if (isTwoFactorPage(postRes.body)) {
        if (!cvars.otp) return null; // pas de secret -> repli axios (message clair)
        const token = extractCsrfToken(postRes.body);
        const action = extractFormAction(postRes.body);
        const challengeUrl = action ? resolveUrl(base, action) : resolveUrl(base, 'two-factor-challenge');
        const twoFaBody: Record<string, string> = { [cfg.otpField || 'code']: cvars.otp };
        if (token) twoFaBody['_token'] = token;
        const twoFaRes = await sess.request(challengeUrl, {
          method: 'POST',
          data: new URLSearchParams(twoFaBody).toString(),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': new URL(base).origin,
            'Referer': challengeUrl,
          },
          timeoutMs: 30_000,
        });
        if (!twoFaRes) return null;
      }

      const url = resolveUrl(base, interpolate(tracker.fetch.url, cvars));
      const fetchRes = await sess.request(url, { headers: { Referer: loginUrl }, timeoutMs: 30_000 });
      if (!fetchRes || fetchRes.status >= 400 || !fetchRes.body) { console.log(`  [${tracker.name}] curl: fetch échoué status=${fetchRes?.status}`); return null; }
      console.log(`  [${tracker.name}] curl: fetch OK status=${fetchRes.status} bodyLen=${fetchRes.body.length}`);
      if (hasFailurePattern(fetchRes.body, cfg.failurePatterns)) { console.log(`  [${tracker.name}] curl: failure pattern détecté - début body: ${fetchRes.body.slice(0,300)}`); return null; }
      if (isAnubisChallenge(fetchRes.body)) return null;

      try {
        const stats = buildStatsFromHtml(url, fetchRes.body);
        console.log(`  [${tracker.name}] Login+fetch via curl-impersonate OK (axios evite)`);
        return stats;
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      sess.dispose();
    }
  };

  const attempt = async (isRetry = false): Promise<TrackerStats> => {
    if (tracker.fetch.mode === 'browser') {
      if (!isRetry) {
        const fast = await tryCurlFastPath();
        if (fast) return fast;
        // Si pas de cookie sauvegardé, tenter le login complet via curl-impersonate
        // avant de lancer le navigateur (plus léger, contourne Cloudflare passif)
        const viaCurlFull = await attemptHttpViaCurl();
        if (viaCurlFull) return viaCurlFull;
      }
      const browserResult = await fetchWithBrowser(tracker, creds);
      // Si on a confirme la session via un indicateur DOM specifique (TR4KER : RATIO/UPLOAD/DOWNLOAD
      // visibles apres hydratation SPA), on ignore les failurePatterns qui peuvent matcher
      // la coquille initiale "non connectee".
      const failed = browserResult.authConfirmed
        ? null
        : hasBrowserAuthFailure(tracker, browserResult.url, browserResult.html);
      if (failed) {
        if (!isRetry) {
          console.log(`  [${tracker.name}] Session navigateur expiree, re-login...`);
          // Reset complet du contexte navigateur (cookies en memoire) avant retry —
          // pour les sites ou la session persistante est devenue invalide
          await closeBrowserSession(tracker.id).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 3000));
          return attempt(true);
        }
        const dumpPath = writeDebugDump(tracker, browserResult.url, browserResult.html, {}, 'browser-auth');
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`Session navigateur non authentifiee - verifier les credentials ou valider le challenge dans le profil navigateur${suffix}`);
      }
      return buildStatsFromHtml(browserResult.url, browserResult.html);
    }

    // Mode HTTP : on tente d'abord le login+fetch via curl-impersonate (empreinte
    // navigateur). Si indisponible/echec -> on poursuit sur la voie axios ci-dessous.
    if (!isRetry) {
      const viaCurl = await attemptHttpViaCurl();
      if (viaCurl) return viaCurl;
    }

    // Login si nécessaire
    const sessionExpired =
      !session.loggedInAt || Date.now() - session.loggedInAt > SESSION_TTL_MS;

    if (sessionExpired) {
      await doLogin(tracker, creds, session);
    }

    // Fetch des stats
    const url = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, vars));
    const fetchHeaders: Record<string, string> = {};
    if (session.bearerToken) {
      fetchHeaders['Authorization'] = `Bearer ${session.bearerToken}`;
      fetchHeaders['Accept'] = 'application/json';
    }
    const res  = await session.client.get<string>(url, { responseType: 'text', headers: fetchHeaders });

    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} lors du fetch de ${url}`);
    }

    // Pour les logins API JSON multi-etapes (C411) : le champ de succes
    // ("authenticated") se verifie sur la reponse du fetch, pas sur celle du login.
    if (tracker.login.mfaStep && tracker.login.successField) {
      const fetchJson = parseJsonRecord(res.data);
      if (!fetchJson?.[tracker.login.successField]) {
        if (isRetry) {
          const dumpPath = writeDebugDump(tracker, url, res.data, {}, 'fetch-not-authenticated');
          const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
          throw new Error(`Session expirée même après re-login — vérifier les credentials${suffix}`);
        }
        console.log(`  [${tracker.name}] Session expirée, re-login...`);
        invalidateSession(tracker.id);
        session = getSession(tracker.id);
        return attempt(true);
      }
    }

    // Détection session expirée après le fetch
    const failed = hasFailurePattern(res.data, tracker.login.failurePatterns);
    if (failed) {
      if (isRetry) {
        const dumpPath = writeDebugDump(tracker, url, res.data, {}, 'fetch-still-expired');
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`Session expirée même après re-login — vérifier les credentials${suffix}`);
      }
      console.log(`  [${tracker.name}] Session expirée, re-login...`);
      invalidateSession(tracker.id);
      session = getSession(tracker.id);
      return attempt(true);
    }

    if (isAnubisChallenge(res.data)) {
      const dumpPath = writeDebugDump(tracker, url, res.data, {}, 'anubis');
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Challenge Anubis recu depuis ${url} - validation JavaScript navigateur requise${suffix}`);
    }

    // Extraction des champs
    let fields: Record<string, string | number>;
    if (tracker.fetch.responseType === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(res.data);
      } catch {
        throw new Error('Réponse attendue en JSON, reçu du HTML (mauvais endpoint ?)');
      }
      fields = extractJson(json, tracker.fetch.fields);
    } else {
      fields = extractHtml(res.data, tracker.fetch.fields);
    }

    if (!hasExtractedValues(fields)) {
      const dumpPath = writeDebugDump(tracker, url, res.data, fields);
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Aucune donnee extraite depuis ${url} - selecteurs/regex a ajuster${suffix}`);
    }

    const missingFields = missingExtractedFields(tracker.fetch.fields, fields);
    if (missingFields.length > 0) {
      const dumpPath = writeDebugDump(tracker, url, res.data, fields, 'partial');
      console.log(`  [${tracker.name}] Champs manquants: ${missingFields.join(', ')}${dumpPath ? ` - dump: ${dumpPath}` : ''}`);
    }

    // MP non lus via requête secondaire (ex. C411) — best-effort, n'invalide pas le tracker.
    if (tracker.fetch.unreadFetch) {
      fields.unreadMessages = await fetchUnreadMessages(session.client, tracker, fetchHeaders);
    }

    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'ok',
      lastUpdated: new Date().toISOString(),
      lastLoginAt: session.loggedInAt ? new Date(session.loggedInAt).toISOString() : undefined,
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields,
    };
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    invalidateSession(tracker.id); // reset pour le prochain cycle
    const siteReachability = await pingTracker(tracker).catch((): SiteReachability => ({ reachable: false, reason: 'network' }));
    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       friendlyError(err),
      siteReachability,
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    };
  }
}

export async function fetchAll(
  trackers: TrackerConfig[],
  credentials: Credentials,
): Promise<TrackerStats[]> {
  const enabled = trackers.filter(t => t.enabled !== false);
  return Promise.all(
    enabled.map(tracker => {
      const creds = credentials[tracker.id];
      if (!creds) {
        return Promise.resolve<TrackerStats>({
          id:          tracker.id,
          name:        tracker.name,
          trackerUrl:  tracker.baseUrl,
          status:      'error',
          error:       `Credentials manquants dans credentials.json pour "${tracker.id}"`,
          lastUpdated: new Date().toISOString(),
          byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
          fields:      {},
        });
      }
      return fetchTracker(tracker, creds);
    }),
  );
}
