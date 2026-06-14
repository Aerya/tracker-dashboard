import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { fetchUnreadMessages } from '../dist/fetcher.js';

const c411 = JSON.parse(fs.readFileSync(new URL('../config/trackers/c411.json', import.meta.url), 'utf8'));

const seen = [];
const count = await fetchUnreadMessages(c411, async (url, headers) => {
  seen.push({ url, headers });
  return { status: 200, body: JSON.stringify({ total: 4 }) };
}, { Authorization: 'Bearer test-token' });

assert.equal(count, 4);
assert.deepEqual(seen, [{
  url: 'https://c411.org/api/messages/unread-count',
  headers: { Authorization: 'Bearer test-token' },
}]);

const htmlTracker = {
  ...c411,
  fetch: {
    ...c411.fetch,
    unreadFetch: {
      url: 'notifications',
      responseType: 'html',
      regex: 'Inbox[^>]*>(?<value>\\d+)',
      transform: 'integer',
    },
  },
};

assert.equal(await fetchUnreadMessages(htmlTracker, async () => ({
  status: 200,
  body: '<div data-type="Inbox">2</div>',
}), {}), 2);

assert.equal(await fetchUnreadMessages(c411, async () => ({
  status: 503,
  body: 'indisponible',
}), {}), '');

assert.equal(await fetchUnreadMessages(c411, async () => {
  throw new Error('network');
}, {}), '');

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startIndex = indexHtml.indexOf(start);
  const endIndex = indexHtml.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `Source UI introuvable: ${start}`);
  assert.notEqual(endIndex, -1, `Fin de source UI introuvable: ${end}`);
  return indexHtml.slice(startIndex, endIndex);
}

const uiContext = {};
vm.runInNewContext([
  sourceBetween('  function hasStatValue', '  function formatCount'),
  sourceBetween('  function unreadMessagesCount', '  function mpBadge'),
  sourceBetween('  function mpBadge', '  // Notes d\'incident'),
].join('\n'), uiContext);

assert.equal(uiContext.unreadMessagesCount({ fields: { unreadMessages: 'un' } }), 1);
assert.equal(uiContext.mpBadge({ fields: { unreadMessages: 3 } }).includes('MP : 3'), true);
assert.equal(uiContext.mpBadge({ fields: { unreadMessages: 0 } }), '');
assert.equal(uiContext.mpBadge({ fields: {} }), '');

console.log('Unread message checks OK: authenticated requests, best-effort failures and badge visibility.');
