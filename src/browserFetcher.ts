import fs from 'fs';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolveProxyForTracker, toSshConfig } from './proxy.js';
import { getSshLocalEndpoint } from './sshTunnel.js';
import { selectUserAgent } from './userAgent.js';
import { getTrackerCookie, getTrackerTotpSecret, getJsonSetting } from './db.js';
import { parseCookies } from './cookies.js';
import { generateTotp } from './totp.js';
import { type TrackerConfig } from './types.js';

// ─── Moteur navigateur : Chromium (defaut) ou CloakBrowser (furtif, opt-in) ─────
// CloakBrowser est un Chromium patche qui passe mieux les protections anti-bot.
// Drop-in Playwright : meme API launchPersistentContext / newPage / addCookies.
// Chargement dynamique + repli automatique sur Chromium si indisponible/echec,
// pour qu'une install cassee ne bloque jamais l'app.
interface CloakModule {
  launchPersistentContext: (opts: Record<string, unknown>) => Promise<BrowserContext>;
  ensureBinary?: () => Promise<unknown>;
}
let cloakModulePromise: Promise<CloakModule | null> | null = null;
async function loadCloak(): Promise<CloakModule | null> {
  if (!cloakModulePromise) {
    cloakModulePromise = (async () => {
      try {
        const spec = 'cloakbrowser'; // specifier non litteral -> non resolu a la compilation
        const mod = await import(spec) as unknown as CloakModule;
        return mod;
      } catch (err) {
        console.error('[CloakBrowser] Module indisponible, repli sur Chromium :', err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return cloakModulePromise;
}
// Overrides optionnels fournis par le runtime navigateur externe : ils remplacent
// les lectures DB (cookie, TOTP, moteur, proxy). Quand `overrides` est absent (chemin
// local historique), tout retombe sur la DB et le comportement est strictement identique.
export interface BrowserFetchOverrides {
  cookie?: string;
  totpSecret?: string;
  engine?: string;
  proxy?: { server: string; username?: string; password?: string } | null;
}

function cloakEnabled(overrides?: BrowserFetchOverrides): boolean {
  const engine = overrides?.engine ?? getJsonSetting('browser_engine', 'chromium' as string);
  return engine === 'cloak';
}

async function injectStoredCookies(tracker: TrackerConfig, context: BrowserContext, overrides?: BrowserFetchOverrides): Promise<void> {
  const raw = overrides ? (overrides.cookie ?? '') : getTrackerCookie(tracker.id);
  if (!raw) return;
  const parsed = parseCookies(raw);
  if (parsed.length === 0) {
    console.warn(`[Cookies] ${tracker.id} : aucun cookie reconnu dans la valeur fournie (format invalide ?)`);
    return;
  }
  // Injection via `url` : Playwright en deduit domaine/chemin -> robuste.
  const url = tracker.baseUrl;
  const cookies = parsed.map(c => ({
    name: c.name,
    value: c.value,
    url,
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
  }));
  try {
    await context.addCookies(cookies);
    console.log(`[Cookies] ${tracker.id} : ${cookies.length} cookie(s) injecte(s) (${parsed.map(c => c.name).join(', ')})`);
  } catch (err: unknown) {
    console.warn(`[Cookies] ${tracker.id} : injection echouee - ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Applique le cookie stocke a un contexte DEJA ouvert (sans le fermer), pour une
 * prise en compte immediate apres enregistrement, sans casser un fetch en cours.
 * Si aucun contexte n'existe, le cookie sera injecte au prochain getContext.
 */
export async function applyStoredCookies(tracker: TrackerConfig): Promise<void> {
  const context = contexts.get(tracker.id);
  if (context) await injectStoredCookies(tracker, context);
}

const PROFILE_DIR = path.join(process.cwd(), 'config', 'browser-profile');
const contexts = new Map<string, BrowserContext>();

function resolveUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  if (/^https?:\/\//.test(relativePath)) return relativePath;
  return new URL(relativePath, base).toString();
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function hasFailurePattern(text: string, patterns: string[] = []): boolean {
  return patterns.some(pattern => text.toLowerCase().includes(pattern.toLowerCase()));
}

function isLoginPath(pathname: string): boolean {
  return pathname.includes('login') || pathname.includes('sign-in') || pathname.includes('signin');
}

function isAnubisChallenge(html: string): boolean {
  return html.includes('id="anubis_challenge"') ||
    html.includes('/.within.website/x/cmd/anubis/') ||
    html.includes("Vérification que vous n&#39;êtes pas un robot") ||
    html.includes("Verification que vous n&#39;etes pas un robot");
}

function playwrightProxy(trackerId: string, overrides?: BrowserFetchOverrides): { server: string; username?: string; password?: string } | undefined {
  // Runtime externe : le proxy est deja resolu cote app principale (y compris le
  // socks du tunnel SSH), on l'utilise tel quel sans relire la DB ni le tunnel local.
  if (overrides) return overrides.proxy ?? undefined;
  const proxy = resolveProxyForTracker(trackerId);
  if (!proxy.enabled || !proxy.host || !proxy.port) return undefined;
  // Proxy SSH : on pointe vers le SOCKS5 local du tunnel (etabli par ensureProxyReady
  // avant le fetch). Sans tunnel pret, on sort sans proxy.
  if (proxy.type === 'ssh') {
    const ssh = toSshConfig(proxy);
    const endpoint = ssh ? getSshLocalEndpoint(ssh) : null;
    if (!endpoint) return undefined;
    return { server: `socks5://${endpoint.host}:${endpoint.port}` };
  }
  const server = `${proxy.type}://${proxy.host}:${proxy.port}`;
  return {
    server,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

async function getContext(tracker: TrackerConfig, overrides?: BrowserFetchOverrides): Promise<BrowserContext> {
  const existing = contexts.get(tracker.id);
  if (existing) return existing;

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const userDataDir = path.join(PROFILE_DIR, tracker.id);
  const launchOptions = {
    headless: true,
    userAgent: selectUserAgent(),
    proxy: playwrightProxy(tracker.id, overrides),
    viewport: { width: 1365, height: 900 },
    locale: 'fr-FR',
  };

  let context: BrowserContext | null = null;
  if (cloakEnabled(overrides)) {
    const cloak = await loadCloak();
    if (cloak) {
      try {
        context = await cloak.launchPersistentContext({ userDataDir, ...launchOptions });
        console.log(`[CloakBrowser] Contexte furtif lance pour ${tracker.id}`);
      } catch (err) {
        console.error(`[CloakBrowser] Echec lancement (${tracker.id}), repli Chromium :`, err instanceof Error ? err.message : err);
        context = null;
      }
    }
  }
  if (!context) {
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  }
  await injectStoredCookies(tracker, context, overrides);
  contexts.set(tracker.id, context);
  return context;
}

async function waitForAnubis(page: Page): Promise<void> {
  let lastHtml = '';
  for (let i = 0; i < 45; i += 1) {
    const html = await safeContent(page);
    lastHtml = html;
    if (!isAnubisChallenge(html)) return;
    await page.waitForTimeout(1000);
  }
  if (isAnubisChallenge(lastHtml)) {
    throw new Error('Challenge Anubis encore present apres 45s dans Chromium');
  }
}

async function waitForLiveView(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector('[data-phx-main].phx-loading'),
    null,
    { timeout: 30_000 },
  ).catch(() => {});
}

async function waitForTurnstile(page: Page): Promise<void> {
  if (await page.locator('.cf-turnstile').count() === 0) return;
  await page.waitForFunction(
    () => {
      const response = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
      return Boolean(response?.value);
    },
    null,
    { timeout: 20_000 },
  ).catch(() => {});
}

/**
 * Renvoie true si on a detecte un indicateur DOM de session authentifiee pour le tracker.
 * Permet de court-circuiter la detection de failurePatterns sur les SPAs qui affichent
 * une coquille "non connecte" avant hydratation (cas TR4KER).
 */
async function waitForTrackerContent(tracker: TrackerConfig, page: Page): Promise<boolean> {
  if ((tracker.baseId ?? tracker.id) === 'digitalcore') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Ratio:') && text.includes('UL:') && text.includes('DL:') && text.includes('Buffer:');
        },
        null,
        { timeout: 30_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if ((tracker.baseId ?? tracker.id) === 'lesaloonv2') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Rang') && text.includes('Upload') && text.includes('Download') && text.includes("Pièces d'or");
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (tracker.id === 'lesrescapesdeygg') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Upload total')
            && /Ratio r[ée]el/i.test(text)
            && text.includes('Sessions tracker actives');
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (tracker.id === 'milkie') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('keyboard_arrow_up') && text.includes('keyboard_arrow_down');
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (tracker.id === 'mam') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Uploaded') && text.includes('Downloaded') && text.includes('Share ratio');
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (['kufirc', 'happyfappy', 'empornium'].includes(tracker.id)) {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Credits') && text.includes('Up') && text.includes('Down') && text.includes('Ratio');
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (tracker.id === 'tigersdl') {
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return text.includes('Votre solde') || document.title.includes('Tigers : Seedbonus');
        },
        null,
        { timeout: 20_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if (tracker.id === 'memphis') {
    try {
      await page.waitForFunction(
        () => {
          // Memphis est une SPA : le HTML initial contient les coquilles des vues,
          // puis les statistiques du compte sont injectées après le chargement.
          // textContent est volontairement utilisé pour détecter aussi un panneau
          // profil encore masqué par la navigation SPA.
          const panel = document.querySelector('#account-health-panel');
          const text = panel?.textContent ?? document.body?.textContent ?? '';
          return /Ratio\s+indicatif/i.test(text)
            && /Envoyé/i.test(text)
            && /Reçu/i.test(text);
        },
        null,
        { timeout: 30_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  if ((tracker.baseId ?? tracker.id) !== 'tr4ker') return false;
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? '';
        return text.includes('RATIO') && text.includes('UPLOAD') && text.includes('DOWNLOAD');
      },
      null,
      { timeout: 60_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function revealMilkieStats(page: Page): Promise<void> {
  const hasStats = async () => page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return text.includes('keyboard_arrow_up') && text.includes('keyboard_arrow_down');
  }).catch(() => false);

  await page.waitForFunction(
    () => {
      const text = document.body?.innerText ?? '';
      return text.includes('Browse') || text.includes('Torrents') || Boolean(document.querySelector('app-root')?.children.length);
    },
    null,
    { timeout: 30_000 },
  ).catch(() => {});

  if (await hasStats()) return;

  for (const selector of ['mat-toolbar button', 'button.mat-menu-trigger', 'button[aria-haspopup="menu"]', 'button']) {
    const buttons = page.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i -= 1) {
      await buttons.nth(i).click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(300);
      if (await hasStats()) return;
    }
  }
}

// Page anti-bot / challenge JS (Cloudflare, DDoS-Guard...) affichee a la place du
// contenu attendu — typiquement quand il manque un cookie cf_clearance ou que l'IP
// de sortie ne correspond pas a celle ayant cree la session.
function looksAntiBot(html: string): boolean {
  const h = html.toLowerCase();
  return h.includes('cf-turnstile') ||
    h.includes('/cdn-cgi/challenge-platform/h/') ||
    h.includes('/cdn-cgi/challenge-platform/orchestrate/') ||
    h.includes('just a moment') ||
    h.includes('attention required') ||
    h.includes('cf-chl-') ||
    h.includes('please enable javascript and cookies to continue') ||
    h.includes('ddos-guard');
}

async function waitForAntiBotChallenge(page: Page): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (!looksAntiBot(await safeContent(page))) return;
    await page.waitForTimeout(1000);
  }
}

// Dump leger d'une page navigateur pour diagnostic (meme dossier que les autres dumps).
function writeBrowserDump(tracker: TrackerConfig, url: string, html: string, reason: string): string | null {
  try {
    const dir = path.join(process.cwd(), 'config', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const safeId = tracker.id.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = path.join(dir, `${safeId}-${reason}-last.html`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(htmlPath.replace(/\.html$/, '.json'), JSON.stringify({
      trackerId: tracker.id, trackerName: tracker.name, reason, url,
      dumpedAt: new Date().toISOString(), htmlLength: html.length,
    }, null, 2));
    return htmlPath;
  } catch {
    return null;
  }
}

async function safeContent(page: Page): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < 10; i += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      return await page.content();
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureLoggedIn(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
  page: Page,
  overrides?: BrowserFetchOverrides,
): Promise<void> {
  const html = await safeContent(page);
  if (!hasFailurePattern(html, tracker.login.failurePatterns ?? [])) return;

  // Mode cookie uniquement : on ne soumet JAMAIS le formulaire (sinon, sur des sites
  // comme MyAnonamouse, chaque tentative cree une session et finit par bloquer le compte).
  // Le cookie injecte ne suffit pas (page de login detectee) -> on ECHOUE TOUT DE SUITE
  // avec un message clair + un dump pour diagnostic, au lieu de poursuivre.
  if (tracker.login.cookieOnly) {
    const currentUrl = page.url();
    const dump = writeBrowserDump(tracker, currentUrl, html, 'cookieonly');
    const suffix = dump ? ` - dump: ${dump}` : '';
    if (looksAntiBot(html)) {
      throw new Error(`Session non authentifiee : challenge anti-bot/Cloudflare affiche malgre le cookie (il manque sans doute un cookie cf_clearance, ou l'IP de sortie differe de celle qui a cree la session)${suffix}`);
    }
    const matched = tracker.login.failurePatterns.find(p => html.includes(p));
    throw new Error(`Session non authentifiee : page de login detectee (motif "${matched ?? '?'}") malgre le cookie injecte. Causes frequentes : session liee a l'IP (sortir par la meme IP via proxy/SSH), cookie incomplet, ou expire${suffix}`);
  }

  const loginUrl = resolveUrl(tracker.baseUrl, tracker.login.url);
  // 'commit' = on attend juste les headers HTTP, puis les waits explicites ci-dessous
  // s'occupent du DOM (plus robuste pour les sites lourds en JS / proxy lent)
  await page.goto(loginUrl, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await waitForAnubis(page);
  await waitForLiveView(page);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.locator('input').first().waitFor({ timeout: 10_000 }).catch(() => {});

  for (const [name, template] of Object.entries(tracker.login.body)) {
    const value = interpolate(template, {
      username: credentials.username,
      password: credentials.password,
    });
    const candidates = [
      `[name="${name}"]`,
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="identifier"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="username"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="login"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="email"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[type="email"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[type="text"]' : '',
      name.toLowerCase().includes('password') ? '#private-key-input' : '',
      name.toLowerCase().includes('password') ? 'input[type="password"]' : '',
    ].filter(Boolean);

    for (const selector of candidates) {
      const input = page.locator(selector);
      if (await input.count() === 0) continue;
      const target = input.first();
      const type = ((await target.getAttribute('type')) ?? 'text').toLowerCase();
      if (type === 'hidden') continue;
      if (type === 'checkbox') {
        if (value === 'true' || value === 'on' || value === '1') {
          // Une checkbox de login (ex: "remember me") est souvent stylisee/masquee par
          // du CSS : le clic natif echoue. On ne doit JAMAIS bloquer le login pour ca.
          await target.check({ timeout: 2500 }).catch(async () => {
            // Fallback : cocher directement via le DOM, meme si l'element est invisible.
            await target.evaluate(el => {
              if (el instanceof HTMLInputElement) {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }).catch(() => { /* non bloquant */ });
          });
        }
        break;
      }
      await target.fill(value, { timeout: 5000 });
      break;
    }
  }

  // 2FA : si un secret TOTP est enregistre, on remplit le champ du code avant submit.
  const totpSecret = overrides ? (overrides.totpSecret ?? '') : getTrackerTotpSecret(tracker.id);
  if (totpSecret) {
    const code = generateTotp(totpSecret);
    if (code) {
      const otpCandidates = [
        tracker.login.otpField ? `[name="${tracker.login.otpField}"]` : '',
        'input[name="two_step_code"]', // UNIT3D
        'input[name="code"]',
        'input[name="otp"]',
        'input[name="totp"]',
        'input[name="mfa"]',
        'input[name="token"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
      ].filter(Boolean);
      for (const selector of otpCandidates) {
        const input = page.locator(selector);
        if (await input.count() === 0) continue;
        const target = input.first();
        const type = ((await target.getAttribute('type')) ?? 'text').toLowerCase();
        if (type === 'hidden') continue;
        if (!(await target.isVisible().catch(() => false))) continue;
        await target.fill(code, { timeout: 5000 }).catch(() => {});
        break;
      }
    }
  }

  await waitForLiveView(page);
  await waitForTurnstile(page);
  if (['kufirc', 'happyfappy', 'empornium'].includes(tracker.id)) {
    await page.waitForFunction(
      () => {
        const cinfo = document.querySelector<HTMLInputElement>('#cinfo, input[name="cinfo"]');
        return !cinfo || (cinfo.value.length > 0 && cinfo.value !== 'auth');
      },
      null,
      { timeout: 5_000 },
    ).catch(() => {});
  }
  await page.waitForTimeout(250);

  const loginFieldNames = Object.keys(tracker.login.body).map(name => name.toLowerCase());
  const invalidFields = await page.locator('input:invalid').evaluateAll((inputs, expectedNames) => inputs
    .filter(input => {
      const el = input as HTMLInputElement;
      const style = window.getComputedStyle(el);
      const visible = style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        el.getClientRects().length > 0;
      const fieldName = (el.name || el.id || el.type || '').toLowerCase();
      return visible && !el.disabled && expectedNames.includes(fieldName);
    })
    .map(input => {
      const el = input as HTMLInputElement;
      return el.name || el.id || el.type || 'input';
    }), loginFieldNames).catch(() => []);
  if (invalidFields.length > 0) {
    throw new Error(`Formulaire login invalide (${invalidFields.join(', ')}) - verifier le format des identifiants`);
  }

  const submit = page.locator('form button[type="submit"]:visible, form input[type="submit"]:visible, button[type="submit"]:visible, input[type="submit"]:visible');
  if (await submit.count() > 0) {
    const button = submit.first();
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      element => !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.disabled,
      await button.elementHandle(),
      { timeout: 10_000 },
    ).catch(() => {});
    await button.click({ timeout: 10_000 });
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  const leftLogin = await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!leftLogin && isLoginPath(new URL(page.url()).pathname)) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 15_000 }).catch(() => {});
  }
  if (isLoginPath(new URL(page.url()).pathname)) {
    await page.locator('form').first().evaluate(form => {
      if (form instanceof HTMLFormElement) form.requestSubmit();
    }).catch(() => {});
    await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 15_000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await waitForAnubis(page);
  await waitForLiveView(page);

  // ── 2FA en deux etapes : page de challenge apres le mot de passe ────────────
  if (totpSecret) {
    const postHtml = await safeContent(page);
    const onTwoFa = /two-factor-challenge/i.test(page.url()) ||
      /two-factor-challenge/i.test(postHtml) ||
      /Two[\s-]?Factor Authentication/i.test(postHtml) ||
      /One Time Password/i.test(postHtml) ||
      (/name=["']code["']/i.test(postHtml) && /recovery_code/i.test(postHtml));
    if (onTwoFa) {
      const code = generateTotp(totpSecret);
      if (code) {
        for (const s of ['input[name="code"]', 'input[name="two_step_code"]', 'input[name="otp"]', 'input[name="totp"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[type="tel"]', '#code']) {
          const inp = page.locator(s);
          if (await inp.count() === 0) continue;
          const t = inp.first();
          if (!(await t.isVisible().catch(() => false))) continue;
          await t.fill(code, { timeout: 5000 }).catch(() => {});
          break;
        }
        const genericOtp = page.locator('form input:visible:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([name="username"]):not([name="email"])');
        if (await genericOtp.count() === 1) {
          const current = await genericOtp.first().inputValue().catch(() => '');
          if (!current) await genericOtp.first().fill(code, { timeout: 5000 }).catch(() => {});
        }
        const submit2 = page.locator('form button[type="submit"]:visible, button[type="submit"]:visible, input[type="submit"]:visible');
        if (await submit2.count() > 0) await submit2.first().click({ timeout: 10_000 }).catch(() => {});
        else await page.keyboard.press('Enter').catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await waitForLiveView(page);
      }
    }
  }
}

export async function fetchWithBrowser(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
  overrides?: BrowserFetchOverrides,
): Promise<{ html: string; url: string; authConfirmed: boolean; extraHtml?: string }> {
  const context = await getContext(tracker, overrides);
  const page = await context.newPage();
  const url = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, {
    username: credentials.username,
    password: credentials.password,
  }));

  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await waitForAnubis(page);
    await waitForAntiBotChallenge(page);
    await waitForLiveView(page);
    await ensureLoggedIn(tracker, credentials, page, overrides);
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await waitForAnubis(page);
    await waitForAntiBotChallenge(page);
    await waitForLiveView(page);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    if (tracker.id === 'nostradamus') {
      // Activity est rendu cote client via Phoenix LiveView - on attend que
      // l'ecran "Chargement de l'activite..." disparaisse avant de lire le HTML
      await page.waitForFunction(
        () => !document.getElementById('activity-loading-state'),
        null,
        { timeout: 30_000 },
      ).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
    if (tracker.id === 'c411') {
      await page.getByText(/Envoy|Ratio|T[ée]l[ée]charg/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
    }
    if (tracker.id === 'milkie') {
      await revealMilkieStats(page);
    }
    const authConfirmed = await waitForTrackerContent(tracker, page);
    const html = await safeContent(page);
    const primaryUrl = page.url();

    let extraHtml: string | undefined;
    const ef = tracker.fetch.extraFetch;
    if (ef) {
      try {
        const vars: Record<string, string> = { username: credentials.username };
        if (ef.idExtract) {
          const idMatch = new RegExp(ef.idExtract.regex, 's').exec(html);
          const id = idMatch?.groups?.['value'];
          if (id) vars.id = id;
        }
        if (!ef.idExtract || vars.id) {
          const extraUrl = resolveUrl(tracker.baseUrl, interpolate(ef.url, vars));
          await page.goto(extraUrl, { waitUntil: 'commit', timeout: 45_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          // Une navigation Playwright vers du JSON enveloppe la réponse dans une page
          // HTML (<pre>...</pre>). Conserver le texte brut pour permettre l'extraction
          // par chemin JSON ; garder le DOM rendu pour les extraFetch HTML/SPA.
          const responseType = ef.responseType ?? (ef.path ? 'json' : 'html');
          extraHtml = responseType === 'json'
            ? await page.locator('body').innerText()
            : await safeContent(page);
        }
      } catch {
        // Best-effort : la page secondaire (ex. classe de membre) ne doit jamais
        // invalider le fetch principal, deja capture dans `html`.
      }
    }

    return { html, url: primaryUrl, authConfirmed, extraHtml };
  } finally {
    await page.close().catch(() => {});
    // Fermer le contexte (= le process Chromium) apres chaque fetch. Sinon, avec
    // beaucoup de trackers en mode navigateur, les contextes s'accumulent en memoire
    // (1 Chromium par tracker) et l'app rame. Le profil persiste sur disque (cookies
    // conserves), on le relance juste au prochain cycle. Max simultane = REFRESH_CONCURRENCY.
    await closeBrowserSession(tracker.id).catch(() => {});
  }
}

/**
 * Recupere le HTML brut d'une URL via un navigateur EPHEMERE (contexte non
 * persistant, sans profil ni cookies), pour la detection de moteur quand le GET
 * HTTP echoue (Cloudflare/JS). Aucun login, aucune session : usage strictement
 * lecture-seule d'une page publique (ex: page de login). Best-effort : renvoie '' en cas d'echec.
 */
export async function fetchRawHtmlWithBrowser(url: string, trackerId = '__detect__', overrides?: BrowserFetchOverrides): Promise<string> {
  const contextOptions = {
    userAgent: selectUserAgent(),
    viewport: { width: 1365, height: 900 },
    locale: 'fr-FR',
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true, proxy: playwrightProxy(trackerId, overrides) });
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await waitForAnubis(page).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    return await safeContent(page);
  } catch {
    return '';
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function closeBrowserSessions(): Promise<void> {
  await Promise.all([...contexts.values()].map(context => context.close().catch(() => {})));
  contexts.clear();
}

export async function closeBrowserSession(trackerId: string): Promise<void> {
  const context = contexts.get(trackerId);
  if (!context) return;
  contexts.delete(trackerId);
  await context.close().catch(() => {});
}

/**
 * Reset complet du profil navigateur d'un tracker : ferme le contexte en memoire
 * PUIS supprime le profil persistant sur disque (cookies, localStorage, cache).
 * Le prochain fetch repartira d'une session navigateur vierge.
 */
export async function resetBrowserProfile(trackerId: string): Promise<void> {
  await closeBrowserSession(trackerId).catch(() => {});
  const dir = path.join(PROFILE_DIR, trackerId);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}
