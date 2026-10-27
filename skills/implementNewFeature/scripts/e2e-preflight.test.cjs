'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');

const { preflight, missingLocalConfig, portFree, reachable } = require('./e2e-preflight.cjs');

test('a worktree without the checkout\'s local config is named before any server starts', () => {
  const listing = { '/main': 'proxy.dpx.local.js\n.env\nnode_modules/\nsrc/env.local.ts\n.claude/settings.local.json\n', '/wt': '.env\n' };
  assert.deepStrictEqual(missingLocalConfig('/main', '/wt', (dir) => listing[dir]), ['proxy.dpx.local.js', 'src/env.local.ts']);
});

test('every problem is collected, and a clean run is OK', async () => {
  const problems = await preflight({ root: '/wt', project: '/main', port: 4317, urls: ['http://127.0.0.1:3000'], fix: false }, {
    missing: () => ['proxy.dpx.local.js'], portFree: async () => false, reachable: async () => 'ECONNREFUSED',
  });
  assert.strictEqual(problems.length, 3);
  assert.match(problems[0], /missing local config proxy\.dpx\.local\.js/);
  assert.match(problems[1], /port 4317 is taken/);
  assert.match(problems[2], /unreachable http:\/\/127\.0\.0\.1:3000 \(ECONNREFUSED\)/);
  let copied = 0;
  assert.deepStrictEqual(await preflight({ root: '/wt', project: '/main', port: 0, urls: [], fix: true }, {
    copyEnv: () => { copied++; }, copyLocal: () => { copied++; }, missing: () => [],
  }), []);
  assert.strictEqual(copied, 2, '--fix copies before it checks');
});

test('a taken port and a dead URL are told from a free port and a live one', async (t) => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  assert.strictEqual(await portFree(busy.address().port), false);
  const web = http.createServer((req, res) => { res.statusCode = 401; res.end(); });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(() => web.close());
  assert.strictEqual(await reachable(`http://127.0.0.1:${web.address().port}/nodes`), null, 'a 401 is an answer');
  const port = busy.address().port;
  await new Promise((resolve) => busy.close(resolve));
  assert.strictEqual(await portFree(port), true);
  assert.ok(await reachable(`http://127.0.0.1:${port}/`), 'nothing listening is a reason');
});
