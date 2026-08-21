import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-dashboard-v3x-catalog-'));
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
let sqlite;

assert.match(
  serverSource,
  /const enabled = definition\.id === 'v3x' && !v3xHasStoredAuth[\s\S]*?\? false[\s\S]*?: Boolean\(configuredTracker && configuredTracker\.enabled !== false\)/,
  'L API tracker-definitions doit forcer V3X disponible tant qu aucune authentification V3X n est stockee',
);

try {
  fs.mkdirSync(path.join(temp, 'config', 'trackers'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'default-trackers'), { recursive: true });

  // Definition actuellement correcte, embarquee dans l'image.
  const bundledV3x = {
    id: 'v3x',
    name: 'V3X',
    baseUrl: 'https://v3x.club',
    enabled: false,
    login: { url: '/login', cookieOnly: true, failurePatterns: ['href="/login"'] },
    fetch: { url: '/activity', mode: 'browser', responseType: 'html', fields: {
      ratio: { regex: 'Ratio(?<value>[0-9.]+)', transform: 'number' },
    } },
    dashboard: { byteUnit: 'binary' },
  };
  fs.writeFileSync(
    path.join(temp, 'default-trackers', 'v3x.json'),
    JSON.stringify(bundledV3x),
  );

  // Reproduction exacte de l'installation cassee : une ancienne ligne SQLite
  // issue de la premiere version de V3X est restee enabled=true.
  const oldV3x = { ...bundledV3x, enabled: true };
  fs.writeFileSync(
    path.join(temp, 'config', 'trackers', 'v3x.json'),
    JSON.stringify(oldV3x),
  );

  process.chdir(temp);
  const nonce = Date.now();
  const db = await import(`${pathToFileURL(path.join(root, 'dist', 'db.js')).href}?v3x-db=${nonce}`);
  const migrations = await import(`${pathToFileURL(path.join(root, 'dist', 'catalogMigrations.js')).href}?v3x-migration=${nonce}`);

  db.saveTrackerConfig(oldV3x);
  // Simule les installations qui avaient DEJA passe l'ancienne migration generale.
  db.setJsonSetting('migration_disable_uncredentialed_default_trackers_v1', { done: true });

  migrations.migrateV3xCatalogAvailability();

  let stored = db.loadRawTrackerConfigsFromDb().find(config => config.id === 'v3x');
  assert.ok(stored, 'V3X doit rester present en base');
  assert.equal(
    stored.enabled,
    false,
    'Une ancienne ligne V3X active sans credentials doit revenir dans Ajouter un tracker',
  );
  assert.equal(
    db.getJsonSetting('migration_v3x_catalog_availability_v1', { done: false }).done,
    true,
    'La migration V3X doit etre marquee comme terminee',
  );

  // Garde de securite : si l'utilisateur a reellement configure V3X, ne jamais
  // le desactiver lors de cette migration.
  db.saveTrackerConfig({ ...stored, enabled: true });
  db.setTrackerCookie('v3x', 'session=fixture');
  db.setJsonSetting('migration_v3x_catalog_availability_v1', { done: false });
  migrations.migrateV3xCatalogAvailability();

  stored = db.loadRawTrackerConfigsFromDb().find(config => config.id === 'v3x');
  assert.equal(
    stored.enabled,
    true,
    'Un V3X configure avec un cookie doit rester actif',
  );

  sqlite = db.getDb();
  console.log('V3X catalog migration OK: stale SQLite state is repaired without disabling configured accounts.');
} finally {
  sqlite?.close();
  process.chdir(root);
  fs.rmSync(temp, { recursive: true, force: true });
}
