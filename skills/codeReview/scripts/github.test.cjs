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
  // git keeps a trailing slash verbatim, so a remote added with one used to read as
  // no GitHub remote at all - the report then lost its PR button for no stated reason.
  assert.deepStrictEqual(gh.repoSlug(repoWithRemote(t, "https://github.com/DohGE/claude/")), { owner: "DohGE", repo: "claude" });
});

test('repoSlug picks origin, not whichever remote git lists first', (t) => {
  const dir = tempDir(t, 'cr-gh-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  // git prints its remotes alphabetically, so "fork" comes out above "origin" - and
  // the first github.com line used to win. Everything downstream (which pull request
  // is open, whose diff is fetched, where the review is posted) then addressed the
  // fork instead of the repository the branch actually belongs to.
  run(['remote', 'add', 'fork', 'https://github.com/someone-else/claude.git']);
  run(['remote', 'add', 'origin', 'https://github.com/DohGE/claude.git']);
  assert.deepStrictEqual(gh.repoSlug(dir), { owner: 'DohGE', repo: 'claude' });

  // With no origin at all the first github.com remote is still the best answer there is.
  const noOrigin = tempDir(t, 'cr-gh-');
  const run2 = (args) => execFileSync('git', ['-C', noOrigin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run2(['init', '-q', '-b', 'main']);
  run2(['remote', 'add', 'upstream', 'https://github.com/acme/repo.git']);
  assert.deepStrictEqual(gh.repoSlug(noOrigin), { owner: 'acme', repo: 'repo' });
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

test('credentialToken takes the token out of the username when the password is the sentinel', (t) => {
  // The OAuth-over-Basic convention: token in the username, the fixed string
  // `x-oauth-basic` in the password. Returning the sentinel sends a value that can
  // never authenticate, and the 401 then blames a store holding a good token.
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty };
  execFileSync('git', ['-C', dir, 'config', 'credential.helper',
    '!f() { echo username=ghp_stored; echo password=x-oauth-basic; }; f'], { stdio: 'ignore' });
  assert.strictEqual(gh.credentialToken(dir, { env }), 'ghp_stored');
});

test('credentialToken returns nothing when no helper answers', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_TERMINAL_PROMPT: '0' };
  execFileSync('git', ['-C', dir, 'config', 'credential.helper', '!f() { :; }; f'], { stdio: 'ignore' });
  assert.strictEqual(gh.credentialToken(dir, { env }), null);
});

// A credential helper that records what git asked it for, so the test can prove
// the query carried the repository path - the shape `credential.useHttpPath=true`
// setups need in order to match anything at all.
// A credential helper that records what git asked it for. `answer` is shell run
// after the request was captured, with $LAST holding that one request, so a
// helper can decide what to say based on what it was asked. Git refuses a reply
// that carries no username, so every answer here has to supply one.
// `useHttpPath` matters: git strips `path=` before the helper sees it unless the
// repository asked for path-scoped credentials, which is the whole reason
// credentialToken sends the path at all.
function recordingHelper(t, dir, answer, useHttpPath = false) {
  const log = path.join(dir, 'asked.txt').replace(/\\/g, '/');
  const last = path.join(dir, 'last.txt').replace(/\\/g, '/');
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const config = (key, value) => execFileSync('git', ['-C', dir, 'config', key, value], { stdio: 'ignore' });
  config('credential.helper', `!f() { LAST="${last}"; cat > "$LAST"; cat "$LAST" >> "${log}"; ${answer} }; f`);
  config('credential.useHttpPath', String(useHttpPath));
  return { log, env: { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_TERMINAL_PROMPT: '0' } };
}

test('credentialToken sends the repository path, which is all a useHttpPath store matches on', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const { log, env } = recordingHelper(t, dir, 'echo username=x-access-token; echo password=stored-token;', true);
  assert.strictEqual(gh.credentialToken(dir, { env }), 'stored-token');
  assert.match(fs.readFileSync(log, 'utf8'), /path=DohGE\/claude\.git/,
    'without the path such a store has nothing to match and the review finds no token at all');
});

test('credentialToken retries without the path when the path-scoped lookup is empty', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  // Answers only the query that carries no path, which is how a host-scoped
  // store behaves when it is asked about one particular path.
  const { log, env } = recordingHelper(t, dir,
    'case "$(cat "$LAST")" in *path=*) ;; *) echo username=x-access-token; echo password=host-token;; esac;', true);
  assert.strictEqual(gh.credentialToken(dir, { env }), 'host-token');
  const asked = fs.readFileSync(log, 'utf8');
  assert.ok(asked.includes('path=DohGE/claude.git'), 'the path query is tried first');
  assert.strictEqual(asked.split('host=github.com').length - 1, 2, 'and the bare host query follows it');
});

test('netrcToken reads the github.com entry out of either netrc filename', (t) => {
  const home = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(home, '.netrc'), 'machine gitlab.com login a password wrong\nmachine github.com login me password netrc-token\n');
  assert.strictEqual(gh.netrcToken({ home }), 'netrc-token');

  const winHome = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(winHome, '_netrc'), 'machine github.com\n  login me\n  password win-token\n');
  assert.strictEqual(gh.netrcToken({ home: winHome }), 'win-token', 'Windows spells the file _netrc');

  assert.strictEqual(gh.netrcToken({ home: tempDir(t, 'cr-netrc-') }), null, 'no file, no token');
});

test('an explicit github.com entry outranks a default one, wherever it sits', (t) => {
  // `default` is netrc's catch-all. Taking whichever entry came first would hand
  // GitHub another service's secret, and the refusal that follows would point the
  // reader straight at the github.com line - the one that is not the problem.
  const home = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(home, '.netrc'),
    'default login u password catch-all' + String.fromCharCode(10) + 'machine github.com login me password gh-token' + String.fromCharCode(10));
  assert.strictEqual(gh.netrcToken({ home }), 'gh-token');

  const only = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(only, '.netrc'), 'default login u password catch-all' + String.fromCharCode(10));
  assert.strictEqual(gh.netrcToken({ home: only }), 'catch-all', 'with no github.com entry the catch-all still answers');
});

test('netrcToken reads the api.github.com entry, which is the host it calls', (t) => {
  const NL = String.fromCharCode(10);
  // Every request this module makes goes to https://api.github.com, and that is the
  // machine a netrc written for the API names - it is what `curl --netrc` matches.
  // Reading only `github.com` left that token unread.
  const api = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(api, '.netrc'), 'machine api.github.com' + NL + '  login me' + NL + '  password api-token' + NL);
  assert.strictEqual(gh.netrcToken({ home: api }), 'api-token');

  // And the worse half: with a catch-all present, the API token being invisible meant
  // ANOTHER SERVICE'S secret went to GitHub while the right one sat in the same file.
  const both = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(both, '.netrc'),
    'default login anon password catch-all' + NL + 'machine api.github.com login me password api-token' + NL);
  assert.strictEqual(gh.netrcToken({ home: both }), 'api-token', 'an explicit GitHub entry outranks the catch-all');

  // With both GitHub spellings present the API host is the more specific answer for
  // a caller that talks to the API.
  const pair = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(pair, '.netrc'),
    'machine github.com login me password web-token' + NL + 'machine api.github.com login me password api-token' + NL);
  assert.strictEqual(gh.netrcToken({ home: pair }), 'api-token');

  // File order must not decide it.
  const reversed = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(reversed, '.netrc'),
    'machine api.github.com login me password api-token' + NL + 'machine github.com login me password web-token' + NL);
  assert.strictEqual(gh.netrcToken({ home: reversed }), 'api-token');
});

test('netrcToken ignores a machine that is not github.com', (t) => {
  const home = tempDir(t, 'cr-netrc-');
  fs.writeFileSync(path.join(home, '.netrc'), 'machine example.com login me password nope\n');
  assert.strictEqual(gh.netrcToken({ home }), null);
});

test('ghConfigToken reads the token gh stored without running gh', (t) => {
  const configDir = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(configDir, 'hosts.yml'), [
    'github.com:',
    '    users:',
    '        DohGE:',
    '            oauth_token: user-scoped-token',
    '    git_protocol: https',
    '    oauth_token: hosts-token',
    '',
  ].join('\n'));
  assert.strictEqual(gh.ghConfigToken({ configDir }), 'user-scoped-token');

  const bare = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(bare, 'hosts.yml'), 'github.com:\n    oauth_token: hosts-token\n');
  assert.strictEqual(gh.ghConfigToken({ configDir: bare }), 'hosts-token');

  assert.strictEqual(gh.ghConfigToken({ configDir: tempDir(t, 'cr-ghcfg-') }), null);
});

test('ghConfigToken picks the account gh has active, not the first one listed', (t) => {
  // gh 2.x signs several accounts in at once. Reading whichever oauth_token comes
  // first would authenticate as the wrong one on a work+personal machine, and the
  // 404 that follows on a private repo reads as a bad token rather than as the
  // wrong account - the one failure the token-source message cannot explain.
  const configDir = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(configDir, 'hosts.yml'), [
    'github.com:',
    '    users:',
    '        work-account:',
    '            oauth_token: work-token',
    '        personal-account:',
    '            oauth_token: personal-token',
    '    git_protocol: https',
    '    user: personal-account',
    '    oauth_token: legacy-copy',
    '',
  ].join(String.fromCharCode(10)));
  assert.strictEqual(gh.ghConfigToken({ configDir }), 'personal-token');

  // No `user:` to resolve and more than one account: the host-level copy is what gh
  // keeps in step with the active account, so it beats guessing between the two.
  const ambiguous = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(ambiguous, 'hosts.yml'), [
    'github.com:',
    '    users:',
    '        a:',
    '            oauth_token: a-token',
    '        b:',
    '            oauth_token: b-token',
    '    oauth_token: host-copy',
    '',
  ].join(String.fromCharCode(10)));
  assert.strictEqual(gh.ghConfigToken({ configDir: ambiguous }), 'host-copy');
});

test('ghConfigToken hands over no token rather than a stranger token', (t) => {
  // gh stores the token in the system keychain by default, leaving the account named in
  // hosts.yml with no oauth_token under it. An account signed in earlier, before that
  // default, still has its token sitting in the file. Falling through to it would post the
  // review as a person who never ran it - the one wrong answer worse than having none,
  // because it cannot be read off the failure. Reporting nothing lets the env or the netrc
  // answer instead, and lets the token-source message say plainly that nothing authorises.
  const configDir = tempDir(t, "cr-ghcfg-");
  fs.writeFileSync(path.join(configDir, "hosts.yml"), [
    'github.com:',
    '    users:',
    '        active-account:',
    '        retired-account:',
    '            oauth_token: retired-token',
    '    git_protocol: https',
    '    user: active-account',
    '    oauth_token: legacy-copy',
    '',
  ].join(String.fromCharCode(10)));
  assert.strictEqual(gh.ghConfigToken({ configDir }), null, 'the retired account never stands in');

  // Same rule when the active account is missing from the map altogether: the map is the
  // file saying it tracks tokens per account, so a token under another name is not ours.
  const unlisted = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(unlisted, 'hosts.yml'), [
    'github.com:',
    '    users:',
    '        somebody-else:',
    '            oauth_token: their-token',
    '    user: active-account',
    '',
  ].join(String.fromCharCode(10)));
  assert.strictEqual(gh.ghConfigToken({ configDir: unlisted }), null);

  // A named account with no map at all predates per-account storage, so the host-level
  // token is that account own and stays readable - this rule narrows nothing else.
  const legacy = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(legacy, 'hosts.yml'), [
    'github.com:',
    '    user: active-account',
    '    oauth_token: legacy-token',
    '',
  ].join(String.fromCharCode(10)));
  assert.strictEqual(gh.ghConfigToken({ configDir: legacy }), 'legacy-token');
});

test('ghConfigToken stays out of another host section', (t) => {
  const configDir = tempDir(t, 'cr-ghcfg-');
  fs.writeFileSync(path.join(configDir, 'hosts.yml'), 'ghe.example.com:\n    oauth_token: enterprise-token\n');
  assert.strictEqual(gh.ghConfigToken({ configDir }), null, 'only github.com is addressed by this script');
});

test('tokenWithSource names where the token came from', (t) => {
  const dir = tempDir(t, 'cr-src-');
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'env-token';
  t.after(() => {
    if (before === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = before;
  });
  const found = gh.tokenWithSource(dir);
  assert.strictEqual(found.token, 'env-token');
  assert.strictEqual(found.source, 'GH_TOKEN');
});

test('tokenWithSource reports every place it looked when nothing answers', (t) => {
  // A repository with a helper that answers nothing and an isolated git config:
  // the machine's real credential store must never be reachable from a test.
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const { env } = recordingHelper(t, dir, ':;');
  const empty = tempDir(t, 'cr-src-');
  const none = gh.tokenWithSource(dir, { env: { ...env, GH_TOKEN: '', GITHUB_TOKEN: '' }, home: empty, configDir: empty, skipCli: true });
  assert.strictEqual(none.token, null);
  assert.strictEqual(none.source, null);
  assert.deepStrictEqual(none.tried, ['GH_TOKEN', 'GITHUB_TOKEN', 'git credential', '.netrc', 'konfiguracja gh', 'gh CLI'],
    'the report names every place that was looked in, in order');
});

test('findOpenPr carries the token source so a refusal can name it', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const send = () => ({ ok: false, status: 404, json: { message: 'Not Found' }, error: 'Not Found - not found, or the token cannot see this repository' });
  const findToken = () => ({ token: null, source: null, tried: ['GH_TOKEN', 'git credential'] });
  const res = gh.findOpenPr(dir, 'feature', send, findToken);
  assert.strictEqual(res.pr, null);
  assert.strictEqual(res.tokenSource, null);
  assert.deepStrictEqual(res.triedTokenSources, ['GH_TOKEN', 'git credential']);

  const withToken = gh.findOpenPr(dir, 'feature', send, () => ({ token: 't', source: 'git credential', tried: ['GH_TOKEN', 'git credential'] }));
  assert.strictEqual(withToken.tokenSource, 'git credential', 'a refused token has to be nameable');
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
  const send = sender({ ok: true, status: 200, json: [{ number: 12, html_url: 'u', title: 'Panel użytkownika', base: { ref: 'develop' } }], error: null });
  const found = gh.findOpenPr(dir, 'feature/x', send);
  // The title travels with the number: the report header names the pull request, not only its branch.
  assert.deepStrictEqual(found.pr, { number: 12, url: 'u', base: 'develop', title: 'Panel użytkownika' });
  assert.strictEqual(found.error, null);
  assert.strictEqual(send.calls.length, 1, 'the direct query answers, no scan needed');
  assert.match(send.calls[0], /^\/repos\/DohGE\/claude\/pulls\?state=open&per_page=1&head=DohGE%3Afeature%2Fx$/);
});

test('findOpenPr falls back to a scan for a pull request opened from a fork', (t) => {
  const dir = repoWithRemote(t, 'https://github.com/DohGE/claude.git');
  const send = sender(
    { ok: true, status: 200, json: [], error: null },
    { ok: true, status: 200, json: [{ number: 3, html_url: 'u3', head: { ref: 'other' }, base: { ref: 'main' } }, { number: 4, html_url: 'u4', title: 'Fork fix', head: { ref: 'feature/x' }, base: { ref: 'develop' } }], error: null },
  );
  const found = gh.findOpenPr(dir, 'feature/x', send);
  assert.deepStrictEqual(found.pr, { number: 4, url: 'u4', base: 'develop', title: 'Fork fix' });
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
  assert.deepStrictEqual(gh.findOpenPr(repoWithRemote(t, 'git@gitlab.com:a/b.git'), 'feature/x', send),
    { slug: null, pr: null, error: null, tokenSource: null, triedTokenSources: [] },
    'a repository outside GitHub never reaches a credential store either');
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
