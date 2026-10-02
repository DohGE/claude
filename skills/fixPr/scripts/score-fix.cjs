#!/usr/bin/env node
'use strict';

// Scores a fixPr run on the meter's fixture (test-key/make-fixture.cjs) against test-key/key.json,
// so a change to the brief can be measured instead of argued about.
//
// What it reads is what the run leaves behind, never the agent's word for it:
// - the verdicts: the agent's report, `## Naprawione` / `## Odrzucone` / `## Bez akcji` (FIXED
//   IDENTIFIERS of references/fix-agent.md), each line matched to a review item by the comment
//   url it cites;
// - the code: the branch head, copied out of git into a temporary folder, where every item's
//   `check` must hold - a fixed item fixed, a rejected or answered one left working - and the
//   project's own lint, test and build must pass;
// - the landing: one new commit with the key's message, pushed to the fixture's origin, and no
//   file changed beyond `allowedFiles`.
// A `fixed` verdict whose file the commit never changed is a false fix: the one claim that
// would close a reviewer's thread on GitHub without anything behind it.
//
// Usage: node score-fix.cjs --fixture=<fixture.json> [--report=<report.md>] [--json]
//   without --report, the newest report of the branch under <project>/.claude/doh/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { sanitizeBranchName } = require('../../codeReview/scripts/review-context.cjs');

const sections = { Naprawione: 'fixed', Odrzucone: 'rejected', 'Bez akcji': 'answered' };
const gate = [['lint', 'lint'], ['test', 'unit tests'], ['build', 'build']];

function parseArgs(argv) {
  const args = { fixture: null, report: null, json: false };
  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (m && m[1] === 'fixture') args.fixture = m[2];
    else if (m && m[1] === 'report') args.report = m[2];
    else throw new Error(`Unknown argument: ${arg} (expected --fixture=<fixture.json> [--report=<report.md>] [--json]).`);
  }
  if (!args.fixture) throw new Error('Missing --fixture=<fixture.json>.');
  return args;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// Every comment url of the replay, to the key item it belongs to.
function itemsByUrl(replay) {
  const byUrl = new Map();
  for (const thread of replay.threads || []) for (const c of thread.comments || []) byUrl.set(c.url, thread.meterId);
  for (const note of [...(replay.conversation || []), ...(replay.reviews || [])]) byUrl.set(note.url, note.meterId);
  return byUrl;
}

function newestReport(project, branch) {
  const dir = path.join(project, '.claude', 'doh', sanitizeBranchName(branch));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /-fix-pr-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/.test(n));
  } catch {}
  names.sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

// The verdict the report gives each item, by the urls its lines cite. An item under two
// sections is a contradiction the run made, and it counts as neither.
function reportVerdicts(text, byUrl) {
  const found = new Map();
  const unknownLines = [];
  let verdict = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      verdict = sections[heading[1]] || null;
      continue;
    }
    if (!verdict || !/^\s*-\s/.test(line)) continue;
    const urls = line.match(/https?:\/\/[^\s)>,\]]+/g) || [];
    const ids = [...new Set(urls.map((u) => byUrl.get(u)).filter(Boolean))];
    if (ids.length === 0) {
      if (line.trim() !== '- —' && line.trim() !== '-') unknownLines.push(line.trim());
      continue;
    }
    for (const id of ids) {
      const before = found.get(id);
      found.set(id, before && before !== verdict ? 'contradictory' : verdict);
    }
  }
  return { found, unknownLines };
}

// The branch head as files, so the checks run on what was committed - not on whatever a
// worktree still holds.
function materialize(project, ref, dir) {
  for (const file of git(project, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean)) {
    const dest = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execFileSync('git', ['show', `${ref}:${file}`], { cwd: project }));
  }
}

// Every check in one child process: the src/ modules' exports by name, `index` for the
// package root, `source(file)` and `throwsWith(fn, text)`.
const checkRunner = `
const fs = require('node:fs');
const path = require('node:path');
const scope = {};
for (const name of fs.readdirSync('src').filter((n) => n.endsWith('.cjs'))) {
  try { Object.assign(scope, require(path.resolve('src', name))); } catch {}
}
try { scope.index = require(path.resolve('src', 'index.cjs')); } catch { scope.index = {}; }
scope.source = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
scope.throwsWith = (fn, text) => { try { fn(); return false; } catch (err) { return String(err && err.message).includes(text); } };
const out = {};
for (const [id, expr] of JSON.parse(process.argv[1])) {
  try { out[id] = Boolean(new Function(...Object.keys(scope), 'return (' + expr + ');')(...Object.values(scope))); }
  catch (err) { out[id] = 'error: ' + (err && err.message); }
}
process.stdout.write(JSON.stringify(out));
`;

function runChecks(dir, items) {
  const exprs = items.filter((item) => item.check).map((item) => [item.id, item.check]);
  const r = spawnSync(process.execPath, ['-e', checkRunner, JSON.stringify(exprs)], { cwd: dir, encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return Object.fromEntries(exprs.map(([id]) => [id, `error: ${(r.stderr || 'no output').trim().split('\n')[0]}`]));
  }
}

function runGate(dir) {
  const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
  // Under a test runner the variable is inherited, and a nested `node --test` then reports to
  // that runner instead of failing on its own: the project's suite would always look green.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return gate.map(([script, label]) => {
    if (!scripts[script]) return { label, result: 'missing' };
    const r = spawnSync(scripts[script], { cwd: dir, shell: true, encoding: 'utf8', env });
    return { label, result: r.status === 0 ? 'passed' : 'failed', detail: r.status === 0 ? '' : `${r.stdout}${r.stderr}`.trim().split('\n').slice(0, 3).join(' | ') };
  });
}

function score(fixture, reportPath) {
  const key = JSON.parse(fs.readFileSync(fixture.key, 'utf8'));
  const replay = JSON.parse(fs.readFileSync(fixture.replay, 'utf8'));
  const project = fixture.project;
  const result = { report: reportPath, verdicts: [], checks: {}, falseFixes: [], commit: {}, outside: [], gate: [], problems: [] };

  const text = reportPath ? fs.readFileSync(reportPath, 'utf8') : '';
  if (!reportPath) result.problems.push('no report of the run was found');
  const { found, unknownLines } = reportVerdicts(text, itemsByUrl(replay));
  result.unknownLines = unknownLines;

  const head = tryGit(project, ['rev-parse', fixture.branch]);
  const changed = head ? git(project, ['diff', '--name-only', fixture.headBefore, head]).split('\n').filter(Boolean) : [];
  for (const item of key.items) {
    const got = found.get(item.id) || 'missing';
    result.verdicts.push({ id: item.id, expected: item.verdict, got, right: got === item.verdict });
    if (got === 'fixed' && item.path && !changed.includes(item.path)) result.falseFixes.push(item.id);
  }

  const count = head ? Number(git(project, ['rev-list', '--count', `${fixture.headBefore}..${head}`])) : 0;
  const message = count ? git(project, ['log', '-1', '--format=%s', head]) : null;
  const remote = tryGit(project, ['--git-dir', fixture.origin, 'rev-parse', `refs/heads/${fixture.branch}`]);
  result.commit = { count, message, messageRight: message === key.commitMessage, pushed: Boolean(head) && remote === head };
  result.outside = changed.filter((file) => !key.allowedFiles.includes(file));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-fix-'));
  try {
    materialize(project, head || fixture.headBefore, dir);
    result.checks = runChecks(dir, key.items);
    result.gate = runGate(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const right = result.verdicts.filter((v) => v.right).length;
  result.summary = { items: key.items.length, right, checksHeld: Object.values(result.checks).filter((v) => v === true).length, checks: Object.keys(result.checks).length };
  for (const v of result.verdicts.filter((x) => !x.right)) result.problems.push(`${v.id}: ${v.got}, expected ${v.expected}`);
  for (const [id, held] of Object.entries(result.checks)) if (held !== true) result.problems.push(`${id}: check does not hold (${held === false ? 'false' : held})`);
  for (const id of result.falseFixes) result.problems.push(`${id}: reported fixed, but the commit does not change its file`);
  if (count !== 1) result.problems.push(`${count} new commits on ${fixture.branch}, expected 1`);
  if (count && !result.commit.messageRight) result.problems.push(`commit message ${JSON.stringify(message)}, expected ${JSON.stringify(key.commitMessage)}`);
  if (count && !result.commit.pushed) result.problems.push('the commit is not on origin');
  for (const file of result.outside) result.problems.push(`${file}: changed beyond the fixes`);
  for (const g of result.gate) if (g.result !== 'passed') result.problems.push(`gate ${g.label}: ${g.result}${g.detail ? ` (${g.detail})` : ''}`);
  return result;
}

function format(result) {
  const byVerdict = (verdict) => {
    const rows = result.verdicts.filter((v) => v.expected === verdict);
    return `${verdict} ${rows.filter((v) => v.right).length}/${rows.length}`;
  };
  const lines = [
    `verdicts: ${result.summary.right}/${result.summary.items} right (${['fixed', 'rejected', 'answered'].map(byVerdict).join(', ')})`,
    `checks on the result: ${result.summary.checksHeld}/${result.summary.checks} hold`,
    `commit: ${result.commit.count} new${result.commit.message ? `, ${JSON.stringify(result.commit.message)}` : ''}, pushed: ${result.commit.pushed ? 'yes' : 'no'}`,
    `gate on the result: ${result.gate.map((g) => `${g.label} ${g.result}`).join(', ')}`,
    `problems: ${result.problems.length}`,
    ...result.problems.map((p) => `  ${p}`),
  ];
  if (result.unknownLines.length) lines.push(`report lines citing no review item: ${result.unknownLines.length}`);
  return lines.join('\n');
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    const result = score(fixture, args.report || newestReport(fixture.project, fixture.branch));
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, itemsByUrl, reportVerdicts, newestReport, score, format };

if (require.main === module) main();
