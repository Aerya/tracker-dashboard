import http from 'node:http';
import { fetchWithFlareSolverr, getFlareSolverrStatus, getTrawlStatus, isFlareSolverrCandidate } from '../dist/flareSolverr.js';

const calls = [];
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ msg: 'FlareSolverr is ready!', version: 'test', userAgent: 'Mock Browser' }));
    return;
  }

  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw);
  calls.push(payload);
  response.setHeader('Content-Type', 'application/json');

  if (payload.cmd === 'sessions.create') {
    response.end(JSON.stringify({ status: 'ok', session: payload.session }));
    return;
  }
  if (payload.cmd === 'sessions.destroy') {
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (payload.url.endsWith('/extra-fail')) {
    response.end(JSON.stringify({ status: 'error', message: 'secondary request failed' }));
    return;
  }
  if (payload.url.endsWith('/account/active-torrents')) {
    response.end(JSON.stringify({
      status: 'ok',
      solution: { status: 200, url: payload.url, response: '<div>12 en partage</div>', cookies: [] },
    }));
    return;
  }
  response.end(JSON.stringify({
    status: 'ok',
    solution: {
      status: 200,
      url: payload.url,
      response: '<div>910.27 GB</div><span>Upload</span><div>439.76 GB</div><span>Download</span>',
      cookies: [{ name: 'cf_clearance', value: 'generated' }],
    },
  }));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tracker = {
    id: 'yggreborn-test',
    name: 'YGGReborn Test',
    baseUrl: 'https://www.yggreborn.org',
    login: { url: 'login', method: 'POST', contentType: 'form', body: {}, failurePatterns: [], cookieOnly: true },
    fetch: {
      url: 'account/',
      mode: 'browser',
      responseType: 'html',
      fields: {},
      extraFetch: { url: 'account/active-torrents', field: 'seeding', regex: '(?<value>\\d+) en partage', transform: 'integer' },
    },
  };
  const result = await fetchWithFlareSolverr(tracker, { username: 'user', password: 'unused' }, {
    baseUrl,
    cookieRaw: 'remember_token=session; __ygg_sess=token',
    proxy: { enabled: true, type: 'http', host: 'proxy.local', port: '8887', username: '', password: '', directConnectAllowed: false },
    timeoutMs: 5_000,
  });

  if (!result.html.includes('Upload') || !result.extraHtml?.includes('12 en partage')) {
    throw new Error('FlareSolverr primary or extra HTML was not returned');
  }
  if (calls[0]?.cmd !== 'sessions.create' || calls.at(-1)?.cmd !== 'sessions.destroy') {
    throw new Error('FlareSolverr session lifecycle is incomplete');
  }
  if (calls[0]?.proxy?.url !== 'http://proxy.local:8887') {
    throw new Error('Tracker proxy was not forwarded to FlareSolverr');
  }
  const mainRequest = calls.find(call => call.url?.endsWith('/account/'));
  if (mainRequest?.cookies?.map(cookie => cookie.name).sort().join(',') !== '__ygg_sess,remember_token') {
    throw new Error('Stored tracker cookies were not forwarded to FlareSolverr');
  }

  const bestEffortResult = await fetchWithFlareSolverr({
    ...tracker,
    id: 'yggreborn-extra-failure-test',
    fetch: { ...tracker.fetch, extraFetch: { ...tracker.fetch.extraFetch, url: 'extra-fail' } },
  }, { username: 'user', password: 'unused' }, {
    baseUrl,
    cookieRaw: 'remember_token=session; __ygg_sess=token',
    proxy: { enabled: false, type: 'direct', host: '', port: '', username: '', password: '', directConnectAllowed: true },
    timeoutMs: 5_000,
  });
  if (!bestEffortResult.html.includes('Upload') || bestEffortResult.extraHtml !== undefined) {
    throw new Error('FlareSolverr extra fetch failures must remain best-effort');
  }

  const status = await getFlareSolverrStatus(baseUrl);
  if (!status.available || status.version !== 'test') {
    throw new Error('FlareSolverr status endpoint was not detected');
  }
  const trawlStatus = await getTrawlStatus(baseUrl);
  if (!trawlStatus.available || trawlStatus.provider !== 'trawl') {
    throw new Error('TRAWL health endpoint was not detected');
  }

  const failingFlare = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ version: 'failing-flare' }));
      return;
    }
    response.end(JSON.stringify({ status: 'error', message: 'primary solver failed' }));
  });
  const trawlCalls = [];
  const trawlServer = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, version: 'trawl-test' }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    trawlCalls.push(payload);
    response.setHeader('Content-Type', 'application/json');
    if (payload.cmd === 'sessions.create') {
      response.end(JSON.stringify({ status: 'ok', session: payload.session }));
      return;
    }
    if (payload.cmd === 'sessions.destroy') {
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.end(JSON.stringify({
      status: 'ok',
      solution: {
        status: 200,
        url: payload.url,
        response: '<div>TRAWL fallback</div><span>Upload</span>',
        cookies: [],
      },
    }));
  });
  await new Promise(resolve => failingFlare.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => trawlServer.listen(0, '127.0.0.1', resolve));
  try {
    const failingAddress = failingFlare.address();
    const trawlAddress = trawlServer.address();
    process.env.FLARESOLVERR_URL = `http://127.0.0.1:${failingAddress.port}`;
    process.env.TRAWL_URL = `http://127.0.0.1:${trawlAddress.port}`;
    const fallbackResult = await fetchWithFlareSolverr(tracker, { username: 'user', password: 'unused' }, {
      cookieRaw: 'remember_token=session',
      timeoutMs: 5_000,
    });
    if (fallbackResult.provider !== 'trawl' || !fallbackResult.html.includes('TRAWL fallback')) {
      throw new Error('TRAWL must be tried when FlareSolverr fails');
    }
    if (!trawlCalls.some(call => call.cmd === 'request.get')) {
      throw new Error('TRAWL fallback did not receive the tracker request');
    }
  } finally {
    delete process.env.FLARESOLVERR_URL;
    delete process.env.TRAWL_URL;
    await new Promise(resolve => failingFlare.close(resolve));
    await new Promise(resolve => trawlServer.close(resolve));
  }

  if (!isFlareSolverrCandidate(new Error('Challenge anti-bot/Cloudflare affiche'))
    || isFlareSolverrCandidate(new Error('Identifiants invalides'))
    || isFlareSolverrCandidate(new Error('Aucune donnee extraite'))) {
    throw new Error('FlareSolverr fallback must remain limited to explicit anti-bot failures');
  }
  console.log('FlareSolverr checks OK: proxy, cookies, session lifecycle and extra fetch.');
} finally {
  await new Promise(resolve => server.close(resolve));
}
