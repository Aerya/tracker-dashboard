import {
  extractExtraFieldResponse,
  extractOtpFieldName,
  fetchExtraField,
  isAntiBotPage,
  isTwoFactorPage,
} from '../dist/fetcher.js';

const gazelleTracker = {
  id: 'gazelle-test',
  name: 'Gazelle Test',
  baseUrl: 'https://tracker.example/',
  login: { url: 'login.php', method: 'POST', contentType: 'form', failurePatterns: [] },
  fetch: {
    url: 'index.php',
    responseType: 'html',
    fields: {},
    extraFetch: {
      url: 'ajax.php?action=user&id={{id}}',
      field: 'seeding',
      responseType: 'json',
      idExtract: { regex: 'href="user\\.php\\?id=(?<value>\\d+)" class="username"' },
      path: 'response.community.seeding',
      transform: 'integer',
    },
  },
};

let requestedUrl = '';
const fetchedGazelleResult = await fetchExtraField(
  gazelleTracker,
  '<a href="user.php?id=42" class="username">user</a>',
  async (url) => {
    requestedUrl = url;
    return { status: 200, body: JSON.stringify({ response: { community: { seeding: 23 } } }) };
  },
  {},
  { username: 'user', password: 'unused' },
);

if (requestedUrl !== 'https://tracker.example/ajax.php?action=user&id=42'
  || fetchedGazelleResult?.value !== 23) {
  throw new Error('Gazelle extraFetch id interpolation or JSON extraction failed');
}

const jsonResult = extractExtraFieldResponse({
  url: 'ajax.php?action=user&id={{id}}',
  field: 'seeding',
  responseType: 'json',
  path: 'response.community.seeding',
  transform: 'integer',
}, JSON.stringify({ response: { community: { seeding: 23 } } }));

if (jsonResult?.field !== 'seeding' || jsonResult.value !== 23) {
  throw new Error('extraFetch JSON path extraction failed');
}

const htmlResult = extractExtraFieldResponse({
  url: 'torrents.php?type=seeding&userid={{id}}',
  field: 'seeding',
  regex: '(?<value>\\d+)\\s+torrents? found',
  transform: 'integer',
}, '<h2>122 torrents found</h2>');

if (htmlResult?.field !== 'seeding' || htmlResult.value !== 122) {
  throw new Error('extraFetch HTML regex extraction failed');
}

if (extractExtraFieldResponse({
  url: 'ajax.php',
  field: 'seeding',
  path: 'response.community.seeding',
}, '<html>not JSON</html>') !== null) {
  throw new Error('extraFetch malformed JSON must remain best-effort');
}

if (!isAntiBotPage('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>')) {
  throw new Error('Cloudflare managed challenge must be detected');
}

if (isAntiBotPage('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')) {
  throw new Error('Cloudflare Insights beacon must not be treated as an anti-bot challenge');
}

const torrentLeechOtpFixture = `
  <html><head><title>Login :: One Time Password :: TorrentLeech.org</title></head>
  <body><form method="post" action="/user/account/login/otp/">
    <input type="hidden" name="csrf" value="fixture">
    <input type="text" name="otp" autocomplete="one-time-code">
    <button type="submit">Login</button>
  </form></body></html>`;
if (!isTwoFactorPage(torrentLeechOtpFixture) || extractOtpFieldName(torrentLeechOtpFixture) !== 'otp') {
  throw new Error('TorrentLeech one-time-password page must be detected with its submitted OTP field');
}

console.log('extraFetch response extraction OK.');
