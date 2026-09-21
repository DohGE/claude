#!/usr/bin/env node
'use strict';

// GitHub REST access for the codeReview scripts, with no `gh` CLI in the way:
// the pull request a branch has open, the diff of that pull request, and the
// review posted back to it.
//
// Everything around this module is synchronous (execFileSync all the way down)
// while `fetch` is not, so the request itself runs in a child copy of this very
// file: the parent hands it a JSON request on stdin and reads the JSON response
// off stdout. One network primitive in one place beats turning three
// synchronous scripts async for a single call each.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const apiRoot = 'https://api.github.com';
const apiVersion = '2022-11-28';
const userAgent = 'doh-codeReview';
const requestTimeoutMs = 20000;
const maxResponseBytes = 64 * 1024 * 1024;

function run(file, args, options) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8', maxBuffer: maxResponseBytes, stdio: ['pipe', 'pipe', 'ignore'], ...options,
    });
  } catch (err) {
    return null;
  }
}

function git(project, args) {
  const out = run('git', ['-C', project, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  return out === null ? null : out.trim();
}

// owner/repo read off the remote URL itself - no CLI and no API call needed to
// know which repository this is. Both URL shapes git uses are accepted; only
// github.com counts, because api.github.com is the only host addressed here.
// `origin` wins when it is one of them. `git remote -v` prints its remotes in
// ALPHABETICAL order, so taking the first github.com line resolved a checkout that
// also has a `fork` remote to the fork - and everything downstream (which pull
// request is open, whose diff is fetched, where the review is posted) then aimed at
// the wrong repository. Every other script here already speaks in terms of
// `origin/<branch>`, so that is the remote they all mean.
function repoSlug(project) {
  let fallback = null;
  for (const line of String(git(project, ['remote', '-v']) || '').split('\n')) {
    const name = line.split(/\s+/)[0] || '';
    const url = line.split(/\s+/)[1] || '';
    // The trailing slash is the one shape git keeps verbatim but the pattern used to
    // refuse: `git remote add origin https://github.com/acme/repo/` then read as no
    // GitHub remote at all, which is the opposite of what the message would say.
    const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!m) continue;
    const slug = { owner: m[1], repo: m[2] };
    if (name === 'origin') return slug;
    if (!fallback) fallback = slug;
  }
  return fallback;
}

// The API token, in the order that asks the least of the user. Each source is
// named, because a review that could not reach GitHub has to be able to say
// whether it failed for want of a token or because the token it did find was
// refused - the two look identical from the outside, and only one of them is
// fixed by setting GH_TOKEN. Nothing here is ever logged, and no token travels
// on a command line: the request child receives it on stdin.
const tokenSources = [
  { name: 'GH_TOKEN', find: (project, o) => (o.env || process.env).GH_TOKEN || null },
  { name: 'GITHUB_TOKEN', find: (project, o) => (o.env || process.env).GITHUB_TOKEN || null },
  { name: 'git credential', find: (project, o) => credentialToken(project, o.env ? { env: o.env } : {}) },
  { name: '.netrc', find: (project, o) => netrcToken(o) },
  { name: 'konfiguracja gh', find: (project, o) => ghConfigToken(o) },
  { name: 'gh CLI', find: (project, o) => (o.skipCli ? null : ghToken(project)) },
];

const tokenCache = new Map();
function tokenWithSource(project, options = {}) {
  const cacheable = !Object.keys(options).length;
  if (cacheable && tokenCache.has(project)) return tokenCache.get(project);
  const tried = [];
  let found = { token: null, source: null, tried };
  for (const source of tokenSources) {
    tried.push(source.name);
    const value = source.find(project, options);
    if (value) { found = { token: value, source: source.name, tried }; break; }
  }
  if (cacheable) tokenCache.set(project, found);
  return found;
}

function token(project) {
  return tokenWithSource(project).token;
}

// Two queries, because a credential store can be keyed either way: with the
// repository path, which is the only shape `credential.useHttpPath=true` setups
// match, and then without it, which is what a plain host-scoped store holds.
// `credential.interactive=false` keeps a missing credential from popping a GUI
// prompt in the middle of a review. `options` is the seam the tests use to point
// git at an isolated config, so no test ever reaches the real store.
function credentialToken(project, options = {}) {
  const slug = repoSlug(project);
  const queries = [];
  if (slug) queries.push(`protocol=https\nhost=github.com\npath=${slug.owner}/${slug.repo}.git\n\n`);
  queries.push('protocol=https\nhost=github.com\n\n');
  for (const input of queries) {
    const out = run('git', ['-C', project, '-c', 'credential.interactive=false', 'credential', 'fill'], {
      input, timeout: requestTimeoutMs, ...options,
    });
    const fields = new Map(String(out || '').split(/\r?\n/)
      .map((l) => l.match(/^([a-z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]));
    const password = fields.get('password') || '';
    // The OAuth-over-Basic convention puts the TOKEN in the username and the fixed
    // string `x-oauth-basic` in the password - hub wrote credentials that way and
    // stores set up back then still hold them. Returning the sentinel sends a value
    // that can never authenticate, and the 401 then blames a credential store that
    // holds a perfectly good token.
    if (/^x-oauth-basic$/i.test(password)) {
      const username = fields.get('username') || '';
      if (username) return username;
      continue;
    }
    if (password) return password;
  }
  return null;
}

// The classic token file, and the one an SSH-cloned repository can still carry:
// nothing about `git@github.com:` remotes ever writes an HTTPS credential, so
// for those this is the first place that can answer at all. Both spellings are
// read, because Windows writes `_netrc`.
function netrcToken(options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  for (const name of ['.netrc', '_netrc']) {
    let text;
    try {
      text = fs.readFileSync(path.join(home, name), 'utf8');
    } catch (err) {
      continue;
    }
    // netrc is one flat stream of whitespace-separated words, so the entry ends
    // wherever the next `machine` begins - line breaks carry no meaning.
    const words = text.split(/\s+/).filter(Boolean);
    // Three pools, ranked by how specifically an entry answers THIS caller:
    // `api.github.com` is the host the requests actually go to and the one a netrc
    // written for the API names; `github.com` is what a git credential is filed under;
    // `default` is netrc's catch-all and only answers when neither is present.
    // The ranking is the point, not a nicety: taking whichever entry came first, or
    // reading only `github.com`, sends ANOTHER SERVICE'S catch-all secret to GitHub while
    // the right token sits in the file unread. Within one pool the first password wins,
    // which is netrc's own rule.
    const found = { api: null, web: null, fallback: null };
    let entry = null;
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'machine' || words[i] === 'default') {
        if (words[i] === 'default') entry = 'fallback';
        else if (words[i + 1] === 'api.github.com') entry = 'api';
        else if (words[i + 1] === 'github.com') entry = 'web';
        else entry = null;
        continue;
      }
      if (!entry || words[i] !== 'password' || !words[i + 1]) continue;
      if (found[entry] === null) found[entry] = words[i + 1];
    }
    const token = found.api || found.web || found.fallback;
    if (token !== null) return token;
  }
  return null;
}

// gh keeps its token in a file, so a repository whose owner once ran `gh auth
// login` stays reachable even when the binary is not on PATH - a fresh machine
// restored from a config backup, or a PATH the review did not inherit.
function ghConfigToken(options = {}) {
  const dirs = options.configDir ? [options.configDir] : [
    process.env.GH_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'gh'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'GitHub CLI'),
    (process.env.HOME || process.env.USERPROFILE) && path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'gh'),
  ].filter(Boolean);
  for (const dir of dirs) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8');
    } catch (err) {
      continue;
    }
    // Only the github.com block counts, and it runs until the next line that
    // starts in column zero. Reaching for a YAML parser to read one key out of
    // a file gh writes itself is not worth a dependency.
    const lines = String(text).split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === 'github.com:');
    if (start === -1) continue;
    // gh 2.x signs in several accounts at once: each gets its own `oauth_token`
    // under `users:`, and the host block repeats the ACTIVE one. Reading whichever
    // comes first signs a two-account machine in as whoever `users:` happens to list
    // first, and the refusal that follows reads as a bad token rather than as the
    // wrong account - so the account `user:` names wins when it can be resolved.
    const block = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() && !/^\s/.test(lines[i])) break;
      if (lines[i].trim()) block.push(lines[i]);
    }
    const indentOf = (line) => line.match(/^\s*/)[0].length;
    const base = block.length ? Math.min(...block.map(indentOf)) : 0;
    const userTokens = new Map();
    const userNames = new Set();
    let activeUser = null;
    let hostToken = null;
    let currentUser = null;
    let inUsers = false;
    for (const line of block) {
      const body = line.trim();
      if (indentOf(line) === base) {
        inUsers = body === 'users:';
        currentUser = null;
        const named = body.match(/^user:\s*(\S+)/);
        if (named) activeUser = named[1];
        const own = body.match(/^oauth_token:\s*(\S+)/);
        if (own) hostToken = own[1];
        continue;
      }
      if (!inUsers) continue;
      const name = body.match(/^([^:\s]+):$/);
      if (name) { currentUser = name[1]; userNames.add(currentUser); continue; }
      const token = body.match(/^oauth_token:\s*(\S+)/);
      if (token && currentUser) userTokens.set(currentUser, token[1]);
    }
    if (activeUser && userTokens.has(activeUser)) return userTokens.get(activeUser);
    // user: names the account gh is signed in as. Once a users: map exists the file tracks
    // tokens per account, so the active one missing from it means its token sits in the
    // system keychain - and whatever the file still holds was written for somebody else.
    // Reviewing under a stranger comments as them, so the honest answer is no token here:
    // the caller falls through to the env or the netrc, or reports that nothing authorises.
    if (activeUser && userNames.size) return null;
    // One account is the ordinary case: its own entry is the maintained one, while the
    // host-level copy is what older gh versions wrote and can go stale after a re-auth.
    if (userTokens.size === 1) return [...userTokens.values()][0];
    // An unlisted active account predates the users: map, so the host-level token is its own.
    if (hostToken) return hostToken;
    if (userTokens.size) return [...userTokens.values()][0];
  }
  return null;
}

function ghToken(project) {
  const out = run('gh', ['auth', 'token'], { cwd: project, timeout: requestTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  return String(out || '').trim() || null;
}

// One API call, performed by a child copy of this file (see the header).
// Failures never throw: every caller has something sensible to do without an
// answer from GitHub.
function request(project, options) {
  const payload = {
    url: options.url || `${apiRoot}${options.path}`,
    method: options.method || 'GET',
    accept: options.accept || 'application/vnd.github+json',
    body: options.body === undefined ? null : options.body,
    token: options.token === undefined ? token(project) : options.token,
  };
  const out = run(process.execPath, [__filename, '--serve'], {
    input: JSON.stringify(payload),
    timeout: requestTimeoutMs,
  });
  if (out === null) return { ok: false, status: 0, text: '', json: null, error: 'request process failed' };
  let result;
  try {
    result = JSON.parse(out);
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, error: 'unreadable response' };
  }
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch (err) {
    json = null;
  }
  return { ...result, json, error: result.error || errorOf(result, json) };
}

// A failed call says what to do about it: 401/403 mean the token is missing or
// stale, 404 on a repository that exists means the token cannot see it.
function errorOf(result, json) {
  if (result.ok) return null;
  const message = (json && json.message) || `HTTP ${result.status}`;
  if (result.status === 401) return `${message} - the GitHub token was rejected (set GH_TOKEN or refresh the stored github.com credential)`;
  if (result.status === 403) return `${message} - forbidden or rate limited (an unauthenticated call is capped at 60/h)`;
  if (result.status === 404) return `${message} - not found, or the token cannot see this repository`;
  return message;
}

// The open pull request whose head is this branch, and the branch it targets.
// `head=<owner>:<branch>` is the exact query for the usual same-repo pull
// request; a pull request opened from a fork carries another owner there, so a
// miss falls back to scanning the most recently updated open ones.
// `findToken` is a seam like `send`: it keeps the credential store out of every
// test that only cares about the pull request lookup.
function findOpenPr(project, branch, send = request, findToken = tokenWithSource) {
  const slug = repoSlug(project);
  // Where the token came from travels with the answer, so a caller that has to
  // explain a refusal can tell "no token anywhere" from "the token was refused".
  // Resolved only once a call is actually going out: a repository that is not on
  // GitHub has no reason to touch a credential store at all.
  const out = (pr, error) => {
    const found = findToken(project);
    return { slug, pr, error, tokenSource: found.source, triedTokenSources: found.tried };
  };
  if (!slug || !branch) return { slug, pr: null, error: null, tokenSource: null, triedTokenSources: [] };
  const head = encodeURIComponent(`${slug.owner}:${branch}`);
  const direct = send(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=1&head=${head}` });
  if (!direct.ok) return out(null, direct.error);
  if (Array.isArray(direct.json) && direct.json.length) return out(prOf(direct.json[0]), null);
  const scan = send(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=100&sort=updated&direction=desc` });
  if (!scan.ok) return out(null, scan.error);
  const match = Array.isArray(scan.json) ? scan.json.find((pr) => pr.head && pr.head.ref === branch) : null;
  return out(match ? prOf(match) : null, null);
}

function prOf(pr) {
  return {
    number: pr.number,
    url: pr.html_url,
    base: (pr.base && pr.base.ref) || null,
    title: typeof pr.title === 'string' ? pr.title : '',
  };
}

// The pull request's own diff, in the format GitHub itself renders it from -
// the same text `gh pr diff` prints.
function pullRequestDiff(project, slug, number, send = request) {
  const res = send(project, {
    path: `/repos/${slug.owner}/${slug.repo}/pulls/${number}`,
    accept: 'application/vnd.github.v3.diff',
  });
  return { diff: res.ok ? res.text : null, error: res.error };
}

function postReview(project, slug, number, review, send = request) {
  const res = send(project, {
    path: `/repos/${slug.owner}/${slug.repo}/pulls/${number}/reviews`,
    method: 'POST',
    body: review,
  });
  return { error: res.error };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

// The child side: one request in, one JSON line out. It never rejects - a
// network error is an answer too, and the parent has to hear it.
async function serve() {
  let out;
  try {
    const req = JSON.parse(await readStdin());
    const headers = { accept: req.accept, 'user-agent': userAgent, 'x-github-api-version': apiVersion };
    if (req.token) headers.authorization = `Bearer ${req.token}`;
    if (req.body !== null) headers['content-type'] = 'application/json';
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body === null ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(requestTimeoutMs - 2000),
    });
    out = { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    out = { ok: false, status: 0, text: '', error: String((err && err.message) || err) };
  }
  process.stdout.write(JSON.stringify(out));
}

module.exports = {
  repoSlug, token, tokenWithSource, credentialToken, netrcToken, ghConfigToken,
  request, findOpenPr, pullRequestDiff, postReview, errorOf,
};

if (require.main === module && process.argv[2] === '--serve') serve();
