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
function repoSlug(project) {
  for (const line of String(git(project, ['remote', '-v']) || '').split('\n')) {
    const url = line.split(/\s+/)[1] || '';
    const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
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
    const line = String(out || '').split(/\r?\n/).find((l) => l.startsWith('password='));
    const value = line ? line.slice('password='.length).trim() : '';
    if (value) return value;
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
    let inside = false;
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'machine' || words[i] === 'default') {
        inside = words[i] === 'default' || words[i + 1] === 'github.com';
        continue;
      }
      if (inside && words[i] === 'password' && words[i + 1]) return words[i + 1];
    }
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
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() && !/^\s/.test(lines[i])) break;
      const m = lines[i].match(/^\s+oauth_token:\s*(\S+)/);
      if (m) return m[1];
    }
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
  return { number: pr.number, url: pr.html_url, base: (pr.base && pr.base.ref) || null };
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
