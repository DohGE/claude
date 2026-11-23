#!/usr/bin/env node
'use strict';

// The review's `decides` static checks (references/static.md), run BEFORE the review: over the
// files a worktree changed since its base - committed, uncommitted and untracked - classified and
// planned exactly as Step 1 of the review does it (review-context.cjs), so a fix agent or an
// implementation agent repairs on its own what the review would otherwise report as a violation.
//
//   node static-gate.cjs --project=<worktree> [--base=<ref>] [--timeout-ms=<n>]
//
// Prints one line per `inChange` hit of level `decides`: `path:line  rule - message  [address]`,
// and exits 1 when there is any. `points` hits never print and never fail. Nothing to check (no
// change, no map, no engine) is one line saying why, exit 0. A worktree's node_modules is the main
// checkout's (fixPr worktree.cjs links it), so the project's ESLint resolves from the worktree.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rulebook = require('./rulebook.cjs');
const reviewContext = require('./review-context.cjs');

const skillDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { project: process.cwd(), base: '', timeoutMs: 120000 };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'base') args.base = m[2].trim();
    else if (m[1] === 'timeout-ms' && /^\d+$/.test(m[2].trim())) args.timeoutMs = Number(m[2].trim());
    else unknown.push(arg);
  }
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --base, --timeout-ms).`);
  return args;
}

function git(project, args) {
  const res = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : null;
}

// The upstream default branch: origin/HEAD, else the first of origin/main, origin/master, main, master.
function detectBase(project, gitOut = git) {
  const head = gitOut(project, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head && head.trim()) return head.trim().replace(/^refs\/remotes\//, '');
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitOut(project, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]) !== null) return name;
  }
  return null;
}

// The working tree against the merge-base: `[{ path, status, oldPath?, changedLines }]` like the
// review's files (`changedLines` null for an added file = every line), deletions left out, plus
// the diff text by path. null when the base is no ref of this repository.
function changedFilesOf(project, base, gitOut = git) {
  const mergeBase = (gitOut(project, ['merge-base', base, 'HEAD']) || '').trim();
  if (!mergeBase) return null;
  const raw = gitOut(project, ['diff', '--raw', '-M', '--no-color', mergeBase]);
  const patch = gitOut(project, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', mergeBase]);
  if (raw === null || patch === null) return null;
  const ranges = reviewContext.parseDiffRangesByPath(patch);
  const patches = reviewContext.splitPatchByPath(patch);
  const files = reviewContext.parseRawDiff(raw).filter((f) => f.status !== 'D').map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    changedLines: f.status === 'A' ? null : (ranges.get(f.path) || ''),
  }));
  const known = new Set(files.map((f) => f.path));
  for (const line of String(gitOut(project, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/)) {
    const p = line.trim();
    if (p && !known.has(p)) files.push({ path: p, status: 'A', changedLines: null });
  }
  return { mergeBase, files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), patches };
}

// The rulebook of the review (the skill's instructions, the project's own layer and static maps).
function loadRules(project) {
  const projectInstructionsDir = path.join(project, '.claude', 'doh', 'instructions');
  const localInstructionsDir = path.join(project, '.claude', 'doh', 'local');
  const isDir = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
  return rulebook.loadRulebook(
    [path.join(skillDir, 'instructions'), isDir(projectInstructionsDir) ? projectInstructionsDir : null],
    { localDir: isDir(localInstructionsDir) ? localInstructionsDir : null, staticMaps: rulebook.defaultStaticMaps([path.join(skillDir, 'instructions'), projectInstructionsDir]) },
  );
}

// The hits that fail the gate, as printed lines: `inChange`, level `decides`.
function violationLines(doc) {
  const lines = [];
  for (const [file, entry] of Object.entries((doc && doc.files) || {})) {
    for (const h of entry.hits || []) {
      if (!h.inChange || h.level !== 'decides') continue;
      lines.push({ file, line: h.line || 0, text: `${file}:${h.line || 1}  ${h.rule} - ${String(h.message || '').replace(/\s+/g, ' ').trim()}  [${h.address}]` });
    }
  }
  return lines.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)).map((l) => l.text);
}

// `{ lines, exitCode }` - what main prints. `runner` and `changed` are seams for the tests.
function gate({ project, base, timeoutMs = 120000, runner, changed, rules } = {}) {
  const root = path.resolve(project);
  const ref = base || detectBase(root);
  if (!ref) return { lines: ['static checks: no base ref found (pass --base=<ref>) - nothing checked.'], exitCode: 0 };
  const diff = changed || changedFilesOf(root, ref);
  if (!diff) return { lines: [`static checks: ${ref} is no ref of ${root} (fetch it first) - nothing checked.`], exitCode: 0 };
  const loaded = rules || loadRules(root);
  const kept = diff.files.filter((f) => !reviewContext.isSkippedPath(f.path));
  const texts = new Map();
  for (const f of kept) {
    try { texts.set(f.path, fs.readFileSync(path.join(root, f.path), 'utf8')); } catch { /* gone or unreadable */ }
  }
  const files = kept.filter((f) => texts.has(f.path));
  if (files.length === 0) return { lines: [`static checks: nothing changed since ${ref}.`], exitCode: 0 };
  // One plan per narrowed kind, as review-context.cjs planFor keys them.
  const planCatalog = [];
  const planIndex = new Map();
  for (const f of files) {
    const kind = rulebook.planOf(rulebook.matchKind(loaded, f.path).kind, f.path, reviewContext.reportedText(f, texts.get(f.path)), loaded.instructions);
    const key = kind ? (kind.skipped ? `${kind.name}\u0000${kind.skipped.join(',')}` : kind.name) : null;
    if (!planIndex.has(key)) { planIndex.set(key, planCatalog.length); planCatalog.push(kind); }
    f.plan = planIndex.get(key);
  }
  let universe = texts;
  try { universe = reviewContext.loadFactUniverse(root, { workTree: true }, texts).files; } catch { /* the changed files alone */ }
  const ran = reviewContext.staticStage({
    project: root, files, planCatalog, instructions: loaded.instructions, texts: universe, patches: diff.patches || new Map(),
    fromWorkTree: true, timeoutMs, ...(runner ? { runner } : {}),
  });
  if (ran.warning) return { lines: [`static checks: did not run - ${ran.warning}`], exitCode: 0 };
  if (!ran.doc) return { lines: [`static checks: no changed file has an item a static check settles (${files.length} file(s) since ${ref}).`], exitCode: 0 };
  const engines = ran.doc.engines || {};
  // An engine no entry needed is no news: only the ones whose entries did not run are named.
  const skipped = ran.doc.skipped || [];
  const down = Object.entries(engines).filter(([name, e]) => !e.available && skipped.some((s) => s.engine === name)).map(([name, e]) => `${name}${e.reason ? ` (${e.reason})` : ''}`);
  const note = down.length ? `; not available: ${down.join(', ')}` : '';
  const violations = violationLines(ran.doc);
  const fileCount = Object.keys(ran.doc.files || {}).length;
  if (violations.length === 0) return { lines: [`static checks: no violation on the changed lines of ${fileCount} file(s) since ${ref}${note}.`], exitCode: 0 };
  return {
    lines: [...violations, `static checks: ${violations.length} violation(s) on changed lines since ${ref}${note} - fix the code; an eslint-disable comment is no fix.`],
    exitCode: 1,
  };
}

function main() {
  let out;
  try {
    out = gate(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${String((err && err.message) || err)}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${out.lines.join('\n')}\n`);
  process.exitCode = out.exitCode;
}

module.exports = { parseArgs, detectBase, changedFilesOf, loadRules, violationLines, gate };

if (require.main === module) main();
