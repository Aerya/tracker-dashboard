import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-dashboard-retired-'));
let sqlite;

try {
  fs.mkdirSync(path.join(temp, 'config', 'trackers'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'default-trackers'), { recursive: true });

  const nexum = {
    id: 'nexum',
    name: 'Nexum',
    baseUrl: 'https://nexum.invalid',
    enabled: true,
    login: { url: 'login', method: 'POST', body: {} },
    fetch: { url: 'activity', mode: 'http', responseType: 'html', fields: {} },
  };
  fs.writeFileSync(
    path.join(temp, 'config', 'trackers', 'nexum.json'),
    JSON.stringify(nexum),
  );
  const torr9 = { ...nexum, id: 'torr9', name: 'Torr9', baseUrl: 'https://torr9.invalid' };
  fs.writeFileSync(
    path.join(temp, 'config', 'trackers', 'torr9.json'),
    JSON.stringify(torr9),
  );

  process.chdir(temp);
  const db = await import(`${pathToFileURL(path.join(root, 'dist', 'db.js')).href}?retired=${Date.now()}`);
  db.saveTrackerConfig(nexum);
  db.saveTrackerConfig({ ...nexum, id: 'nexum-2', name: 'Nexum (2)', baseId: 'nexum' });
  db.saveTrackerConfig(torr9);
  db.saveTrackerCredentials('nexum', 'fixture-user', 'fixture-password');
  db.saveTrackerCredentials('nexum-2', 'fixture-user-2', 'fixture-password-2');
  db.setTrackerCookie('nexum', 'session=fixture');
  db.setTrackerTotpSecret('nexum-2', 'JBSWY3DPEHPK3PXP');
  db.setJsonSetting('trackerOrder', { ids: ['nexum', 'nexum-2', 'kept'] });
  db.setJsonSetting('proxy_overrides', [{ id: 'fixture', trackers: ['nexum', 'kept'] }]);
  db.setJsonSetting('beta_settings', {
    announceMappings: [{ announceHost: 'nexum.invalid', trackerId: 'nexum' }],
    accountAnnounceMappings: [{ key: 'fixture', trackerId: 'nexum-2' }],
    scheduleOverrides: [{ trackerId: 'nexum', enabled: true }],
    trackerAlerts: { nexum: { ratioEnabled: true }, kept: { ratioEnabled: true } },
    schedule: { lastFailedTrackerIds: ['nexum', 'kept'] },
  });
  sqlite = db.getDb();
  sqlite.prepare('INSERT INTO tracker_schedule (tracker_id, enabled, interval_hours) VALUES (?, 1, 24)').run('nexum');
  sqlite.prepare(`
    INSERT INTO stat_snapshots (tracker_id, tracker_name, status, error, fields_json, captured_at)
    VALUES (?, ?, 'ok', NULL, '{}', ?)
  `).run('nexum-2', 'Nexum (2)', new Date().toISOString());

  db.removeRetiredBundledTrackers();

  assert.deepEqual(db.loadRawTrackerConfigsFromDb(), []);
  assert.deepEqual(db.listTrackerCredentialSummaries(), []);
  assert.equal(db.getTrackerCookie('nexum'), '');
  assert.equal(db.getTrackerTotpSecret('nexum-2'), '');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM tracker_schedule').get().count, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stat_snapshots').get().count, 0);
  assert.deepEqual(db.getJsonSetting('trackerOrder', { ids: [] }).ids, ['kept']);
  assert.deepEqual(db.getJsonSetting('proxy_overrides', [])[0].trackers, ['kept']);
  const beta = db.getJsonSetting('beta_settings', {});
  assert.deepEqual(beta.announceMappings, []);
  assert.deepEqual(beta.accountAnnounceMappings, []);
  assert.deepEqual(beta.scheduleOverrides, []);
  assert.deepEqual(Object.keys(beta.trackerAlerts), ['kept']);
  assert.deepEqual(beta.schedule.lastFailedTrackerIds, ['kept']);
  assert.equal(fs.existsSync(path.join(temp, 'config', 'trackers', 'nexum.json')), false);
  assert.equal(fs.existsSync(path.join(temp, 'config', 'trackers', 'torr9.json')), false);

  console.log('Retired tracker cleanup OK: definition, duplicate, credentials, cookie and TOTP removed.');
} finally {
  sqlite?.close();
  process.chdir(root);
  fs.rmSync(temp, { recursive: true, force: true });
}
