#!/usr/bin/env node
'use strict';

// What an E2E run needs before the dev server is started: the local config the app reads, a
// free port for it and a backend that answers. Each one missing used to surface only after a
// cold `ng serve` (6 to 10 minutes on a monorepo) and a suite in which every test failed with
// ERR_CONNECTION_REFUSED - twice in one run, for one `proxy.dpx.local.js` the worktree lacked.
// Seconds instead, with the reason in words.
//
// Usage: node e2e-preflight.cjs --root=<working directory> [--project=<main checkout>] [--port=<dev port>]
//        [--url=<backend or mock URL>]... [--fix]
// `--fix` copies the missing local config from the main checkout first (bootstrap-worktree's copier).
// Prints `PREFLIGHT_OK`, or `PREFLIGHT_FAILED` and one line per problem (FIXED IDENTIFIERS).

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const { copyEnvFiles, copyLocalFiles, tryGit, isLocalConfig } = require('../../fixPr/scripts/worktree.cjs');

function parseArgs(argv) {
  const args = { root: '', project: '', port: 0, urls: [], fix: false };
  for (const arg of argv) {
    if (arg === '--fix') { args.fix = true; continue; }
    const m = arg.match(/^--(root|project|port|url)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg} (expected --root, --project, --port, --url, --fix)`);
    if (m[1] === 'url') args.urls.push(m[2]);
    else if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'project') args.project = m[2];
  }
  if (!args.root) throw new Error('--root=<working directory> is required');
  return args;
}

// The gitignored local config the main checkout has and the working directory lacks.
function missingLocalConfig(project, root, list = (dir) => tryGit(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])) {
  const names = (dir) => new Set(String(list(dir) || '').split('\n').map((l) => l.trim())
    .filter((rel) => rel && !rel.endsWith('/') && !rel.split('/').some((p) => p === 'node_modules' || p.startsWith('.claude'))
      && (isLocalConfig(path.basename(rel)) || path.basename(rel).startsWith('.env'))));
  const theirs = names(project);
  const ours = names(root);
  return [...theirs].filter((rel) => !ours.has(rel)).sort();
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// Any HTTP answer counts - a 401 or a 404 still means something is listening; only no answer fails.
function reachable(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'https:' ? https : http;
    } catch {
      resolve('not a URL');
      return;
    }
    const req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(null);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer within 5 s'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve(err.code || err.message));
  });
}

async function preflight({ root, project, port, urls, fix }, seams = {}) {
  const problems = [];
  const main = project ? path.resolve(project) : '';
  const tree = path.resolve(root);
  if (main && main.toLowerCase() !== tree.toLowerCase()) {
    if (fix) {
      (seams.copyEnv || copyEnvFiles)(main, tree);
      (seams.copyLocal || copyLocalFiles)(main, tree);
    }
    for (const rel of (seams.missing || missingLocalConfig)(main, tree)) {
      problems.push(`missing local config ${rel} - copy it from ${main} (or run again with --fix)`);
    }
  }
  if (port && !(await (seams.portFree || portFree)(port))) {
    problems.push(`port ${port} is taken - pick another free port for the dev server, or stop what holds it`);
  }
  for (const url of urls) {
    const why = await (seams.reachable || reachable)(url);
    if (why) problems.push(`unreachable ${url} (${why}) - start the backend or Mockoon, or reconnect the VPN`);
  }
  return problems;
}

if (require.main === module) {
  (async () => {
    let problems;
    try {
      problems = await preflight(parseArgs(process.argv.slice(2)));
    } catch (err) {
      problems = [String((err && err.message) || err)];
    }
    process.stdout.write(problems.length ? `PREFLIGHT_FAILED\n${problems.map((p) => `- ${p}`).join('\n')}\n` : 'PREFLIGHT_OK\n');
    process.exitCode = problems.length ? 1 : 0;
  })();
}

module.exports = { parseArgs, preflight, missingLocalConfig, portFree, reachable };
