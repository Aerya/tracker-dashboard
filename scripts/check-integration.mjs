import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'public', 'index.html');
const readmePath = path.join(root, 'README.md');
const serverPath = path.join(root, 'src', 'server.ts');
const redactedPath = path.join(root, 'config', 'trackers', 'redacted.json');
const tr4kerPath = path.join(root, 'config', 'trackers', 'tr4ker.json');
const lesRescapesPath = path.join(root, 'config', 'trackers', 'lesrescapesdeygg.json');
const html = fs.readFileSync(htmlPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');
const server = fs.readFileSync(serverPath, 'utf8');
const redacted = JSON.parse(fs.readFileSync(redactedPath, 'utf8'));
const tr4ker = JSON.parse(fs.readFileSync(tr4kerPath, 'utf8'));
const lesRescapes = JSON.parse(fs.readFileSync(lesRescapesPath, 'utf8'));
const errors = [];

function normalizeRoute(route) {
  return route
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/:[A-Za-z0-9_]+/g, ':param')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '') || '/';
}

function routePattern(route) {
  const escaped = normalizeRoute(route)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll(':param', '[^/]+');
  return new RegExp(`^${escaped}$`);
}

const serverRoutes = [];
const serverRouteRegex = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
for (const match of server.matchAll(serverRouteRegex)) {
  serverRoutes.push({ method: match[1].toUpperCase(), route: normalizeRoute(match[3]) });
}

const frontendCalls = [];
const fetchRegex = /fetch\(\s*([`'"])(\/api\/[^`'"]+)\1\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g;
for (const match of html.matchAll(fetchRegex)) {
  const options = match[3] || '';
  const methodMatch = options.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i);
  frontendCalls.push({
    method: (methodMatch?.[1] || 'GET').toUpperCase(),
    route: normalizeRoute(match[2]),
  });
}

for (const call of frontendCalls) {
  const found = serverRoutes.some(route => (
    route.method === call.method && routePattern(route.route).test(call.route)
  ));
  if (!found) errors.push(`Missing backend route for ${call.method} ${call.route}`);
}

for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  try {
    new Function(match[1]);
  } catch (error) {
    errors.push(`Inline script ${index + 1} has invalid JavaScript: ${error.message}`);
  }
}

for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) {
  const reference = match[1];
  if (reference.startsWith('/api/')) continue;
  const assetPath = path.join(root, 'public', reference.slice(1));
  if (!fs.existsSync(assetPath)) errors.push(`Missing public asset: ${reference}`);
}

for (const [file, content] of [[htmlPath, html], [serverPath, server]]) {
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) {
    errors.push(`Unresolved merge marker in ${path.relative(root, file)}`);
  }
}

if (!html.includes('<h2>🔀 Proxy</h2>')) {
  errors.push('Proxy panel heading is missing or corrupted');
}

const seedingSourcesAreStacked = (
  html.includes('.seeding-sources { display: flex; flex-direction: column; gap: 2px; }')
  && html.includes('return `<span class="seeding-sources">${parts.join(\'\')}</span>`;')
);
if (!seedingSourcesAreStacked) {
  errors.push('Site and BitTorrent seeding sources must remain vertically stacked');
}

const synchronizesAllBundledTrackers = (
  server.includes('const definition = loadDefaultTrackerDefinition(tracker.baseId ?? tracker.id);')
  && !server.includes('CANONICAL_CONNECTION_TRACKERS')
);
if (redacted.fetch?.fields?.requiredRatio && !synchronizesAllBundledTrackers) {
  errors.push('Redacted bundled fields are not synchronized to existing installations');
}

const tr4kerUsesDisplayedTotals = (
  tr4ker.fetch?.url === 'api/me'
  && tr4ker.fetch?.fields?.uploadedBytes?.path === 'bonus_upload'
  && tr4ker.fetch?.fields?.downloadedBytes?.path === 'bonus_download'
  && tr4ker.fetch?.extraFetch?.url === 'api/me/stats'
  && tr4ker.fetch?.extraFetch?.path === 'statistics.torrents_seeding'
);
if (!tr4kerUsesDisplayedTotals) {
  errors.push('TR4KER must use the totals displayed by the site and keep seeding from api/me/stats');
}

const lesRescapesDetectsExpiredCookies = (
  lesRescapes.login?.cookieOnly === true
  && lesRescapes.login?.failurePatterns?.includes('id="login-form"')
  && lesRescapes.fetch?.url === '?action=my-tracker-activity'
);
if (!lesRescapesDetectsExpiredCookies) {
  errors.push('Les Rescapes de Ygg must detect the login page returned for an expired cookie');
}

const documentsCookieIpBinding = (
  html.includes('exporte tous les cookies avec la même IP de sortie')
  && html.includes('<code>cf_clearance</code>')
  && readme.includes('Les cookies doivent être créés avec la même IP de sortie')
  && readme.includes('`cf_clearance` est présent')
);
if (!documentsCookieIpBinding) {
  errors.push('Session cookie guidance must document IP binding and cf_clearance in the WebUI and README');
}

if (errors.length > 0) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`Integration contracts OK: ${frontendCalls.length} frontend API calls checked.`);
