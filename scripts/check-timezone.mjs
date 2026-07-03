import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-dashboard-timezone-'));
let sqlite;

try {
  fs.mkdirSync(path.join(temp, 'config'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'default-trackers'), { recursive: true });
  process.chdir(temp);

  const db = await import(`${pathToFileURL(path.join(root, 'dist', 'db.js')).href}?timezone=${Date.now()}`);
  sqlite = db.getDb();
  db.ensureTrackerSchedules([{ id: 'fixture' }]);
  sqlite.prepare(`
    UPDATE tracker_schedule
    SET last_run_at = '2026-07-03 04:20:00',
        next_run_at = '2026-07-03T07:20:00.000Z'
    WHERE tracker_id = 'fixture'
  `).run();
  db.saveStatSnapshots([{
    id: 'fixture',
    name: 'Fixture',
    trackerUrl: 'https://fixture.invalid',
    status: 'ok',
    lastUpdated: '2026-07-03 04:20:00',
    fields: {},
  }]);

  const schedule = db.getTrackerSchedule('fixture');
  assert.equal(schedule.lastRunAt, '2026-07-03T04:20:00Z');
  assert.equal(schedule.nextRunAt, '2026-07-03T07:20:00.000Z');
  assert.equal(db.listStatSnapshots('fixture', 1)[0].capturedAt, '2026-07-03T04:20:00Z');

  const paris = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  }).format(new Date(schedule.lastRunAt));
  assert.match(paris, /03\/07\/2026 06:20/);

  console.log('Timezone checks OK: SQLite UTC timestamps render at Europe/Paris local time.');
} finally {
  sqlite?.close();
  process.chdir(root);
  fs.rmSync(temp, { recursive: true, force: true });
}
