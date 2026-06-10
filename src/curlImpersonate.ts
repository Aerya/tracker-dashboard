import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProxyForTracker, toSshConfig } from './proxy.js';
import { getSshLocalEndpoint } from './sshTunnel.js';
import { getJsonSetting } from './db.js';

// ─── Fast-path curl-impersonate ─────────────────────────────────────────────────
// curl-impersonate usurpe l'empreinte TLS/HTTP2 d'un vrai navigateur. Pour les
// trackers en mode navigateur disposant d'un cookie de session valide et dont la
// page de stats est rendue cote serveur, on tente d'abord une simple requete HTTP
// impersonee (legere, pas de Chromium). En cas d'echec on retombe sur le navigateur.

const STATUS_MARKER = '\n__CURL_HTTP_STATUS__:';

function binaryName(override?: string): string {
  // Wrapper par defaut fourni par curl-impersonate (positionne ciphers + en-tetes).
  return override || process.env.CURL_IMPERSONATE_BIN || 'curl_chrome116';
}

/** Fast-path actif ? (reglage global, defaut: actif) */
export function fastFetchEnabled(): boolean {
  return getJsonSetting('fast_fetch', true as boolean) !== false;
}

let availablePromise: Promise<boolean> | null = null;
function checkAvailable(): Promise<boolean> {
  if (!availablePromise) {
    availablePromise = new Promise(resolve => {
      execFile(binaryName(), ['--version'], { timeout: 5000 }, err => resolve(!err));
    });
  }
  return availablePromise;
}

/** Reinitialise le cache de disponibilite (ex: apres changement d'env). */
export function resetCurlAvailability(): void {
  availablePromise = null;
}

function curlProxyArg(trackerId: string): string | null {
  const p = resolveProxyForTracker(trackerId);
  if (!p.enabled || !p.host || !p.port) return null; // direct / desactive
  if (p.type === 'ssh') {
    const ssh = toSshConfig(p);
    const ep = ssh ? getSshLocalEndpoint(ssh) : null;
    return ep ? `socks5h://${ep.host}:${ep.port}` : null; // tunnel pas pret -> pas de fast-path
  }
  const auth = p.username && p.password
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
    : '';
  // socks5h/socks4a -> resolution DNS cote proxy (comme nos agents socks)
  const scheme = p.type === 'socks5' ? 'socks5h' : p.type === 'socks4' ? 'socks4a' : p.type;
  return `${scheme}://${auth}${p.host}:${p.port}`;
}

export interface CurlGetOptions {
  cookie?: string;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * GET impersone. Renvoie { status, body } ou null si le binaire est absent /
 * l'appel a echoue (l'appelant retombe alors sur le navigateur).
 */
// Execute curl-impersonate avec une liste d'arguments deja construite (sans le
// marqueur de status ni le binaire). Renvoie { status, body } ou null si echec.
function execCurl(args: string[], timeoutMs: number): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    execFile(
      binaryName(),
      args,
      { timeout: timeoutMs + 2_000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        const out = typeof stdout === 'string' ? stdout : '';
        if (err && !out) { resolve(null); return; }
        const idx = out.lastIndexOf(STATUS_MARKER);
        if (idx === -1) { resolve({ status: 0, body: out }); return; }
        const body = out.slice(0, idx);
        const status = Number.parseInt(out.slice(idx + STATUS_MARKER.length).trim(), 10) || 0;
        resolve({ status, body });
      },
    );
  });
}

export async function curlImpersonateGet(
  trackerId: string,
  url: string,
  opts: CurlGetOptions = {},
): Promise<{ status: number; body: string } | null> {
  if (!(await checkAvailable())) return null;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const args = ['-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-w', `${STATUS_MARKER}%{http_code}`];
  if (opts.userAgent) args.push('-A', opts.userAgent);
  if (opts.cookie) args.push('-H', `Cookie: ${opts.cookie}`);
  const proxy = curlProxyArg(trackerId);
  if (proxy) args.push('--proxy', proxy);
  args.push(url);

  return execCurl(args, timeoutMs);
}

export interface CurlRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Corps brut (deja encode : form-urlencoded ou JSON selon Content-Type). */
  data?: string;
  timeoutMs?: number;
}

/**
 * Session curl-impersonate avec jar de cookies persistant entre les requetes
 * (-c/-b sur un fichier temporaire). Permet de rejouer un login complet
 * (page CSRF -> POST -> fetch) avec une empreinte TLS de vrai navigateur.
 * Appeler dispose() en fin de session pour supprimer le jar.
 */
export class CurlSession {
  private readonly trackerId: string;
  private readonly jarPath: string;
  private readonly binary?: string;

  constructor(trackerId: string, binary?: string) {
    this.trackerId = trackerId;
    this.binary = binary;
    this.jarPath = path.join(os.tmpdir(), `td-curl-${trackerId}-${process.pid}-${Date.now()}.jar`);
  }

  static async available(): Promise<boolean> {
    return checkAvailable();
  }

  async request(url: string, opts: CurlRequestOptions = {}): Promise<{ status: number; body: string } | null> {
    if (!(await checkAvailable())) return null;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const bin = binaryName(this.binary);
    const args = [
      '-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-c', this.jarPath, '-b', this.jarPath,
      '-w', `${STATUS_MARKER}%{http_code}`,
    ];
    if (opts.method === 'POST') args.push('-X', 'POST');
    for (const [k, v] of Object.entries(opts.headers ?? {})) args.push('-H', `${k}: ${v}`);
    if (opts.data != null) args.push('--data-raw', opts.data);
    const proxy = curlProxyArg(this.trackerId);
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    return new Promise(resolve => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs + 2_000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          const out = typeof stdout === 'string' ? stdout : '';
          if (err && !out) { resolve(null); return; }
          const idx = out.lastIndexOf(STATUS_MARKER);
          if (idx === -1) { resolve({ status: 0, body: out }); return; }
          const body = out.slice(0, idx);
          const status = Number.parseInt(out.slice(idx + STATUS_MARKER.length).trim(), 10) || 0;
          resolve({ status, body });
        },
      );
    });
  }

  dispose(): void {
    try { fs.unlinkSync(this.jarPath); } catch { /* deja absent */ }
  }
}
