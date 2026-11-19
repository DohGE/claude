#!/usr/bin/env node
'use strict';

// What CI says about a pushed commit: the commit statuses and the check runs GitHub holds for its
// sha, waited for until none is pending (bounded by --timeout-min), and for a red Jenkins build
// the decisive lines of its console log.
//
// The gate of a run is the project's lint, typecheck, tests and build as the plugin can run them;
// CI is what finally judges the pull request. On 2026-11-18 every fix agent of a stack of seven
// reported a green gate, and Jenkins then failed four of the seven on spec compile errors - which
// the orchestrator learned only when the user looked. The commit status said `error` ("This commit
// cannot be built") and the Jenkins console log was readable without a login at
// `<target_url>/consoleText`. This script reads both, so the run's summary says per branch whether
// CI is green, red (with the lines that say why), or still running.
//
// It waits in the foreground of its own process: the orchestrator starts it in the background
// (Bash, `run_in_background: true`) once the branches have landed, and it never waits past
// --timeout-min (default 15; 0 = one look). Each round rewrites the result file, so a summary
// printed while CI still runs says "still running" instead of nothing.
//
// Usage:
//   node ci-status.cjs --run=<fixpr-run-*.json> [--branch=<branch>] [--timeout-min=15] [--interval-s=30] [--logs=yes|no]
//     every pushed target of the run (or the one named), each written to <checksDir>/ci-status.json
//     - the file fixpr-summary.cjs reads;
//   node ci-status.cjs --project=<path> --branches=<a;b> [--out=<file>] [...]
//     the tips of those branches on origin (/doh:restack after its climb).
// Prints one JSON object: { branches: [{ branch, sha, state, items, failed, pending, … }], warnings, errors }.
// `state`: success | failure | pending (still running at the timeout) | none (CI reported nothing) | error.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const github = require('../../codeReview/scripts/github.cjs');
const { extractErrors, renderLines, writeResultFile } = require('./checks.cjs');

const minute = 60 * 1000;
// CI that has said nothing yet may simply not have started: it gets this long before `none`.
const startGraceMs = 3 * minute;
const maxLines = 40;
const consoleCap = 256 * 1024;

function parseArgs(argv) {
  const args = { run: '', branch: '', project: '', branches: [], out: '', timeoutMin: 15, intervalS: 30, logs: 'yes' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    const value = m[2].trim();
    if (m[1] === 'run') args.run = value;
    else if (m[1] === 'branch') args.branch = value;
    else if (m[1] === 'project') args.project = value;
    else if (m[1] === 'branches') args.branches = value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'out') args.out = value;
    else if (m[1] === 'timeout-min' && /^\d+(\.\d+)?$/.test(value)) args.timeoutMin = Number(value);
    else if (m[1] === 'interval-s' && /^\d+$/.test(value) && Number(value) > 0) args.intervalS = Number(value);
    else if (m[1] === 'logs' && ['yes', 'no'].includes(value)) args.logs = value;
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --branch, --project, --branches, --out, --timeout-min, --interval-s, --logs).`);
  if (!args.run && !(args.project && args.branches.length)) throw new Error('Give --run=<fixpr-run-*.json>, or --project=<path> with --branches=<a;b>.');
  return args;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function gitOut(project, args) {
  const res = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? String(res.stdout || '').trim() : null;
}

// The branch's tip on origin, fetched first: the push that landed it came from a worktree.
function remoteTip(project, branch, git = gitOut) {
  git(project, ['fetch', '--quiet', 'origin', branch]);
  return git(project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) || null;
}

// A finished check run that is no failure: what GitHub shows as green or grey.
const passing = new Set(['success', 'neutral', 'skipped', 'stale']);

// Everything CI reported for one sha, as items of one shape: the commit statuses (Jenkins, most
// external CI) and the check runs (GitHub Actions, apps). The combined status already holds only
// the latest status of each context.
function readCi(project, slug, sha, send = github.request) {
  const base = `/repos/${slug.owner}/${slug.repo}/commits/${sha}`;
  const combined = send(project, { path: `${base}/status?per_page=100` });
  if (!combined.ok) return { error: combined.error || `HTTP ${combined.status}` };
  const items = ((combined.json && combined.json.statuses) || []).map((s) => ({
    kind: 'status', name: s.context, state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
    url: s.target_url || null, description: s.description || '',
  }));
  const runs = send(project, { path: `${base}/check-runs?per_page=100` });
  // An installation without the checks permission answers 403 here; the statuses still count.
  for (const c of (runs.ok && runs.json && runs.json.check_runs) || []) {
    items.push({
      kind: 'check', name: c.name, state: c.status !== 'completed' ? 'pending' : passing.has(c.conclusion) ? 'success' : 'failure',
      url: c.details_url || c.html_url || null, description: (c.output && c.output.title) || c.conclusion || '',
      summary: (c.output && c.output.summary) || '',
    });
  }
  return { items, warning: runs.ok ? null : `check runs not readable: ${runs.error || `HTTP ${runs.status}`}` };
}

function stateOf(items) {
  if (items.length === 0) return 'none';
  if (items.some((i) => i.state === 'failure')) return 'failure';
  if (items.some((i) => i.state === 'pending')) return 'pending';
  return 'success';
}

// `<build>/consoleText` of a Jenkins build link - the status's target_url often ends in
// `display/redirect` (Blue Ocean) or a page of the build. null for anything that is no Jenkins build.
function jenkinsConsoleUrl(targetUrl) {
  if (!targetUrl || !/\/job\/[^/]+/.test(targetUrl)) return null;
  const bare = String(targetUrl).replace(/[?#].*$/, '').replace(/\/display\/redirect\/?$/, '').replace(/\/(console(Full)?|consoleText|pipeline(-graph)?|testReport|changes)\/?$/, '');
  return `${bare.replace(/\/+$/, '')}/consoleText`;
}

// The lines that decide a red CI build: TypeScript errors, the failing spec files and Jest's failure
// headers, the totals, and ERROR lines - not the thousands of lines of checkout, install and
// passing specs around them. A log with none of those goes through the gate's own excerpt.
const decisive = [
  /\berror TS\d+:/i,
  /^\s*FAIL\s+\S/,
  /^\s*●\s+\S/,
  /^\s*✕\s/,
  /^\s*(Tests|Test Suites|Snapshots):\s/,
  /\bERROR:/,
  /^\s*ERROR\b/,
  /\bFinished: (FAILURE|ABORTED|UNSTABLE)\b/,
];
const totals = /^\s*(Tests|Test Suites):\s|\bFinished: /;

function decisiveLines(text, max = maxLines) {
  const lines = renderLines(text);
  const hits = [];
  for (const line of lines) {
    if (!decisive.some((p) => p.test(line))) continue;
    const clipped = line.trim().length > 300 ? `${line.trim().slice(0, 300)} …` : line.trim();
    if (hits[hits.length - 1] !== clipped) hits.push(clipped);
  }
  if (hits.length === 0) return extractErrors(text).split('\n').filter((l) => l.trim()).slice(-max);
  if (hits.length <= max) return hits;
  const tail = hits.filter((l) => totals.test(l)).slice(-4);
  return [...hits.slice(0, max - tail.length - 1), `… ${hits.length - (max - tail.length - 1) - tail.length} more lines`, ...tail];
}

// A Jenkins log needs no token on most instances; one that wants a login answers with a page.
function fetchConsole(url, send = github.request) {
  const res = send(null, { url, token: null, accept: 'text/plain' });
  const text = String(res.text || '');
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) return { error: res.ok ? 'the server answered with a login page' : res.error || `HTTP ${res.status}` };
  return { text };
}

const safeName = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ci';

// The red items of a settled branch, each with what says why: a Jenkins console's decisive lines,
// a check run's own title and summary.
function explainFailures(entry, { send, logs, outDir }) {
  const failed = [];
  for (const item of entry.items.filter((i) => i.state === 'failure')) {
    const out = { name: item.name, url: item.url, description: item.description, lines: [], log: null };
    const consoleUrl = logs ? jenkinsConsoleUrl(item.url) : null;
    if (consoleUrl) {
      const got = fetchConsole(consoleUrl, send);
      if (got.error) out.logError = `${consoleUrl}: ${got.error}`;
      else {
        out.lines = decisiveLines(got.text);
        if (outDir) {
          try {
            fs.mkdirSync(outDir, { recursive: true });
            const file = path.join(outDir, `ci-${safeName(entry.branch)}-${safeName(item.name)}.log`);
            fs.writeFileSync(file, got.text.length > consoleCap ? got.text.slice(-consoleCap) : got.text, 'utf8');
            out.log = file;
          } catch {
            // the lines above are what the summary prints; the file is only for a Grep
          }
        }
      }
    } else if (item.summary) {
      out.lines = renderLines(item.summary).filter((l) => l.trim()).slice(0, 10);
    }
    failed.push(out);
  }
  return failed;
}

function compact(entry) {
  const { items = [], ...rest } = entry;
  return {
    ...rest,
    items: items.map((i) => ({ name: i.name, state: i.state, ...(i.state !== 'success' && i.url ? { url: i.url } : {}) })),
    pending: items.filter((i) => i.state === 'pending').map((i) => i.name),
  };
}

// The branches to watch: from the run file (pushed targets, their landed commit) or by name.
function watchList(options, deps) {
  const warnings = [];
  if (options.run) {
    const data = JSON.parse(fs.readFileSync(options.run, 'utf8'));
    const project = data.project || path.dirname(options.run);
    const list = [];
    for (const t of data.targets || []) {
      if (options.branch && t.branch !== options.branch) continue;
      const o = t.outcome || {};
      if (!o.pushed || !o.commit) {
        if (options.branch) warnings.push(`${t.branch}: nothing pushed, so CI has nothing of this run to check.`);
        continue;
      }
      list.push({ branch: t.branch, sha: o.commit, out: t.checksDir ? path.join(t.checksDir, 'ci-status.json') : null, outDir: t.checksDir || null });
    }
    return { project, list, warnings };
  }
  const project = path.resolve(options.project);
  const list = options.branches.map((branch) => ({ branch, sha: (deps.remoteTip || remoteTip)(project, branch), out: null, outDir: options.out ? path.dirname(options.out) : null }));
  for (const w of list.filter((e) => !e.sha)) warnings.push(`${w.branch}: no origin/${w.branch} to read CI for.`);
  return { project, list: list.filter((e) => e.sha), warnings };
}

function watch(options, deps = {}) {
  const send = deps.send || github.request;
  const sleep = deps.sleep || sleepSync;
  const now = deps.now || Date.now;
  const result = { branches: [], warnings: [], errors: [] };
  const { project, list, warnings } = watchList(options, deps);
  result.warnings.push(...warnings);
  const slug = (deps.repoSlug || github.repoSlug)(project);
  if (!slug) {
    result.errors.push(`${project} has no github.com origin: no CI status to read.`);
    return result;
  }
  const started = now();
  const deadline = started + Math.max(0, Number(options.timeoutMin) || 0) * minute;
  const entries = list.map((e) => ({ branch: e.branch, sha: e.sha, state: 'pending', items: [], out: e.out, outDir: e.outDir }));
  const write = (entry) => {
    if (!entry.out) return;
    try {
      writeResultFile(entry.out, compact({ ...entry, out: undefined, outDir: undefined }));
    } catch (err) {
      result.warnings.push(`Could not write ${entry.out}: ${(err && err.message) || err}`);
    }
  };
  const settled = (e) => ['success', 'failure', 'error'].includes(e.state) || (e.state === 'none' && now() - started >= Math.min(startGraceMs, deadline - started));
  for (;;) {
    for (const entry of entries.filter((e) => !settled(e))) {
      const read = readCi(project, slug, entry.sha, send);
      entry.checkedAt = new Date(now()).toISOString();
      entry.waitedMs = now() - started;
      if (read.error) {
        // A refused token does not get better by asking again.
        entry.state = 'error';
        entry.error = read.error;
      } else {
        entry.items = read.items;
        entry.state = stateOf(read.items);
        if (read.warning && !result.warnings.includes(read.warning)) result.warnings.push(read.warning);
      }
      write(entry);
    }
    if (entries.every(settled) || now() >= deadline) break;
    sleep(Math.min(Number(options.intervalS || 30) * 1000, Math.max(1000, deadline - now())));
  }
  for (const entry of entries) {
    if (entry.state === 'failure') entry.failed = explainFailures(entry, { send, logs: options.logs !== 'no', outDir: entry.outDir });
    write(entry);
    result.branches.push(compact({ ...entry, out: undefined, outDir: undefined }));
  }
  if (options.out) {
    try {
      writeResultFile(path.resolve(options.out), result);
    } catch (err) {
      result.warnings.push(`Could not write ${options.out}: ${(err && err.message) || err}`);
    }
  }
  return result;
}

function main() {
  let result;
  try {
    result = watch(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { branches: [], warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, readCi, stateOf, jenkinsConsoleUrl, decisiveLines, watch, compact };

if (require.main === module) main();
