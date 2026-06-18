import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { type Credentials, type TrackerConfig, type TrackerStats } from './types.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const CONFIG_DIR = path.join(process.cwd(), 'config');
const DEFAULT_TRACKERS_DIR = path.join(process.cwd(), 'default-trackers');
const DB_PATH = path.join(CONFIG_DIR, 'tracker-dashboard.sqlite');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

export interface TrackerSchedule {
  trackerId: string;
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface TrackerCredentialSummary {
  trackerId: string;
  username: string;
  hasPassword: boolean;
  updatedAt: string | null;
}

export interface TrackerDefinitionSummary {
  id: string;
  name: string;
  baseUrl: string;
  file: string;
  enabled: boolean;
}

export interface StatSnapshotSummary {
  trackerId: string;
  trackerName: string;
  status: string;
  error: string | null;
  fields: Record<string, string | number>;
  capturedAt: string;
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
  }
  return db;
}

function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracker_credentials (
      tracker_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracker_configs (
      tracker_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracker_schedule (
      tracker_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      next_run_at TEXT,
      last_run_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stat_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id TEXT NOT NULL,
      tracker_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      fields_json TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stat_snapshots_tracker_time
      ON stat_snapshots (tracker_id, captured_at);
  `);
}

export function getJsonSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row?.value) return fallback;
  try {
    const parsed = JSON.parse(String(row.value));
    // Si fallback est un array : on renvoie parsed tel quel (un spread sur array
    // donne {0:..., 1:...} et casse Array.isArray cote appelant)
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? (parsed as T) : fallback;
    // Si fallback est un objet plain : on merge (preserve les cles par defaut)
    if (fallback && typeof fallback === 'object') return { ...(fallback as object), ...parsed } as T;
    // Sinon (primitif) : on renvoie parsed
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  getDb()
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, JSON.stringify(value));
}

// ─── Cookies de session manuels (pour sites a CAPTCHA / Cloudflare Turnstile) ──
// On stocke la chaine de cookie brute fournie par l'utilisateur, par tracker.
type TrackerCookieMap = Record<string, string>;

export function getTrackerCookie(trackerId: string): string {
  const all = getJsonSetting('tracker_cookies', {} as TrackerCookieMap);
  return all && typeof all[trackerId] === 'string' ? all[trackerId] : '';
}

export function hasTrackerCookie(trackerId: string): boolean {
  return getTrackerCookie(trackerId).trim().length > 0;
}

export function setTrackerCookie(trackerId: string, cookie: string): void {
  const all = getJsonSetting('tracker_cookies', {} as TrackerCookieMap);
  const value = (cookie ?? '').trim();
  if (value) all[trackerId] = value;
  else delete all[trackerId];
  setJsonSetting('tracker_cookies', all);
}

// ─── Secrets TOTP (2FA) par tracker ───────────────────────────────────────────
// On stocke le secret base32 (type Google Authenticator) fourni par l'utilisateur.
type TrackerTotpMap = Record<string, string>;

export function getTrackerTotpSecret(trackerId: string): string {
  const all = getJsonSetting('tracker_totp', {} as TrackerTotpMap);
  return all && typeof all[trackerId] === 'string' ? all[trackerId] : '';
}

export function hasTrackerTotpSecret(trackerId: string): boolean {
  return getTrackerTotpSecret(trackerId).trim().length > 0;
}

export function setTrackerTotpSecret(trackerId: string, secret: string): void {
  const all = getJsonSetting('tracker_totp', {} as TrackerTotpMap);
  const value = (secret ?? '').replace(/\s+/g, '').trim();
  if (value) all[trackerId] = value;
  else delete all[trackerId];
  setJsonSetting('tracker_totp', all);
}

export function importLegacySettingsIfNeeded(): void {
  const existing = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('proxy');
  if (existing || !fs.existsSync(path.join(CONFIG_DIR, 'settings.json'))) return;

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf-8'));
    if (raw.proxy) setJsonSetting('proxy', raw.proxy);
  } catch {
    // Ignore legacy config parsing errors; defaults will be used.
  }
}

export function importLegacyCredentialsIfNeeded(): void {
  const existing = getDb()
    .prepare('SELECT tracker_id FROM tracker_credentials LIMIT 1')
    .get();
  if (existing || !fs.existsSync(CREDENTIALS_PATH)) return;

  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8')) as Credentials;
    for (const [trackerId, creds] of Object.entries(credentials)) {
      saveTrackerCredentials(trackerId, creds.username, creds.password);
    }
  } catch {
    // Keep startup tolerant; missing credentials are reported per tracker later.
  }
}

export function importLegacyTrackersIfNeeded(): void {
  const existing = getDb()
    .prepare('SELECT tracker_id FROM tracker_configs LIMIT 1')
    .get();
  const trackersDir = path.join(CONFIG_DIR, 'trackers');
  if (existing) {
    syncDefaultTrackerDefinitions();
    return;
  }
  if (!fs.existsSync(trackersDir)) {
    syncDefaultTrackerDefinitions();
    return;
  }

  const existingIds = new Set(
    getDb()
      .prepare('SELECT tracker_id FROM tracker_configs')
      .all()
      .map(row => String(row.tracker_id)),
  );

  const files = fs.readdirSync(trackersDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.example.json'));
  for (const file of files) {
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(trackersDir, file), 'utf-8'),
      ) as TrackerConfig;
      if (existingIds.has(config.id)) continue;
      saveTrackerConfig(config);
    } catch {
      // Invalid tracker files are still reported by the old loader during local debugging.
    }
  }
  syncDefaultTrackerDefinitions();
}

export function syncDefaultTrackerDefinitions(): void {
  if (!fs.existsSync(DEFAULT_TRACKERS_DIR)) return;
  const trackersDir = path.join(CONFIG_DIR, 'trackers');
  fs.mkdirSync(trackersDir, { recursive: true });

  const files = fs.readdirSync(DEFAULT_TRACKERS_DIR)
    .filter(file => file.endsWith('.json') && !file.endsWith('.example.json'));
  for (const file of files) {
    const target = path.join(trackersDir, file);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(DEFAULT_TRACKERS_DIR, file), target);
  }
}

export function listTrackerDefinitionFiles(): TrackerDefinitionSummary[] {
  syncDefaultTrackerDefinitions();
  const trackersDir = path.join(CONFIG_DIR, 'trackers');
  if (!fs.existsSync(trackersDir)) return [];

  return fs.readdirSync(trackersDir)
    .filter(file => file.endsWith('.json') && !file.endsWith('.example.json'))
    .map(file => {
      try {
        const config = JSON.parse(
          fs.readFileSync(path.join(trackersDir, file), 'utf-8'),
        ) as TrackerConfig;
        return {
          id: config.id,
          name: config.name,
          baseUrl: config.baseUrl,
          file,
          enabled: config.enabled !== false,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is TrackerDefinitionSummary => Boolean(item?.id));
}

export function loadTrackerDefinitionFile(trackerId: string): TrackerConfig | null {
  syncDefaultTrackerDefinitions();
  const trackersDir = path.join(CONFIG_DIR, 'trackers');
  if (!fs.existsSync(trackersDir)) return null;

  const files = fs.readdirSync(trackersDir)
    .filter(file => file.endsWith('.json') && !file.endsWith('.example.json'));
  for (const file of files) {
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(trackersDir, file), 'utf-8'),
      ) as TrackerConfig;
      if (config.id === trackerId) return config;
    } catch {
      // Ignore invalid definition files.
    }
  }
  return null;
}

// Lit la definition par defaut EMBARQUEE DANS L'IMAGE (default-trackers/), donc toujours
// a jour avec la version deployee — contrairement a loadTrackerDefinitionFile qui lit la
// copie sur le volume (config/trackers/), jamais rafraichie une fois ecrite. A utiliser
// pour les trackers embarques dont la definition fait autorite cote application.
export function loadDefaultTrackerDefinition(trackerId: string): TrackerConfig | null {
  if (!fs.existsSync(DEFAULT_TRACKERS_DIR)) return null;
  const target = path.join(DEFAULT_TRACKERS_DIR, `${trackerId}.json`);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf-8')) as TrackerConfig;
  } catch {
    return null;
  }
}

export function loadTrackerConfigsFromDb(): TrackerConfig[] {
  return getDb()
    .prepare('SELECT config_json FROM tracker_configs ORDER BY name')
    .all()
    .map(row => JSON.parse(String(row.config_json)) as TrackerConfig);
}

export function saveTrackerConfig(config: TrackerConfig): void {
  getDb()
    .prepare(`
      INSERT INTO tracker_configs (tracker_id, name, enabled, config_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tracker_id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(
      config.id,
      config.name,
      config.enabled === false ? 0 : 1,
      JSON.stringify(config, null, 2),
    );
}

export function loadCredentialsFromDb(): Credentials {
  const rows = getDb()
    .prepare('SELECT tracker_id, username, password FROM tracker_credentials')
    .all();
  const credentials: Credentials = {};
  for (const row of rows) {
    credentials[String(row.tracker_id)] = {
      username: String(row.username),
      password: String(row.password),
    };
  }
  return credentials;
}

export function listTrackerCredentialSummaries(): TrackerCredentialSummary[] {
  return getDb()
    .prepare(`
      SELECT tracker_id, username, password, updated_at
      FROM tracker_credentials
      ORDER BY tracker_id
    `)
    .all()
    .map(row => ({
      trackerId: String(row.tracker_id),
      username: String(row.username),
      hasPassword: Boolean(row.password),
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    }));
}

export function getTrackerCredentials(
  trackerId: string,
): { username: string; password: string } | null {
  const row = getDb()
    .prepare('SELECT username, password FROM tracker_credentials WHERE tracker_id = ?')
    .get(trackerId);
  if (!row) return null;
  return {
    username: String(row.username),
    password: String(row.password),
  };
}

export function saveTrackerCredentials(
  trackerId: string,
  username: string,
  password: string,
): void {
  getDb()
    .prepare(`
      INSERT INTO tracker_credentials (tracker_id, username, password, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tracker_id) DO UPDATE SET
        username = excluded.username,
        password = excluded.password,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(trackerId, username, password);
}

export function deleteTrackerCredentials(trackerId: string): void {
  getDb()
    .prepare('DELETE FROM tracker_credentials WHERE tracker_id = ?')
    .run(trackerId);
}

/**
 * Supprime entierement un tracker custom : config, identifiants, planning et
 * historique de snapshots. Cookie/TOTP (stockes dans la table settings sous forme
 * de map JSON) sont nettoyes par l'appelant via setTrackerCookie/setTrackerTotpSecret.
 * A reserver aux trackers ajoutes par l'utilisateur (absents de default-trackers/),
 * car syncDefaultTrackerDefinitions() reseederait un tracker embarque au prochain boot.
 */
export function deleteTrackerConfig(trackerId: string): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM tracker_configs WHERE tracker_id = ?').run(trackerId);
    db.prepare('DELETE FROM tracker_credentials WHERE tracker_id = ?').run(trackerId);
    db.prepare('DELETE FROM tracker_schedule WHERE tracker_id = ?').run(trackerId);
    db.prepare('DELETE FROM stat_snapshots WHERE tracker_id = ?').run(trackerId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** True si une definition embarquee (default-trackers/) existe pour cet id. */
export function isDefaultTracker(trackerId: string): boolean {
  if (!fs.existsSync(DEFAULT_TRACKERS_DIR)) return false;
  return fs.existsSync(path.join(DEFAULT_TRACKERS_DIR, `${trackerId}.json`));
}

export function ensureTrackerSchedules(trackers: TrackerConfig[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO tracker_schedule (tracker_id, enabled, interval_hours, next_run_at)
    VALUES (?, 0, 24, NULL)
    ON CONFLICT(tracker_id) DO NOTHING
  `);
  for (const tracker of trackers) stmt.run(tracker.id);
}

export function listTrackerSchedules(): TrackerSchedule[] {
  return getDb()
    .prepare(`
      SELECT tracker_id, enabled, interval_hours, next_run_at, last_run_at
      FROM tracker_schedule
      ORDER BY tracker_id
    `)
    .all()
    .map(row => ({
      trackerId: String(row.tracker_id),
      enabled: Boolean(row.enabled),
      intervalHours: Number(row.interval_hours),
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    }));
}

export function getTrackerSchedule(trackerId: string): TrackerSchedule | null {
  const row = getDb()
    .prepare(`
      SELECT tracker_id, enabled, interval_hours, next_run_at, last_run_at
      FROM tracker_schedule
      WHERE tracker_id = ?
    `)
    .get(trackerId);
  if (!row) return null;
  return {
    trackerId: String(row.tracker_id),
    enabled: Boolean(row.enabled),
    intervalHours: Number(row.interval_hours),
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
  };
}

export function saveTrackerSchedule(
  trackerId: string,
  enabled: boolean,
  intervalHours: number,
  nextRunAt: string | null,
): void {
  getDb()
    .prepare(`
      INSERT INTO tracker_schedule (tracker_id, enabled, interval_hours, next_run_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tracker_id) DO UPDATE SET
        enabled = excluded.enabled,
        interval_hours = excluded.interval_hours,
        next_run_at = excluded.next_run_at,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(trackerId, enabled ? 1 : 0, intervalHours, nextRunAt);
}

export function markTrackerScheduleRun(trackerId: string, nextRunAt: string): void {
  getDb()
    .prepare(`
      UPDATE tracker_schedule
      SET last_run_at = CURRENT_TIMESTAMP,
          next_run_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE tracker_id = ?
    `)
    .run(nextRunAt, trackerId);
}

export function saveStatSnapshots(stats: TrackerStats[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO stat_snapshots (
      tracker_id,
      tracker_name,
      status,
      error,
      fields_json,
      captured_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const stat of stats) {
    stmt.run(
      stat.id,
      stat.name,
      stat.status,
      stat.error ?? null,
      JSON.stringify(stat.fields),
      stat.lastUpdated,
    );
  }
}

export function getLatestOkStatSnapshot(tracker: TrackerConfig): TrackerStats | null {
  const row = getDb()
    .prepare(`
      SELECT tracker_name, fields_json, captured_at
      FROM stat_snapshots
      WHERE tracker_id = ? AND status = 'ok'
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `)
    .get(tracker.id);
  if (!row) return null;
  try {
    const fields = JSON.parse(String(row.fields_json)) as Record<string, string | number>;
    return {
      id: tracker.id,
      name: String(row.tracker_name || tracker.name),
      trackerUrl: tracker.baseUrl,
      status: 'ok',
      lastUpdated: String(row.captured_at),
      byteUnit: tracker.dashboard?.byteUnit ?? 'binary',
      fields,
    };
  } catch {
    return null;
  }
}

export function listStatSnapshots(trackerId: string | null, limit = 500): StatSnapshotSummary[] {
  const max = Math.max(1, Math.min(Math.floor(limit), 5000));
  const rows = trackerId
    ? getDb()
        .prepare(`
          SELECT tracker_id, tracker_name, status, error, fields_json, captured_at
          FROM stat_snapshots
          WHERE tracker_id = ?
          ORDER BY captured_at DESC, id DESC
          LIMIT ?
        `)
        .all(trackerId, max)
    : getDb()
        .prepare(`
          SELECT tracker_id, tracker_name, status, error, fields_json, captured_at
          FROM stat_snapshots
          ORDER BY captured_at DESC, id DESC
          LIMIT ?
        `)
        .all(max);

  return rows
    .map(row => {
      try {
        return {
          trackerId: String(row.tracker_id),
          trackerName: String(row.tracker_name),
          status: String(row.status),
          error: row.error === null || row.error === undefined ? null : String(row.error),
          fields: JSON.parse(String(row.fields_json)) as Record<string, string | number>,
          capturedAt: String(row.captured_at),
        };
      } catch {
        return null;
      }
    })
    .filter((row): row is StatSnapshotSummary => row !== null)
    .reverse();
}
