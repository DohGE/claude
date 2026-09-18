#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:fixPrComments skill: argument parsing,
// the commit message derived from the pull request title, and the per-branch
// JSON of everything a reviewer said that is still open.
//
// The comment bodies never travel through the orchestrator's context: they are
// written to a file per branch and the fixing agent is handed the PATH. A pull
// request review can run to tens of thousands of words, and pasting it into the
// conversation is what turns a three-branch run into a context overflow.

const fs = require('node:fs');
const path = require('node:path');

const github = require('../../codeReview/scripts/github.cjs');
const {
  sanitizeBranchName, formatTimestamp, pruneReports, ensureDohGitignore, tryGit,
} = require('../../codeReview/scripts/review-context.cjs');
const prApi = require('./pr-api.cjs');
const { worktreePathFor } = require('./worktree.cjs');

const defaultSkillDir = path.resolve(__dirname, '..');
const artifactsRetain = 30;

function parseArgs(argv) {
  const args = { branches: '', project: process.cwd(), skillDir: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'branches') args.branches = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'skill-dir') args.skillDir = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --branches, --project, --skill-dir).`);
  }
  return args;
}

// `feat(TASK-1): New Feature` -> `feat(TASK-1): CR`. The rule is the pull
// request title up to and including its FIRST colon, then ` CR`.
// A title with no colon has no prefix to cut off, so the whole title becomes the
// prefix and the colon is supplied - `Fix login bug` -> `Fix login bug: CR`. That
// keeps the message derived from the title the user pointed at, rather than
// inventing one from the branch name.
// A title that OPENS with the colon leaves an empty prefix, and `: CR` names
// nothing at all; the leading colons are dropped and the rest used instead.
function commitMessageFor(title) {
  const text = String(title == null ? '' : title).trim();
  if (!text) return null;
  const at = text.indexOf(':');
  const prefix = (at === -1 ? text : text.slice(0, at)).trim();
  if (prefix) return `${prefix}: CR`;
  const rest = text.replace(/^:+/, '').trim();
  return rest ? `${rest}: CR` : null;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The JSON artifacts are stamped like the reports next to them, so the same
// cap applies - `pruneReports` only ever counts `.md`/`.html`, and an
// uncapped folder of comment dumps would grow for the life of the branch.
function pruneArtifacts(branchDir, retain = artifactsRetain) {
  let names;
  try {
    names = fs.readdirSync(branchDir);
  } catch {
    return;
  }
  const stamped = names
    .filter((name) => /-fix-pr-comments-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => {
      const full = path.join(branchDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { full } of stamped.slice(retain)) {
    try {
      fs.unlinkSync(full);
    } catch {}
  }
}

// One branch, start to finish. Every failure that stops THIS branch is pushed to
// `errors` and the branch is dropped; a run over three branches keeps going for
// the other two, because one missing pull request is no reason to abandon work
// the user asked for on the rest.
function collectBranch(branch, ctx) {
  const { project, reportsDir, stamp, api, findPr, result } = ctx;
  const found = findPr(project, branch);
  if (!result.tokenSource && found.tokenSource) result.tokenSource = found.tokenSource;
  if (!found.slug) {
    result.errors.push(`${branch}: no github.com remote in ${project}, so there is no pull request to read.`);
    return null;
  }
  if (found.error) {
    result.errors.push(`${branch}: GitHub API: ${found.error} (token source: ${found.tokenSource || 'none found, tried ' + (found.triedTokenSources || []).join(', ')}).`);
    return null;
  }
  if (!found.pr) {
    result.errors.push(`${branch}: no OPEN pull request has this branch as its head.`);
    return null;
  }
  const pr = found.pr;
  const commitMessage = commitMessageFor(pr.title);
  if (!commitMessage) {
    result.errors.push(`${branch}: pull request #${pr.number} has a title (${JSON.stringify(pr.title)}) that yields no commit message.`);
    return null;
  }

  const threads = api.reviewThreads(project, found.slug, pr.number);
  if (threads.error) {
    result.errors.push(`${branch}: could not read the review threads of #${pr.number}: ${threads.error}`);
    return null;
  }
  if (threads.truncated) {
    result.warnings.push(`${branch}: the review-thread list came back incomplete; this run covers only the threads it received.`);
  }
  const open = threads.threads.filter((thread) => !thread.isResolved);
  const resolvedCount = threads.threads.length - open.length;
  if (open.some((thread) => !thread.viewerCanResolve)) {
    result.warnings.push(`${branch}: the token cannot resolve some threads of #${pr.number}; those stay open on GitHub even once fixed.`);
  }

  const conversation = api.issueComments(project, found.slug, pr.number);
  if (conversation.error) {
    result.warnings.push(`${branch}: could not read the conversation comments of #${pr.number}: ${conversation.error}`);
  }
  const reviews = api.reviewBodies(project, found.slug, pr.number);
  if (reviews.error) {
    result.warnings.push(`${branch}: could not read the review summaries of #${pr.number}: ${reviews.error}`);
  }

  const candidates = open.length + conversation.comments.length + reviews.reviews.length;
  if (candidates === 0) {
    result.warnings.push(`${branch}: pull request #${pr.number} has nothing open to fix${resolvedCount ? ` (${resolvedCount} thread(s) already resolved)` : ''}; skipped.`);
    return null;
  }

  const dir = sanitizeBranchName(branch);
  const branchDir = path.join(reportsDir, dir);
  fs.mkdirSync(branchDir, { recursive: true });
  pruneArtifacts(branchDir);
  const commentsPath = path.join(branchDir, `${dir}-fix-pr-comments-${stamp}.json`);
  const reportPath = path.join(branchDir, `${dir}-fix-pr-comments-${stamp}.md`);
  const payload = {
    branch,
    pr: { number: pr.number, title: pr.title, url: pr.url, base: pr.base },
    commitMessage,
    generatedAt: new Date(ctx.now).toISOString(),
    resolvedThreadCount: resolvedCount,
    threads: open,
    conversation: conversation.comments,
    reviews: reviews.reviews,
  };
  fs.writeFileSync(commentsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return {
    branch,
    pr: payload.pr,
    commitMessage,
    commentsPath,
    reportPath,
    worktree: worktreePathFor(project, branch),
    counts: {
      openThreads: open.length,
      resolvedThreads: resolvedCount,
      outdatedThreads: open.filter((thread) => thread.isOutdated).length,
      conversation: conversation.comments.length,
      reviews: reviews.reviews.length,
      candidates,
    },
  };
}

function collect(options) {
  const project = path.resolve(options.project || process.cwd());
  const skillDir = options.skillDir || defaultSkillDir;
  const now = options.now || new Date();
  const api = options.api || prApi;
  const findPr = options.findOpenPr || github.findOpenPr;
  const result = {
    project, tokenSource: null, targets: [], errors: [], warnings: [],
  };

  if (tryGit(project, ['rev-parse', '--git-dir']) === null) {
    result.errors.push(`Not a git repository: ${project}`);
    return result;
  }

  const names = [...new Set(String(options.branches || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) {
    result.errors.push('No branches given (expected --branches="a,b;c").');
    return result;
  }
  // Two branches can sanitise to one folder name (`feature/x` and `feature-x`
  // both become `feature-x`), and their artifacts would then overwrite each
  // other inside one run.
  const byDir = new Map();
  for (const name of names) {
    const dir = sanitizeBranchName(name);
    if (byDir.has(dir)) {
      result.warnings.push(`Branches ${byDir.get(dir)} and ${name} share the artifact folder ${dir}; run them separately to keep their files apart.`);
    } else byDir.set(dir, name);
  }

  // Same convention as codeReview: a project that already keeps a `.claude/`
  // folder collects its doh artifacts there, everything else falls back to the
  // skill's own reports dir.
  const projectClaudeDir = path.join(project, '.claude');
  const reportsDir = isDirectory(projectClaudeDir)
    ? path.join(projectClaudeDir, 'doh')
    : path.join(skillDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  if (reportsDir.startsWith(projectClaudeDir)) ensureDohGitignore(reportsDir);
  try {
    pruneReports(reportsDir);
  } catch {
    // best-effort, exactly as in codeReview
  }

  const ts = formatTimestamp(now);
  const ctx = { project, reportsDir, stamp: `${ts.date}-${ts.time}`, api, findPr, result, now };
  for (const branch of names) {
    const target = collectBranch(branch, ctx);
    if (target) result.targets.push(target);
  }
  return result;
}

function main() {
  let result;
  try {
    result = collect(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { targets: [], errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.targets.length > 0 ? 0 : 1);
}

module.exports = { parseArgs, commitMessageFor, pruneArtifacts, collectBranch, collect };

if (require.main === module) main();
