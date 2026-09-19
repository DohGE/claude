'use strict';

const test = require('node:test');
const assert = require('node:assert');

const api = require('./pr-api.cjs');

const slug = { owner: 'acme', repo: 'app' };

function ok(json) {
  return { ok: true, status: 200, text: JSON.stringify(json), json, error: null };
}

function fail(status, error) {
  return { ok: false, status, text: '', json: null, error };
}

// A queued sender: every call shifts the next prepared response and records what
// was asked for, so a test can assert on the query AND on the paging.
function sender(...responses) {
  const queue = [...responses];
  const calls = [];
  const send = (project, options) => {
    calls.push(options);
    if (!queue.length) throw new Error(`unexpected request: ${options.url || options.path}`);
    return queue.shift();
  };
  send.calls = calls;
  return send;
}

function threadNode(over = {}) {
  return Object.assign({
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    path: 'src/a.ts',
    line: 12,
    startLine: null,
    originalLine: 12,
    originalStartLine: null,
    diffSide: 'RIGHT',
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ databaseId: 5, url: 'u', createdAt: 'd', body: 'fix this', diffHunk: '@@', author: { login: 'ann' } }] },
  }, over);
}

function threadsPage(nodes, hasNextPage = false, endCursor = null) {
  return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });
}

test('graphql reports a transport failure', () => {
  const { data, error } = api.graphql('/p', 'query{x}', {}, sender(fail(401, 'token rejected')));
  assert.strictEqual(data, null);
  assert.match(error, /token rejected/);
});

// The whole reason this layer exists: GraphQL answers a rejected query with
// HTTP 200. Reading `res.ok` alone would report success and hand the caller no
// threads, which reads as "this pull request has no comments".
test('graphql treats a 200 carrying errors as a failure', () => {
  const body = { data: null, errors: [{ message: 'Resource not accessible' }, { message: 'and another' }] };
  const { data, error } = api.graphql('/p', 'query{x}', {}, sender(ok(body)));
  assert.strictEqual(data, null);
  assert.strictEqual(error, 'Resource not accessible; and another');
});

test('graphql posts the query and variables to the GraphQL endpoint', () => {
  const send = sender(ok({ data: { ping: 1 } }));
  api.graphql('/p', 'query($a:Int){ping(a:$a)}', { a: 2 }, send);
  assert.strictEqual(send.calls[0].url, 'https://api.github.com/graphql');
  assert.strictEqual(send.calls[0].method, 'POST');
  assert.deepStrictEqual(send.calls[0].body.variables, { a: 2 });
});

test('reviewThreads keeps resolved threads in the list and flags none as truncated', () => {
  const send = sender(threadsPage([threadNode(), threadNode({ id: 'T2', isResolved: true })]));
  const { threads, error, truncated } = api.reviewThreads('/p', slug, 7, send);
  assert.strictEqual(error, null);
  assert.strictEqual(truncated, false);
  assert.deepStrictEqual(threads.map((t) => [t.id, t.isResolved]), [['T1', false], ['T2', true]]);
  assert.strictEqual(threads[0].comments[0].author, 'ann');
  assert.strictEqual(send.calls[0].body.variables.number, 7);
});

test('reviewThreads pages until hasNextPage stops', () => {
  const send = sender(
    threadsPage([threadNode()], true, 'CUR1'),
    threadsPage([threadNode({ id: 'T2' })]),
  );
  const { threads, truncated } = api.reviewThreads('/p', slug, 7, send);
  assert.deepStrictEqual(threads.map((t) => t.id), ['T1', 'T2']);
  assert.strictEqual(truncated, false);
  assert.strictEqual(send.calls[0].body.variables.cursor, null);
  assert.strictEqual(send.calls[1].body.variables.cursor, 'CUR1');
});

// An outdated thread has no current line. Collapsing that into a number would
// point the fixer at whatever now sits on line 12 of a file that moved.
test('reviewThreads keeps a null current line apart from the original one', () => {
  const send = sender(threadsPage([threadNode({ isOutdated: true, line: null, originalLine: 41 })]));
  const [thread] = api.reviewThreads('/p', slug, 7, send).threads;
  assert.strictEqual(thread.isOutdated, true);
  assert.strictEqual(thread.line, null);
  assert.strictEqual(thread.originalLine, 41);
});

test('reviewThreads fetches the comments past a thread first page', () => {
  const first = threadNode({
    comments: {
      pageInfo: { hasNextPage: true, endCursor: 'C1' },
      nodes: [{ databaseId: 1, body: 'first', author: { login: 'ann' } }],
    },
  });
  const send = sender(
    threadsPage([first]),
    ok({ data: { node: { comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: 2, body: 'and the actual ask', author: { login: 'ann' } }] } } } }),
  );
  const [thread] = api.reviewThreads('/p', slug, 7, send).threads;
  assert.deepStrictEqual(thread.comments.map((c) => c.body), ['first', 'and the actual ask']);
  assert.strictEqual(thread.commentsTruncated, undefined);
});

test('reviewThreads returns what it has and marks truncation when a page fails', () => {
  const send = sender(threadsPage([threadNode()], true, 'CUR1'), fail(502, 'bad gateway'));
  const { threads, error, truncated } = api.reviewThreads('/p', slug, 7, send);
  assert.strictEqual(threads.length, 1);
  assert.strictEqual(truncated, true);
  assert.match(error, /bad gateway/);
});

test('reviewThreads refuses a response that carries no pull request', () => {
  const { error, truncated } = api.reviewThreads('/p', slug, 7, sender(ok({ data: { repository: null } })));
  assert.match(error, /no review threads for pull request #7/);
  assert.strictEqual(truncated, true);
});

test('resolveThread reports success, refusal and a thread that stayed open', () => {
  const okRes = api.resolveThread('/p', 'T1', sender(ok({ data: { resolveReviewThread: { thread: { id: 'T1', isResolved: true } } } })));
  assert.deepStrictEqual(okRes, { resolved: true, error: null });

  const stillOpen = api.resolveThread('/p', 'T1', sender(ok({ data: { resolveReviewThread: { thread: { id: 'T1', isResolved: false } } } })));
  assert.strictEqual(stillOpen.resolved, false);
  assert.match(stillOpen.error, /still unresolved/);

  const refused = api.resolveThread('/p', 'T1', sender(ok({ errors: [{ message: 'must be a collaborator' }] })));
  assert.strictEqual(refused.resolved, false);
  assert.match(refused.error, /collaborator/);
});

test('issueComments drops empty bodies, flags bots and pages', () => {
  const page = (n, count) => ok(Array.from({ length: count }, (_, i) => ({
    id: n * 1000 + i, body: `c${i}`, user: { login: 'ann', type: 'User' }, created_at: 'd', html_url: 'u',
  })));
  const full = page(1, 100).json;
  full[0].body = '   ';
  full[1].user = { login: 'ci[bot]', type: 'Bot' };
  const send = sender(ok(full), ok([{ id: 9, body: 'last', user: { login: 'bob', type: 'User' } }]));
  const { comments, error } = api.issueComments('/p', slug, 7, send);
  assert.strictEqual(error, null);
  assert.strictEqual(comments.length, 100);
  assert.strictEqual(comments[0].isBot, true);
  assert.strictEqual(comments.at(-1).body, 'last');
  assert.match(send.calls[0].path, /issues\/7\/comments\?per_page=100&page=1/);
});

test('reviewBodies drops empty and PENDING reviews', () => {
  const send = sender(ok([
    { id: 1, body: '', state: 'APPROVED', user: { login: 'ann' } },
    { id: 2, body: 'draft thought', state: 'PENDING', user: { login: 'ann' } },
    { id: 3, body: 'please split this service', state: 'CHANGES_REQUESTED', user: { login: 'bob', type: 'User' } },
  ]));
  const { reviews, error } = api.reviewBodies('/p', slug, 7, send);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(reviews.map((r) => r.id), [3]);
  assert.strictEqual(reviews[0].state, 'CHANGES_REQUESTED');
});

test('issueComments surfaces a refusal instead of reporting an empty list', () => {
  const { comments, error } = api.issueComments('/p', slug, 7, sender(fail(403, 'rate limited')));
  assert.deepStrictEqual(comments, []);
  assert.match(error, /rate limited/);
});

test('a resolved thread costs no extra round trip for comments nobody will read', () => {
  const resolved = threadNode({
    id: 'T-done',
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: true, endCursor: 'C1' },
      nodes: [{ databaseId: 1, body: 'long argument', author: { login: 'ann' } }],
    },
  });
  // One response only: a second request would throw "unexpected request".
  const send = sender(threadsPage([resolved]));
  const [thread] = api.reviewThreads('/p', slug, 7, send).threads;
  assert.strictEqual(send.calls.length, 1);
  assert.strictEqual(thread.comments.length, 1);
  // The list IS short, and the thread says so rather than passing for complete.
  assert.match(thread.commentsTruncated, /resolved/);
});

test('an unresolved thread still gets its tail, resolved neighbours notwithstanding', () => {
  const open = threadNode({
    id: 'T-open',
    comments: {
      pageInfo: { hasNextPage: true, endCursor: 'C1' },
      nodes: [{ databaseId: 1, body: 'first', author: { login: 'ann' } }],
    },
  });
  const done = threadNode({ id: 'T-done', isResolved: true });
  const send = sender(
    threadsPage([done, open]),
    ok({ data: { node: { comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: 2, body: 'the ask', author: { login: 'ann' } }] } } } }),
  );
  const { threads } = api.reviewThreads('/p', slug, 7, send);
  assert.strictEqual(send.calls.length, 2);
  assert.deepStrictEqual(threads[1].comments.map((c) => c.body), ['first', 'the ask']);
});

test('a REST list that runs out of pages says the answer is short', () => {
  const fullPage = () => ok(Array.from({ length: 100 }, (_, i) => ({
    id: i, body: `c${i}`, user: { login: 'ann', type: 'User' },
  })));
  // 40 full pages: the cap, and never a short one to end on.
  const send = sender(...Array.from({ length: 40 }, fullPage));
  const { comments, error, truncated } = api.issueComments('/p', slug, 7, send);
  assert.strictEqual(error, null);
  assert.strictEqual(truncated, true);
  assert.strictEqual(comments.length, 4000);
});

test('a REST list that ends on a short page is complete, and says so', () => {
  const send = sender(ok([{ id: 1, body: 'only', user: { login: 'ann', type: 'User' } }]));
  const { truncated, error } = api.reviewBodies('/p', slug, 7, send);
  assert.strictEqual(error, null);
  assert.strictEqual(truncated, false);
});
