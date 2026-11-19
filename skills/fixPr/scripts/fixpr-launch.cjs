#!/usr/bin/env node
'use strict';

// One fixPr target made ready for its fix agent: its worktree (worktree.cjs) and its brief, with
// the brief's step files, rendered from the run file (pr-comments.cjs) - one call per branch.
//
// On 2026-11-16 the orchestrator built 22 `--set=` flags per part by hand from the collector's JSON
// and worktree.cjs's answer, about 1.5k characters a call, and wrote itself a helper script to stop
// paying for them. Every value is already in the run file or in worktree.cjs's answer; this script
// joins them, so the orchestrator spawns the agent on a path and copies no value.
//
// The brief is fix-agent.md; what the agent needs only at one step lives in its own file, read at
// that step: fix-visual-agent.md (the look at the running app) and fix-land-agent.md (rebase and
// push). Every value goes to <checksDir>/brief-vars.json as well, which split-work.cjs renders the
// workers' briefs from.
//
// Usage: node fixpr-launch.cjs --run=<fixpr-run-*.json> --branch=<branch> [--push=yes|no] [--language=<name>]
// Prints one JSON object: { branch, worktree, promptPath, visualBrief, landBrief, varsPath, installed,
// linked, heldBy, localBranch, mainBroken, warnings, errors }.
//
// SKILL.md Step 3 runs it in the background, one call per target, so a slow launch (an install of
// several minutes, bounded by worktree.cjs) never holds back the launches of the parts above it; the
// git part of worktree.cjs takes a repository lock, the dependency step runs side by side.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const skillDir = path.resolve(__dirname, '..');
const references = path.join(skillDir, 'references');
// The placeholders this script fills (render-agent-prompt.test.cjs reads them as fixPr's contract).
const briefNames = ['ROOT', 'BRANCH', 'BASE', 'PR_NUMBER', 'PR_URL', 'COMMENTS', 'REPORT', 'CHECKS_DIR', 'COMMIT_MESSAGE', 'COMMIT_PREFIX', 'PROJECT', 'SKILL_DIR', 'PUSH', 'INSTALLED', 'LANGUAGE', 'LANDING', 'RULEBOOK', 'ABOVE', 'LOCAL', 'TASK', 'MEDIA', 'VISUAL', 'PRIORITY', 'RESTORE', 'WORKERS', 'VISUAL_BRIEF', 'LAND_BRIEF'];
// A part with this many items or more splits them among workers (split-work.cjs).
const workersFrom = 12;

function parseArgs(argv) {
  const args = { run: '', branch: '', push: 'yes', language: 'English' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'run') args.run = m[2];
    else if (m[1] === 'branch') args.branch = m[2];
    else if (m[1] === 'push') args.push = m[2];
    else if (m[1] === 'language') args.language = m[2];
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --branch, --push, --language).`);
  if (!args.run || !args.branch) throw new Error('--run and --branch are required.');
  if (!['yes', 'no'].includes(args.push)) throw new Error('--push takes yes or no.');
  return args;
}

// A plugin script, run as the documented CLI, its JSON answer parsed.
function runScript(script, args) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const last = String(res.stdout || '').trim().split(/\r?\n/).pop() || '';
  try {
    return JSON.parse(last);
  } catch {
    return { errors: [`${path.basename(script)} printed no JSON: ${String(res.stderr || res.stdout || '').trim().split(/\r?\n/)[0] || `exit ${res.status}`}`] };
  }
}

// `restore` (stack-preflight.cjs) as the commands that bring the files back, one per source part.
function restoreCommands(root, restore) {
  if (!Array.isArray(restore) || restore.length === 0) return 'none';
  const byFrom = new Map();
  for (const r of restore) {
    if (!byFrom.has(r.from)) byFrom.set(r.from, []);
    byFrom.get(r.from).push(r.path);
  }
  return [...byFrom.entries()].map(([from, paths]) => `- \`git -C "${root}" checkout origin/${from} -- ${paths.join(' ')}\``).join('\n');
}

function launch(options, deps = {}) {
  const run = deps.run || runScript;
  const runData = JSON.parse(fs.readFileSync(options.run, 'utf8'));
  const target = (runData.targets || []).find((t) => t.branch === options.branch);
  if (!target) throw new Error(`${options.branch} is not a target of ${options.run}.`);
  const project = runData.project || path.dirname(options.run);
  const out = { branch: target.branch, warnings: [], errors: [] };
  const added = run(path.join(__dirname, 'worktree.cjs'), ['--action=add', `--branch=${target.branch}`, `--project=${project}`]) || {};
  out.warnings.push(...(added.warnings || []));
  for (const key of ['heldBy', 'localBranch', 'mainBroken']) if (added[key]) out[key] = added[key];
  if ((added.errors || []).length > 0 || !added.worktree) {
    out.errors.push(...((added.errors || []).length ? added.errors : ['worktree.cjs made no worktree']));
    return out;
  }
  out.worktree = added.worktree;
  out.installed = Boolean(added.installed);
  // The main checkout's node_modules linked in (no install ran); false names an install, whose
  // reason is among the warnings.
  out.linked = Boolean(added.dependencies && added.dependencies.linked);
  out.visual = Boolean(added.visual);
  if (added.mainBroken) return out;
  const stack = (runData.stacks || []).find((s) => s.includes(target.branch));
  const counts = target.counts || {};
  const promptPath = target.promptPath;
  const stem = promptPath.replace(/\.md$/i, '');
  const values = {
    ROOT: added.worktree,
    BRANCH: target.branch,
    BASE: target.pr.base,
    PR_NUMBER: String(target.pr.number),
    PR_URL: target.pr.url,
    COMMENTS: target.commentsPath,
    REPORT: target.reportPath,
    CHECKS_DIR: target.checksDir,
    COMMIT_MESSAGE: target.commitMessage,
    COMMIT_PREFIX: target.commitPrefix,
    PROJECT: project,
    SKILL_DIR: skillDir,
    PUSH: options.push || 'yes',
    INSTALLED: added.installed ? 'yes' : 'no',
    LANGUAGE: options.language || 'English',
    LANDING: target.landing || 'rebase',
    RULEBOOK: added.rulebook || 'none',
    ABOVE: ((target.stack && target.stack.allAbove) || []).join(', ') || 'none',
    LOCAL: target.local ? 'yes' : 'no',
    TASK: counts.task ? 'yes' : 'no',
    MEDIA: counts.media > 0 ? 'yes' : 'no',
    VISUAL: added.visual ? JSON.stringify(added.visual) : 'none',
    // Lower goes first in the machine's slot queue: the bottom of a stack holds every landing.
    PRIORITY: String(stack ? Math.max(0, stack.indexOf(target.branch)) : 0),
    RESTORE: restoreCommands(added.worktree, target.restore),
    WORKERS: (counts.candidates || 0) >= workersFrom ? 'yes' : 'no',
    VISUAL_BRIEF: `${stem}-visual.md`,
    LAND_BRIEF: `${stem}-land.md`,
  };
  fs.mkdirSync(target.checksDir, { recursive: true });
  const varsPath = path.join(target.checksDir, 'brief-vars.json');
  fs.writeFileSync(varsPath, `${JSON.stringify(values, null, 1)}\n`, 'utf8');
  const rap = require('../../../scripts/render-agent-prompt.cjs');
  for (const [template, file] of [['fix-agent.md', promptPath], ['fix-visual-agent.md', values.VISUAL_BRIEF], ['fix-land-agent.md', values.LAND_BRIEF]]) {
    const rendered = rap.renderFile({ template: path.join(references, template), out: file, values });
    if (rendered.errors.length) out.errors.push(...rendered.errors.map((e) => `${template}: ${e}`));
  }
  if (out.errors.length) return out;
  Object.assign(out, { promptPath, visualBrief: values.VISUAL_BRIEF, landBrief: values.LAND_BRIEF, varsPath });
  return out;
}

function main() {
  let result;
  try {
    result = launch(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, launch, briefNames, restoreCommands, runScript };

if (require.main === module) main();
