import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'public', 'index.html');
const readmePath = path.join(root, 'README.md');
const composePath = path.join(root, 'docker-compose.yml');
const serverPath = path.join(root, 'src', 'server.ts');
const fetcherPath = path.join(root, 'src', 'fetcher.ts');
const browserFetcherPath = path.join(root, 'src', 'browserFetcher.ts');
const redactedPath = path.join(root, 'config', 'trackers', 'redacted.json');
const tr4kerPath = path.join(root, 'config', 'trackers', 'tr4ker.json');
const torr9Path = path.join(root, 'config', 'trackers', 'torr9.json');
const lesRescapesPath = path.join(root, 'config', 'trackers', 'lesrescapesdeygg.json');
const avistazPath = path.join(root, 'config', 'trackers', 'avistaz.json');
const cinemazPath = path.join(root, 'config', 'trackers', 'cinemaz.json');
const exoticazPath = path.join(root, 'config', 'trackers', 'exoticaz.json');
const privatehdPath = path.join(root, 'config', 'trackers', 'privatehd.json');
const nexumPath = path.join(root, 'config', 'trackers', 'nexum.json');
const dbPath = path.join(root, 'src', 'db.ts');
const html = fs.readFileSync(htmlPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');
const compose = fs.readFileSync(composePath, 'utf8');
const server = fs.readFileSync(serverPath, 'utf8');
const fetcher = fs.readFileSync(fetcherPath, 'utf8');
const browserFetcher = fs.readFileSync(browserFetcherPath, 'utf8');
const db = fs.readFileSync(dbPath, 'utf8');
const redacted = JSON.parse(fs.readFileSync(redactedPath, 'utf8'));
const tr4ker = JSON.parse(fs.readFileSync(tr4kerPath, 'utf8'));
const speedapp = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'speedapp.json'), 'utf8'));
const memphis = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'memphis.json'), 'utf8'));
const lesRescapes = JSON.parse(fs.readFileSync(lesRescapesPath, 'utf8'));
const { applyEnginePreset } = await import('../dist/trackerTemplates.js');
const errors = [];

const avistazTrackers = [avistazPath, cinemazPath, privatehdPath]
  .map(file => applyEnginePreset(JSON.parse(fs.readFileSync(file, 'utf8'))));
const exoticaz = applyEnginePreset(JSON.parse(fs.readFileSync(exoticazPath, 'utf8')));
const avistazPresetIsUsable = avistazTrackers.every(tracker => (
  tracker.login?.cookieOnly === true
  && tracker.login?.url === 'auth/login'
  && tracker.login?.body?.email_username === '{{username}}'
  && tracker.fetch?.mode === 'browser'
  && tracker.dashboard?.byteUnit === 'decimal'
)) && (
  exoticaz.login?.cookieOnly === true
  && exoticaz.login?.url === 'login'
  && exoticaz.login?.body?.username_email === '{{username}}'
  && exoticaz.login?.body?.email_username === undefined
  && exoticaz.fetch?.fields?.uploadedBytes
) && (
  server.match(/loadEffectiveTrackerDefinition\(definition\.id\)\?\.login\?\.cookieOnly/g)?.length === 2
);
if (!avistazPresetIsUsable) {
  errors.push('AvistaZ Network definitions must resolve their cookie-only login and site-specific overrides before configuration');
}

const honorsServerTimeZone = (
  server.includes('timeZone: appTimeZone()')
  && html.includes('setDashboardTimeZone(d.timeZone)')
  && html.includes('timeZone: dashboardTimeZone')
);
if (!honorsServerTimeZone) {
  errors.push('Displayed timestamps must honor the server TZ setting');
}

const retiresClosedNexumTracker = (
  !fs.existsSync(nexumPath)
  && readme.includes('Retrait de Nexum')
  && readme.includes('fermé définitivement')
  && db.includes("RETIRED_BUNDLED_TRACKER_IDS = new Set(['nexum', 'torr9'])")
  && db.includes('removeRetiredBundledTrackers();')
);
if (!retiresClosedNexumTracker) {
  errors.push('Closed Nexum tracker must be removed from bundled definitions and migrated out of existing installations');
}

const retiresTorr9Tracker = (
  !fs.existsSync(torr9Path)
  && readme.includes('Retrait de Torr9')
  && db.includes("RETIRED_BUNDLED_TRACKER_IDS = new Set(['nexum', 'torr9'])")
  && !browserFetcher.includes("tracker.id === 'torr9'")
);
if (!retiresTorr9Tracker) {
  errors.push('Torr9 must be removed from bundled definitions, existing installations and browser-specific behavior');
}

const supportsAffectedTrackerLogins = (
  speedapp.login?.body?.email === '{{username}}'
  && speedapp.login?.body?.username === undefined
  && memphis.login?.cookieOnly === true
  && memphis.login?.failurePatterns?.includes('class="auth-locked"')
  && browserFetcher.includes("(tracker.baseId ?? tracker.id) !== 'tr4ker'")
  && browserFetcher.includes('patterns: string[] = []')
  && fetcher.includes('patterns: string[] = []')
  && server.includes('if (!creds && !cookieOnlyReady(tracker))')
  && server.includes('fetchTrackerBounded(tracker, creds ?? EMPTY_CREDENTIALS)')
);
if (!supportsAffectedTrackerLogins) {
  errors.push('SpeedApp email login, Memphis cookie-only refresh and duplicated TR4KER browser readiness must remain supported');
}

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

const cardEditOpensSelectedTracker = (
  /function openTrackerEdit\(trackerId\) \{\r?\n\s+openTrackerConfig\(trackerId\);\r?\n\s+\}/.test(html)
  && !html.includes("document.getElementById('tracker-definitions-panel')")
);
if (!cardEditOpensSelectedTracker) {
  errors.push('Card edit buttons must open the selected tracker configuration view');
}

const torrentTrackerListingPreservesFallback = (
  html.includes('function betaQbitGroupMatchesTracker(item, stat, host, multiAccount)')
  && html.includes('if (multiAccount) return false;')
  && html.includes('if (trackerHostFromUrl(item.trackerHost) === host) return true;')
  && html.includes('return betaTrackerMatchForHost(item.trackerHost)?.tracker.id === stat.id;')
  && server.includes('function qbitStatsWithTrackerIds(settings: BetaSettings, activeTrackers: TrackerConfig[])')
  && !server.includes('function trackerHostMapFor(activeTrackers: TrackerConfig[], settings: BetaSettings): Map<string, string>')
);
if (!torrentTrackerListingPreservesFallback) {
  errors.push('Tracker fiches must preserve the BitTorrent torrent listing fallback used before optional columns');
}

const synchronizesAllBundledTrackers = (
  server.includes('const definition = loadDefaultTrackerDefinition(tracker.baseId ?? tracker.id);')
  && !server.includes('CANONICAL_CONNECTION_TRACKERS')
);
if (redacted.fetch?.fields?.requiredRatio && !synchronizesAllBundledTrackers) {
  errors.push('Redacted bundled fields are not synchronized to existing installations');
}

const tr4kerUsesDisplayedTotals = (
  tr4ker.fetch?.url === '/'
  && tr4ker.fetch?.mode === 'browser'
  && tr4ker.fetch?.responseType === 'html'
  && !JSON.stringify(tr4ker.fetch).includes('api/me')
);
if (!tr4kerUsesDisplayedTotals) {
  errors.push('TR4KER must scrape the totals displayed by the authenticated site, without /api/me');
}

const tr4kerHomeFixture = `
  <div class="user-stat"><span>RATIO</span><div class="home_statValue">45.67</div></div>
  <div class="user-stat"><span>UPLOAD</span><div class="home_statValue">12.34 TB</div></div>
  <div class="user-stat"><span>DOWNLOAD</span><div class="home_statValue">56.78 GB</div></div>`;
const tr4kerValue = field => new RegExp(field.regex, 's').exec(tr4kerHomeFixture)?.groups?.value?.trim();
if (
  tr4kerValue(tr4ker.fetch?.fields?.uploadedBytes) !== '12.34 TB'
  || tr4kerValue(tr4ker.fetch?.fields?.downloadedBytes) !== '56.78 GB'
  || tr4kerValue(tr4ker.fetch?.fields?.ratio) !== '45.67'
) {
  errors.push('TR4KER home-page extractors must parse the rendered upload, download and ratio values');
}

const lesRescapesUsesBrowserLogin = (
  lesRescapes.login?.cookieOnly !== true
  && lesRescapes.login?.failurePatterns?.includes('id="login-form"')
  && !lesRescapes.login?.failurePatterns?.includes('name="pass"')
  && lesRescapes.login?.body?.id === '{{username}}'
  && lesRescapes.login?.body?.pass === '{{password}}'
  && lesRescapes.login?.body?.remember_me === 'on'
  && lesRescapes.fetch?.url === '?action=my-tracker-activity'
  && browserFetcher.includes("tracker.id === 'lesrescapesdeygg'")
  && browserFetcher.includes("text.includes('Sessions tracker actives')")
);
if (!lesRescapesUsesBrowserLogin) {
  errors.push('Les Rescapes de Ygg must submit its browser login form when the session expires');
}

const preservesRateLimitErrors = (
  fetcher.includes('Login temporairement limité — HTTP 429')
  && fetcher.includes("error.message.includes('HTTP 429')")
  && fetcher.includes("reason: 'curl-rate-limited'")
);
if (!preservesRateLimitErrors) {
  errors.push('HTTP 429 login responses must stop fallback retries and keep their real error message');
}

const browserLoginTrackerIds = ['crazyspirits', 'lesrescapesdeygg', 'yggreborn'];
for (const trackerId of browserLoginTrackerIds) {
  const tracker = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', `${trackerId}.json`), 'utf8'));
  if (tracker.login?.cookieOnly === true || tracker.fetch?.mode !== 'browser') {
    errors.push(`${tracker.name} must allow automatic browser login`);
  }
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

const yggUsesFlareSolverrFallback = (
  JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'yggreborn.json'), 'utf8'))
    .fetch?.antiBotFallback === 'flaresolverr'
);
if (!yggUsesFlareSolverrFallback) {
  errors.push('YGGReborn must use the FlareSolverr anti-bot fallback');
}

const shipsFlareSolverrSidecar = (
  compose.includes('tracker-dashboard-flaresolverr:')
  && compose.includes('ghcr.io/flaresolverr/flaresolverr:latest')
  && compose.includes('tracker-dashboard-trawl:')
  && compose.includes('ghcr.io/germondai/trawl:baseline')
  && compose.includes('PORT: 8192')
  && compose.includes('LOG_LEVEL: warning')
  && compose.includes('network_mode: "service:tracker-dashboard"')
  && compose.includes('HOST: 127.0.0.1')
  && html.includes('/api/flaresolverr/status')
  && html.includes('/api/trawl/status')
  && server.includes("app.get('/api/flaresolverr/status'")
  && server.includes("app.get('/api/trawl/status'")
  && readme.includes('### Repli Cloudflare (FlareSolverr puis TRAWL)')
  && readme.includes('ghcr.io/germondai/trawl:baseline')
);
if (!shipsFlareSolverrSidecar) {
  errors.push('FlareSolverr and TRAWL anti-bot sidecar wiring must remain available in Compose, WebUI and README');
}

const shipsCrossSeedIntegration = (
  fs.existsSync(path.join(root, 'public', 'cross-seed.svg'))
  && html.includes('id="beta-cross-seed-instances"')
  && html.includes("fetch('/api/beta/cross-seed/test'")
  && html.includes("fetch('/api/beta/cross-seed/summary'")
  && html.includes('crossSeedTrackerMarks(stat.id')
  && html.includes('torrent.crossSeedInstanceIds')
  && html.includes('data-field="clientIds"')
  && server.includes("app.post('/api/beta/cross-seed/test'")
  && server.includes("app.get('/api/beta/cross-seed/summary'")
  && server.includes('detectCrossSeedInstanceIds')
  && server.includes('normalizeCrossSeedClientIds')
  && readme.includes('### Instances cross-seed')
  && readme.includes('Aucune clé API cross-seed')
);
if (!shipsCrossSeedIntegration) {
  errors.push('cross-seed instances, badges, torrent markers, API test and README documentation must remain wired');
}

if (errors.length > 0) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`Integration contracts OK: ${frontendCalls.length} frontend API calls checked.`);
