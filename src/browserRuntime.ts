// Runtime navigateur externe `tracker-dashboard-browser`.
//
// Service HTTP interne, sans acces a la base : il recoit de l'app principale tout
// ce qu'il faut (tracker, credentials, cookie, TOTP, moteur, proxy resolu) et
// execute l'action navigateur via Playwright/CloakBrowser, en reutilisant la
// logique de browserFetcher. Les profils persistants sont partages via le volume
// ./config (config/browser-profile), comme l'app principale.
//
// Demarrage : node --experimental-sqlite dist/browserRuntime.js
// (le flag est requis uniquement parce que browserFetcher importe db.js ; aucune
// fonction DB n'est jamais appelee ici — tout passe par les overrides du payload.)

import express from 'express';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { chromium } from 'playwright';
import {
  fetchWithBrowser,
  fetchRawHtmlWithBrowser,
  resetBrowserProfile,
  closeBrowserSession,
  closeBrowserSessions,
  type BrowserFetchOverrides,
} from './browserFetcher.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.BROWSER_RUNTIME_PORT || 3001);
const TOKEN = process.env.BROWSER_RUNTIME_TOKEN || '';

function playwrightVersion(): string | undefined {
  try {
    return require('playwright/package.json').version;
  } catch {
    return undefined;
  }
}

async function chromiumVersion(executable: string): Promise<string | undefined> {
  if (!executable) return undefined;
  return new Promise(resolve => {
    execFile(executable, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const match = /[\d.]+/.exec(String(stdout));
      resolve(match ? match[0] : undefined);
    });
  });
}

async function cloakbrowserInfo(): Promise<{ available: boolean; version?: string }> {
  try {
    const spec = 'cloakbrowser'; // specifier non litteral -> non resolu a la compilation
    await import(spec);
    let version: string | undefined;
    try { version = require('cloakbrowser/package.json').version; } catch { /* version best-effort */ }
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Auth optionnelle par token partage (si le service est expose par erreur).
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (TOKEN && req.get('X-Browser-Runtime-Token') !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'token invalide' });
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/version', async (_req, res) => {
  const executable = (() => { try { return chromium.executablePath(); } catch { return ''; } })();
  res.json({
    ok: true,
    runtime: 'tracker-dashboard-browser',
    revision: process.env.APP_IMAGE_REVISION || 'unknown',
    version: process.env.APP_IMAGE_VERSION || 'dev',
    ref: process.env.APP_IMAGE_REF || 'local',
    playwright: playwrightVersion(),
    chromiumExecutable: executable || undefined,
    chromiumVersion: await chromiumVersion(executable),
    cloakbrowser: await cloakbrowserInfo(),
  });
});

app.post('/fetch', async (req, res) => {
  try {
    const { tracker, credentials, overrides } = req.body ?? {};
    if (!tracker || !credentials) return res.status(400).json({ ok: false, error: 'payload incomplet (tracker/credentials requis)' });
    const result = await fetchWithBrowser(tracker, credentials, (overrides ?? {}) as BrowserFetchOverrides);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/fetch-raw', async (req, res) => {
  try {
    const { url, trackerId, proxy } = req.body ?? {};
    if (!url) return res.status(400).json({ ok: false, error: 'url requise' });
    const html = await fetchRawHtmlWithBrowser(String(url), String(trackerId || '__detect__'), { proxy: proxy ?? null });
    res.json({ ok: true, html });
  } catch (err) {
    res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/reset-profile', async (req, res) => {
  try {
    await resetBrowserProfile(String(req.body?.trackerId || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/close-session', async (req, res) => {
  await closeBrowserSession(String(req.body?.trackerId || '')).catch(() => {});
  res.json({ ok: true });
});

app.post('/close-all', async (_req, res) => {
  await closeBrowserSessions().catch(() => {});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[tracker-dashboard-browser] runtime navigateur en ecoute sur le port ${PORT}${TOKEN ? ' (token actif)' : ''}`);
});
