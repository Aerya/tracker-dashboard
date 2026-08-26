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
const lesaloonv2 = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'lesaloonv2.json'), 'utf8'));
const digitalcore = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'digitalcore.json'), 'utf8'));
const v3x = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'v3x.json'), 'utf8'));
const hdforever = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', 'hdforever.json'), 'utf8'));
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
  && server.includes('if (!creds && !storedCookieReady(tracker))')
  && server.includes('fetchTrackerBounded(tracker, creds ?? EMPTY_CREDENTIALS)')
);
if (!supportsAffectedTrackerLogins) {
  errors.push('SpeedApp email login, Memphis cookie-only refresh and duplicated TR4KER browser readiness must remain supported');
}

const memphisRuntimeWaitsForSpaStats = (
  memphis.fetch?.url === '/?view=profile'
  && memphis.fetch?.mode === 'browser'
  && browserFetcher.includes("tracker.id === 'memphis'")
  && browserFetcher.includes("document.querySelector('#account-health-panel')")
  && browserFetcher.includes('/Ratio\\s+indicatif/i.test(text)')
  && memphis.fetch?.fields?.uploadedBytes
  && memphis.fetch?.fields?.downloadedBytes
  && memphis.fetch?.fields?.ratio
  && memphis.fetch?.fields?.seeding
);
if (!memphisRuntimeWaitsForSpaStats) {
  errors.push('Memphis must wait for SPA profile stats before extracting ratio, traffic and seeding');
}

const refreshesBundledTrackerDefinitions = (
  db.includes('fs.copyFileSync(source, target);')
  && !db.includes('if (fs.existsSync(target)) continue;')
);
if (!refreshesBundledTrackerDefinitions) {
  errors.push('Bundled tracker definitions must refresh existing volume copies after image updates');
}

const extractorValue = (tracker, field, fixture) => {
  const extractor = tracker.fetch?.fields?.[field];
  return extractor?.regex
    ? new RegExp(extractor.regex, 's').exec(fixture)?.groups?.value?.trim()
    : undefined;
};

const lesaloonFixture = `
  <font>Rang</font><font>[</font><span><strong>Membre VIP</strong></span><font>]</font>
  <font>Upload</font><font>[</font><font color="green">82.17 TB</font>
  <font>Download</font><font>[</font><font color="green">0.00 KB</font>
  <font>Ratio</font><font>[</font><font color="green">1000</font>
  <a href="index.php?page=modules&module=seedbonus"><font>Pièces d'or</font><font>[</font><font color="green">6,184,620.11</font></a>`;
const digitalcoreFixture = `
  <span>Ratio:</span><strong>100+</strong><span>UL:</span><strong>55.99 GiB</strong>
  <span>DL:</span><strong>0 KiB</strong><span>Buffer:</span><strong>55.99 GiB</strong>
  <dt>Points:</dt><dd>22 761,50</dd>`;
const supportsNewCaptchaTrackers = (
  lesaloonv2.login?.cookieOnly === true
  && lesaloonv2.fetch?.mode === 'browser'
  && lesaloonv2.fetch?.antiBotFallback === 'flaresolverr'
  && extractorValue(lesaloonv2, 'memberClass', lesaloonFixture) === 'Membre VIP'
  && extractorValue(lesaloonv2, 'uploadedBytes', lesaloonFixture) === '82.17 TB'
  && extractorValue(lesaloonv2, 'downloadedBytes', lesaloonFixture) === '0.00 KB'
  && extractorValue(lesaloonv2, 'ratio', lesaloonFixture) === '1000'
  && extractorValue(lesaloonv2, 'seedBonus', lesaloonFixture) === '6,184,620.11'
  && digitalcore.login?.cookieOnly === true
  && digitalcore.fetch?.mode === 'browser'
  && digitalcore.fetch?.url === '/'
  && browserFetcher.includes("(tracker.baseId ?? tracker.id) === 'digitalcore'")
  && browserFetcher.includes("(tracker.baseId ?? tracker.id) === 'lesaloonv2'")
  && extractorValue(digitalcore, 'ratio', digitalcoreFixture) === '100+'
  && extractorValue(digitalcore, 'uploadedBytes', digitalcoreFixture) === '55.99 GiB'
  && extractorValue(digitalcore, 'downloadedBytes', digitalcoreFixture) === '0 KiB'
  && extractorValue(digitalcore, 'bufferBytes', digitalcoreFixture) === '55.99 GiB'
  && extractorValue(digitalcore, 'seedBonus', digitalcoreFixture) === '22 761,50'
);
if (!supportsNewCaptchaTrackers) {
  errors.push('LeSaloon v2 and DigitalCore must use cookie-authenticated browser reads and parse their supplied stats layouts');
}

const v3xStatCard = (label, value) => `
  <div class="rounded-xl border">
    <span class="flex text-[11px]"><svg width="12"><path d="M3 0 7 12"></path></svg> ${label}</span>
    <span class="font-mono text-lg font-semibold text-accent">${value}</span>
  </div>`;
const v3xActivityFixture = `
  ${v3xStatCard('Upload', '79.9 Gio')}
  ${v3xStatCard('Download', '1.00 Gio')}
  ${v3xStatCard('Buffer', '+78.9 Gio')}
  ${v3xStatCard('Ratio', '79.89')}
  ${v3xStatCard('Temps de seed', '25j 21h')}
  ${v3xStatCard('Points', '52')}
  ${v3xStatCard('Points / h', '+4')}
  <button class="px-4 py-2 text-sm"><span><svg width="14"><path d="M2 20"></path></svg></span>Seeds en cours<span class="px-1.5 py-0.5 text-[10px]">5</span></button>`;
const v3xUppercaseActivityFixture = `
  ${v3xStatCard('UPLOAD', '84.8 Gio')}
  ${v3xStatCard('DOWNLOAD', '1.00 Gio')}
  ${v3xStatCard('BUFFER', '+83.8 Gio')}
  ${v3xStatCard('RATIO', '84.76')}
  ${v3xStatCard('TEMPS DE SEED', '48j 3h')}
  ${v3xStatCard('POINTS', '74')}
  ${v3xStatCard('POINTS / H', '+5')}
  <button class="px-4 py-2 text-sm"><span><svg width="14"><path d="M2 20"></path></svg></span>Seeds en cours<span class="px-1.5 py-0.5 text-[10px]">5</span></button>`;
const supportsV3xActivityStats = (
  v3x.fetch?.url === '/activity'
  && v3x.fetch?.mode === 'browser'
  && extractorValue(v3x, 'uploadedBytes', v3xActivityFixture) === '79.9 Gio'
  && extractorValue(v3x, 'downloadedBytes', v3xActivityFixture) === '1.00 Gio'
  && extractorValue(v3x, 'bufferBytes', v3xActivityFixture) === '+78.9 Gio'
  && extractorValue(v3x, 'ratio', v3xActivityFixture) === '79.89'
  && extractorValue(v3x, 'seedTime', v3xActivityFixture) === '25j 21h'
  && extractorValue(v3x, 'points', v3xActivityFixture) === '52'
  && extractorValue(v3x, 'pointsPerHour', v3xActivityFixture) === '+4'
  && extractorValue(v3x, 'seeding', v3xActivityFixture) === '5'
  && extractorValue(v3x, 'uploadedBytes', v3xUppercaseActivityFixture) === '84.8 Gio'
  && extractorValue(v3x, 'downloadedBytes', v3xUppercaseActivityFixture) === '1.00 Gio'
  && extractorValue(v3x, 'bufferBytes', v3xUppercaseActivityFixture) === '+83.8 Gio'
  && extractorValue(v3x, 'ratio', v3xUppercaseActivityFixture) === '84.76'
  && extractorValue(v3x, 'seedTime', v3xUppercaseActivityFixture) === '48j 3h'
  && extractorValue(v3x, 'points', v3xUppercaseActivityFixture) === '74'
  && extractorValue(v3x, 'pointsPerHour', v3xUppercaseActivityFixture) === '+5'
);
if (!supportsV3xActivityStats) {
  errors.push('V3X must read all supplied stats from the authenticated /activity page');
}

const hdfOtpDetectionIsSpecific = (
  hdforever.login?.otpStep?.field === 'otp_code'
  && hdforever.login?.otpStep?.action === 'login.php?act=otp'
  && fetcher.includes('function isOtpStepPage')
  && fetcher.includes('if (!landedUrl.includes(otpStep.urlContains)) return false')
  && fetcher.includes('input[name="${otpStep.field}"]')
  && fetcher.includes('[?&]act=otp')
  && !fetcher.includes('} else if (cfg.otpStep && landedUrl.includes(cfg.otpStep.urlContains))')
);
if (!hdfOtpDetectionIsSpecific) {
  errors.push('HD-Forever otpStep must require a real OTP marker, not just login.php in the landed URL');
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

const browserLoginTrackerIds = ['lesrescapesdeygg', 'yggreborn'];
for (const trackerId of browserLoginTrackerIds) {
  const tracker = JSON.parse(fs.readFileSync(path.join(root, 'config', 'trackers', `${trackerId}.json`), 'utf8'));
  if (tracker.login?.cookieOnly === true || tracker.fetch?.mode !== 'browser') {
    errors.push(`${tracker.name} must allow automatic browser login`);
  }
}

const crazyspirits = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'trackers', 'crazyspirits.json'), 'utf8'),
);
const crazySpiritsUsesTurnstileCookieSession = (
  crazyspirits.login?.cookieOnly === true
  && crazyspirits.fetch?.mode === 'browser'
  && crazyspirits.login?.failurePatterns?.includes('cf-turnstile')
  && crazyspirits.login?.failurePatterns?.includes('account-login.php')
);
if (!crazySpiritsUsesTurnstileCookieSession) {
  errors.push('CrazySpirits must use a cookie-authenticated browser session when Turnstile is enabled');
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
