import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';

const root = process.cwd();
const unraidDir = path.join(root, 'unraid');
const templateNames = [
  'tracker-dashboard',
  'tracker-dashboard-browser',
  'tracker-dashboard-flaresolverr',
];

const parsed = new Map();
for (const name of templateNames) {
  const file = path.join(unraidDir, `${name}.xml`);
  assert.equal(fs.existsSync(file), true, `Template Unraid manquant : ${name}`);
  const xml = fs.readFileSync(file, 'utf8');
  const $ = load(xml, { xmlMode: true });
  assert.equal($('Container').attr('version'), '2');
  assert.equal($('Container > Name').text(), name);
  assert.match($('Container > Repository').text(), /^ghcr\.io\//);
  assert.match($('Container > TemplateURL').text(), new RegExp(`/unraid/${name}\\.xml$`));
  assert.equal($('Container > Privileged').text(), 'false');
  parsed.set(name, $);
}

const main = parsed.get('tracker-dashboard');
assert.equal(main('Container > Network').text(), 'bridge');
assert.equal(main('Config[Type="Port"][Target="3000"]').text(), '4832');
assert.equal(main('Config[Type="Path"][Target="/app/config"]').text(), '/mnt/user/appdata/tracker-dashboard');

for (const name of ['tracker-dashboard-browser', 'tracker-dashboard-flaresolverr']) {
  const $ = parsed.get(name);
  assert.equal($('Container > Network').text(), 'container:tracker-dashboard');
  assert.equal($('Config[Type="Port"]').length, 0, `${name} ne doit exposer aucun port`);
}

const browser = parsed.get('tracker-dashboard-browser');
assert.equal(browser('Config[Type="Path"][Target="/app/config"]').text(), '/mnt/user/appdata/tracker-dashboard');

const flare = parsed.get('tracker-dashboard-flaresolverr');
assert.equal(flare('Config[Type="Variable"][Target="HOST"]').text(), '127.0.0.1');

const guide = fs.readFileSync(path.join(unraidDir, 'README.md'), 'utf8');
const installer = fs.readFileSync(path.join(unraidDir, 'install-templates.sh'), 'utf8');
assert.match(guide, /phase bêta/i);
assert.match(guide, /Retours recherchés/);
assert.match(guide, /N'incluez jamais d'identifiants/);
for (const name of templateNames) assert.match(installer, new RegExp(name));

console.log('Unraid template checks OK: three DockerMan templates, private sidecars, installer and feedback guide.');
