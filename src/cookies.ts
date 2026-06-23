// Parsing des cookies de session fournis par l'utilisateur — module SANS Playwright.
// Extrait de browserFetcher pour que l'app principale (chemin HTTP / fast-path
// curl-impersonate) n'ait aucune dependance statique vers Playwright : l'image
// principale peut ainsi etre allegee (navigateur externalise) tout en continuant
// a rejouer les cookies pour les trackers HTTP.

import { getTrackerCookie } from './db.js';

// Cookie minimal : on garde juste name+value (+ flags), et on injecte via `url`
// (Playwright derive domaine/chemin) -> bien plus robuste que domain/path manuels.
export interface ParsedCookie {
  name: string;
  value: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

const COOKIE_NAME_RE = /^[^\s=;,]+$/; // un nom de cookie valide ne contient ni espace, ni = ; ,
const COOKIE_ATTRIBUTE_NAMES = new Set([
  'domain',
  'path',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
  'priority',
  'partitioned',
]);

function cookieFromRecord(c: Record<string, unknown>): ParsedCookie | null {
  if (typeof c.name !== 'string' || !COOKIE_NAME_RE.test(c.name)) return null;
  const cookie: ParsedCookie = {
    name: c.name,
    value: String(c.value ?? ''),
    secure: c.secure === true || String(c.secure).toLowerCase() === 'true',
    httpOnly: c.httpOnly === true || c.http_only === true || String(c.httpOnly ?? c.http_only).toLowerCase() === 'true',
  };
  const exp = Number(c.expirationDate ?? c.expires ?? c.expiry ?? c.expiration);
  if (Number.isFinite(exp) && exp > 0) cookie.expires = Math.floor(exp);
  return cookie;
}

function parseJsonCookies(parsed: unknown): ParsedCookie[] {
  if (Array.isArray(parsed)) {
    return parsed
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
      .map(cookieFromRecord)
      .filter((c): c is ParsedCookie => Boolean(c));
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  // Cookie-Editor variants and Playwright storageState both commonly wrap cookies.
  for (const key of ['cookies', 'cookieStore', 'cookie_store']) {
    const nested = obj[key];
    if (Array.isArray(nested)) return parseJsonCookies(nested);
  }

  const single = cookieFromRecord(obj);
  if (single) return [single];

  // Last-resort map export: { "session": "abc", "remember": "..." }
  return Object.entries(obj)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map(([name, value]) => ({ name, value: String(value) }))
    .filter(c => COOKIE_NAME_RE.test(c.name));
}

/**
 * Format Netscape (cookies.txt) : 7 champs
 * domain  includeSubdomains  path  secure  expiry  name  value
 * Separes par TAB normalement ; on tolere aussi les espaces multiples au cas ou
 * le copier-coller aurait converti les tabulations.
 */
function parseNetscapeCookies(raw: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let l = line.trim();
    if (!l) continue;
    let httpOnly = false;
    if (l.startsWith('#HttpOnly_')) { httpOnly = true; l = l.slice('#HttpOnly_'.length); }
    else if (l.startsWith('#')) continue;
    let p = l.split('\t');
    if (p.length < 7) p = l.split(/\s+/); // tolerance : tabs convertis en espaces
    if (p.length < 7) continue;
    const name = p[5];
    const value = p.slice(6).join(' ');
    if (!name || !COOKIE_NAME_RE.test(name)) continue;
    const cookie: ParsedCookie = {
      name,
      value,
      secure: String(p[3]).toUpperCase() === 'TRUE',
      httpOnly,
    };
    const exp = Number(p[4]);
    if (Number.isFinite(exp) && exp > 0) cookie.expires = exp;
    out.push(cookie);
  }
  return out;
}

function parseDevtoolsTable(raw: string): ParsedCookie[] {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(/\t+/).map(h => h.trim().toLowerCase());
  const nameIndex = headers.indexOf('name');
  const valueIndex = headers.indexOf('value');
  if (nameIndex < 0 || valueIndex < 0) return [];
  const secureIndex = headers.indexOf('secure');
  const httpOnlyIndex = headers.findIndex(h => h === 'httponly' || h === 'http only');
  const expiresIndex = headers.findIndex(h => h.includes('expires'));

  return lines.slice(1)
    .map(line => line.split(/\t+/))
    .map(parts => {
      const name = parts[nameIndex]?.trim();
      if (!name || !COOKIE_NAME_RE.test(name)) return null;
      const cookie: ParsedCookie = {
        name,
        value: parts[valueIndex] ?? '',
      };
      if (secureIndex >= 0) cookie.secure = /^(true|yes|✓|1)$/i.test(parts[secureIndex] ?? '');
      if (httpOnlyIndex >= 0) cookie.httpOnly = /^(true|yes|✓|1)$/i.test(parts[httpOnlyIndex] ?? '');
      if (expiresIndex >= 0) {
        const exp = Date.parse(parts[expiresIndex] ?? '');
        if (Number.isFinite(exp)) cookie.expires = Math.floor(exp / 1000);
      }
      return cookie;
    })
    .filter((c): c is ParsedCookie => Boolean(c));
}

function parseCookieHeader(raw: string): ParsedCookie[] {
  const normalized = raw
    .trim()
    .replace(/^cookies?\s*:\s*/i, '');
  return normalized
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
      const value = eq >= 0 ? part.slice(eq + 1).trim() : '';
      return { name, value };
    })
    .filter(c => COOKIE_NAME_RE.test(c.name) && !COOKIE_ATTRIBUTE_NAMES.has(c.name.toLowerCase()));
}

function parseSetCookieLines(raw: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim().replace(/^set-cookie\s*:\s*/i, '');
    if (!line) continue;
    const first = line.split(';', 1)[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    if (!COOKIE_NAME_RE.test(name)) continue;
    const attrs = line.split(';').slice(1).map(attr => attr.trim());
    const cookie: ParsedCookie = {
      name,
      value: first.slice(eq + 1).trim(),
      secure: attrs.some(attr => attr.toLowerCase() === 'secure'),
      httpOnly: attrs.some(attr => attr.toLowerCase() === 'httponly'),
    };
    const expiresAttr = attrs.find(attr => attr.toLowerCase().startsWith('expires='));
    if (expiresAttr) {
      const exp = Date.parse(expiresAttr.slice('expires='.length));
      if (Number.isFinite(exp)) cookie.expires = Math.floor(exp / 1000);
    }
    out.push(cookie);
  }
  return out;
}

/**
 * Convertit le cookie fourni par l'utilisateur. Trois formats acceptes :
 *  - export JSON (Cookie-Editor : name/value/secure/httpOnly/expirationDate)
 *  - fichier Netscape cookies.txt
 *  - chaine d'en-tete "name=value; name2=value2"
 */
export function parseCookies(raw: string): ParsedCookie[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return parseJsonCookies(JSON.parse(trimmed));
    } catch {
      // pas du JSON valide -> autres formats
    }
  }

  const devtools = parseDevtoolsTable(trimmed);
  if (devtools.length > 0) return devtools;

  if (trimmed.includes('\t') || /\n/.test(trimmed)) {
    const netscape = parseNetscapeCookies(trimmed);
    if (netscape.length > 0) return netscape;
    const setCookie = parseSetCookieLines(trimmed);
    if (setCookie.length > 0) return setCookie;
  }

  if (/^set-cookie\s*:/i.test(trimmed)) {
    const setCookie = parseSetCookieLines(trimmed);
    if (setCookie.length > 0) return setCookie;
  }

  // En-tete "Cookie: name=value; name2=value2" ou "name=value; name2=value2"
  return parseCookieHeader(trimmed);
}

/**
 * Construit l'en-tete "Cookie: name=value; ..." a partir du cookie stocke pour ce
 * tracker (tous formats supportes). Vide si aucun cookie. Utilise par le fast-path
 * curl-impersonate pour rejouer la session sans lancer de navigateur.
 */
export function buildCookieHeader(trackerId: string): string {
  const raw = getTrackerCookie(trackerId);
  if (!raw) return '';
  return parseCookies(raw)
    .filter(c => c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}
