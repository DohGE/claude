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

// The API token, in the order that asks the least of the user: an explicit
// environment variable, then the credential git already stores for github.com
// (pushing over HTTPS puts one there), then gh if it happens to be installed.
// `credential.interactive=false` keeps a missing credential from popping a GUI
// prompt in the middle of a review. The value is never logged and never travels
// on a command line - the request child receives it on stdin.
const tokenCache = new Map();
function token(project) {
  if (tokenCache.has(project)) return tokenCache.get(project);
  const found = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    || credentialToken(project) || ghToken(project) || null;
  tokenCache.set(project, found);
  return found;
}

// `options` is the seam the tests use to point git at an isolated config, so no
// test ever reaches the real credential store.
function credentialToken(project, options = {}) {
  const out = run('git', ['-C', project, '-c', 'credential.interactive=false', 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    timeout: requestTimeoutMs,
    ...options,
  });
  const line = String(out || '').split(/\r?\n/).find((l) => l.startsWith('password='));
  return line ? line.slice('password='.length).trim() || null : null;
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
function findOpenPr(project, branch, send = request) {
  const slug = repoSlug(project);
  if (!slug || !branch) return { slug, pr: null, error: null };
  const head = encodeURIComponent(`${slug.owner}:${branch}`);
  const direct = send(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=1&head=${head}` });
  if (!direct.ok) return { slug, pr: null, error: direct.error };
  if (Array.isArray(direct.json) && direct.json.length) return { slug, pr: prOf(direct.json[0]), error: null };
  const scan = send(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=100&sort=updated&direction=desc` });
  if (!scan.ok) return { slug, pr: null, error: scan.error };
  const match = Array.isArray(scan.json) ? scan.json.find((pr) => pr.head && pr.head.ref === branch) : null;
  return { slug, pr: match ? prOf(match) : null, error: null };
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

module.exports = { repoSlug, token, credentialToken, request, findOpenPr, pullRequestDiff, postReview, errorOf };

if (require.main === module && process.argv[2] === '--serve') serve();
