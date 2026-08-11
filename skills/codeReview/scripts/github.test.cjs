'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const gh = require('./github.cjs');
const { tempDir } = require('./test-helpers.cjs');

function repoWithRemote(t, url) {
  const dir = tempDir(t, 'cr-gh-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  if (url) run(['remote', 'add', 'origin', url]);
  return dir;
}

// A local server standing in for api.github.com, so the real request path -
// child process and all - is exercised without ever leaving the machine. It has
// to live in its OWN process: `request` blocks on execFileSync, and a server
// sharing this event loop would never get to accept the connection.
const stubSource = `
const http = require('http');
const status = Number(process.argv[2]);
const body = process.argv[3];
const s = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    process.stdout.write(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: data }) + '\\n');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
});
s.listen(0, '127.0.0.1', () => process.stdout.write('PORT=' + s.address().port + '\\n'));
`;

async function server(t, status, body) {
  const dir = tempDir(t, 'cr-srv-');
  const file = path.join(dir, 'stub.cjs');
  fs.writeFileSync(file, stubSource);
  const proc = spawn(process.execPath, [file, String(status), body], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => proc.kill());
  const lines = [];
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      lines.push(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
    }
  });
  const port = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const line = lines.find((l) => l.startsWith('PORT='));
      if (line) {
        clearInterval(poll);
        resolve(Number(line.slice(5)));
      } else if (Date.now() - started > 10000) {
        clearInterval(poll);
        reject(new Error('the stub server did not start'));
      }
    }, 10);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    // Called after a blocking request: give the pipe a turn to drain first.
    seen: async () => {
      await new Promise((r) => { setTimeout(r, 100); });
      return lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    },
  };
}

test('repoSlug reads owner and repo off every remote URL shape git writes', (t) => {
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, 'https://github.com/DohGE/claude.git')), { owner: 'DohGE', repo: 'claude' });
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, 'https://github.com/DohGE/claude')), { owner: 'DohGE', repo: 'claude' });
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, 'git@github.com:DohGE/claude.git')), { owner: 'DohGE', repo: 'claude' });
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, 'ssh://git@github.com/DohGE/claude.git')), { owner: 'DohGE', repo: 'claude' });
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, 'https://DohGE@github.com/DohGE/claude.git')), { owner: 'DohGE', repo: 'claude' });
});

test('repoSlug ignores repositories that are not on github.com', (t) => {
  assert.strictEqual(gh.repoSlug(repoWithRemote(t, 'git@gitlab.com:acme/repo.git')), null);
  assert.strictEqual(gh.repoSlug(repoWithRemote(t, 'https://bitbucket.org/acme/repo.git')), null);
  assert.strictEqual(gh.repoSlug(repoWithRemote(t, null)), null, 'no remote at all');
  assert.strictEqual(gh.repoSlug(tempDir(t, 'cr-nogit-')), null, 'not even a repository');
});

test('errorOf turns a refusal into something the reader can act on', () => {
  assert.strictEqual(gh.errorOf({ ok: true, status: 200 }, null), null);
  assert.match(gh.errorOf({ ok: false, status: 401 }, { message: 'Bad credentials' }), /Bad credentials.*GH_TOKEN/);
  assert.match(gh.errorOf({ ok: false, status: 403 }, { message: 'rate limit exceeded' }), /60\/h/);
  assert.match(gh.errorOf({ ok: false, status: 404 }, { message: 'Not Found' }), /cannot see this repository/);
  assert.strictEqual(gh.errorOf({ ok: false, status: 500 }, null), 'HTTP 500');
});

test('token prefers an explicit environment variable over anything stored', (t) => {
  const dir = tempDir(t, 'cr-token-');
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'env-token';
  t.after(() => {
    if (before === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = before;
  });
  assert.strictEqual(gh.token(dir), 'env-token');
});

test('credentialToken reads the password git hands back', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  // An isolated git config: the machine's real credential helper is invisible
  // here, so the fake one below is the only one asked.
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty };
  execFileSync('git', ['-C', dir, 'config', 'credential.helper', '!f() { echo username=x-access-token; echo password=stored-token; }; f'], { stdio: 'ignore' });
  assert.strictEqual(gh.credentialToken(dir, { env }), 'stored-token');
});

test('credentialToken returns nothing when no helper answers', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_TERMINAL_PROMPT: '0' };
  execFileSync('git', ['-C', dir, 'config', 'credential.helper', '!f() { :; }; f'], { stdio: 'ignore' });
  assert.strictEqual(gh.credentialToken(dir, { env }), null);
});

test('request round-trips a real call through the child process', async (t) => {
  const stub = await server(t, 201, JSON.stringify({ number: 7 }));
  const res = gh.request('.', { url: `${stub.base}/reviews`, method: 'POST', body: { event: 'COMMENT' }, token: 'secret-token' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.json, { number: 7 });
  assert.strictEqual(res.error, null);
  const [seen] = await stub.seen();
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.headers.authorization, 'Bearer secret-token', 'the token travels on stdin and lands in the header');
  assert.strictEqual(seen.body, '{"event":"COMMENT"}');
});

test('request reports a refusal instead of throwing', async (t) => {
  const stub = await server(t, 404, JSON.stringify({ message: 'Not Found' }));
  const res = gh.request('.', { url: `${stub.base}/repos/acme/repo`, token: null });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 404);
  assert.match(res.error, /Not Found/);
});

test('request survives an unreachable host', () => {
  // Port 1 on the loopback interface: nothing listens there, ever.
  const res = gh.request('.', { url: 'http://127.0.0.1:1/', token: null });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 0);
  assert.ok(res.error, 'a connection failure is an answer too');
});

test('request sends no Authorization header without a token', async (t) => {
  const stub = await server(t, 200, '[]');
  gh.request('.', { url: `${stub.base}/pulls`, token: null });
  const [seen] = await stub.seen();
  assert.strictEqual(seen.headers.authorization, undefined);
  assert.strictEqual(seen.headers['user-agent'], 'doh-codeReview');
});

// findOpenPr with an injected sender: the URLs it builds are the contract.
function sender(...responses) {
  const calls = [];
  const fn = (project, options) => {
    calls.push(options.path);
    return responses[calls.length - 1] || { ok: true, status: 200, json: [], text: '[]', error: null };
  };
  fn.calls = calls;
  return fn;
}

test('findOpenPr asks for the branch head and reports the PR it targets', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const send = sender({ ok: true, status: 200, json: [{ number: 12, html_url: 'u', base: { ref: 'develop' } }], error: null });
  const found = gh.findOpenPr(dir, 'feature/x', send);
  assert.deepStrictEqual(found.pr, { number: 12, url: 'u', base: 'develop' });
  assert.strictEqual(found.error, null);
  assert.strictEqual(send.calls.length, 1, 'the direct query answers, no scan needed');
  assert.match(send.calls[0], /^\/repos\/DohGE\/claude\/pulls\?state=open&per_page=1&head=DohGE%3Afeature%2Fx$/);
});

test('findOpenPr falls back to a scan for a pull request opened from a fork', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const send = sender(
    { ok: true, status: 200, json: [], error: null },
    { ok: true, status: 200, json: [{ number: 3, html_url: 'u3', head: { ref: 'other' }, base: { ref: 'main' } }, { number: 4, html_url: 'u4', head: { ref: 'feature/x' }, base: { ref: 'develop' } }], error: null },
  );
  const found = gh.findOpenPr(dir, 'feature/x', send);
  assert.deepStrictEqual(found.pr, { number: 4, url: 'u4', base: 'develop' });
  assert.match(send.calls[1], /per_page=100&sort=updated/);
});

test('findOpenPr reports no pull request, and a refusal separately', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  assert.deepStrictEqual(gh.findOpenPr(dir, 'feature/x', sender()).pr, null, 'both queries empty: simply no PR');
  const refused = gh.findOpenPr(dir, 'feature/x', sender({ ok: false, status: 401, json: null, error: 'Bad credentials' }));
  assert.strictEqual(refused.pr, null);
  assert.strictEqual(refused.error, 'Bad credentials');
});

test('findOpenPr asks nothing outside GitHub or without a branch', (t) => {
  const send = () => { throw new Error('must not be called'); };
  assert.deepStrictEqual(gh.findOpenPr(repoWithRemote(t, 'git@gitlab.com:a/b.git'), 'feature/x', send), { slug: null, pr: null, error: null });
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  assert.deepStrictEqual(gh.findOpenPr(dir, '', send).pr, null);
});

test('pullRequestDiff asks for the diff media type', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const seen = [];
  const send = (project, options) => {
    seen.push(options);
    return { ok: true, status: 200, text: 'diff --git a/x b/x\n', json: null, error: null };
  };
  const result = gh.pullRequestDiff(dir, { owner: 'DohGE', repo: 'claude' }, 12, send);
  assert.strictEqual(result.diff, 'diff --git a/x b/x\n');
  assert.strictEqual(seen[0].accept, 'application/vnd.github.v3.diff');
  assert.strictEqual(seen[0].path, '/repos/DohGE/claude/pulls/12');
});

test('postReview posts the review body to the pull request', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const seen = [];
  const send = (project, options) => {
    seen.push(options);
    return { ok: true, status: 200, json: {}, text: '{}', error: null };
  };
  const review = { event: 'COMMENT', body: 'x', comments: [] };
  assert.strictEqual(gh.postReview(dir, { owner: 'DohGE', repo: 'claude' }, 12, review, send).error, null);
  assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[0].path, '/repos/DohGE/claude/pulls/12/reviews');
  assert.deepStrictEqual(seen[0].body, review);
});
