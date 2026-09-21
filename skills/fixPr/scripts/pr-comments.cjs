#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:fixPr skill: argument parsing,
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
// The brief holds what `references/fix-agent.md` names, and nothing else. A field the
// contract does not mention is weight the agent pays for on every run and, worse, policy
// it may invent a use for. On a real forty-thread pull request the unnamed ones came to
// nearly a fifth of the file. Two of them could not mean anything to a fixer even in
// principle: `isResolved` is false for every thread here - the resolved ones are filtered
// out above - and `viewerCanResolve` describes the token this run holds, not the work.
// `createdAt` and the comment id say nothing the order of the list and the url do not.
function briefComment(comment) {
  const out = {
    author: comment.author,
    isBot: Boolean(comment.isBot),
    body: comment.body,
    url: comment.url,
  };
  // Present only where it differs from the thread anchor, which is where it matters.
  if ('diffHunk' in comment) out.diffHunk = comment.diffHunk;
  return out;
}

function briefThread(thread) {
  const out = {
    id: thread.id,
    path: thread.path,
    line: thread.line,
    originalLine: thread.originalLine,
    isOutdated: thread.isOutdated,
    diffSide: thread.diffSide,
    diffHunk: thread.diffHunk,
    comments: (thread.comments || []).map(briefComment),
  };
  // A multi-line anchor is the one case where the span says something the single line
  // does not, so it travels exactly then rather than as a null on every thread.
  if (thread.startLine != null) out.startLine = thread.startLine;
  if (thread.originalStartLine != null) out.originalStartLine = thread.originalStartLine;
  return out;
}

function briefNote(note) {
  const out = { author: note.author, isBot: Boolean(note.isBot), body: note.body, url: note.url };
  if (note.state) out.state = note.state;
  return out;
}

function commitPrefixFor(title) {
  const text = String(title == null ? '' : title).trim();
  if (!text) return null;
  const at = text.indexOf(':');
  const prefix = (at === -1 ? text : text.slice(0, at)).trim();
  if (prefix) return prefix;
  const rest = text.replace(/^:+/, '').trim();
  return rest || null;
}

// The `CR` form, for a run that fixed at least one review comment. A run that
// fixed only red checks builds `<prefix>: Fix <labels>` instead, and it can only
// do that once the work is done - which is why the prefix travels to the agent
// beside this ready-made message rather than the message alone.
function commitMessageFor(title) {
  const prefix = commitPrefixFor(title);
  return prefix ? `${prefix}: CR` : null;
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
    // Both spellings: runs before the skill was renamed wrote
    // `-fix-pr-comments-<stamp>.json`, and a pattern that no longer matched them
    // would leave every one of those files in the folder for good.
    .filter((name) => /-fix-pr-(comments-)?\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(name))
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
  } else if (conversation.truncated) {
    result.warnings.push(`${branch}: the conversation of #${pr.number} is longer than this run pages through; it covers only the comments it received.`);
  }
  const reviews = api.reviewBodies(project, found.slug, pr.number);
  if (reviews.error) {
    result.warnings.push(`${branch}: could not read the review summaries of #${pr.number}: ${reviews.error}`);
  } else if (reviews.truncated) {
    result.warnings.push(`${branch}: the review list of #${pr.number} is longer than this run pages through; it covers only the summaries it received.`);
  }

  const candidates = open.length + conversation.comments.length + reviews.reviews.length;
  // Not a reason to drop the branch any more. A run is responsible for the whole
  // pull request, and one with every comment resolved can still be sitting on a
  // red build - which is exactly the branch a reviewer expects this skill to
  // finish off. The warning says what the run narrowed to, not that it stopped.
  if (candidates === 0) {
    result.warnings.push(`${branch}: pull request #${pr.number} has no open comments${resolvedCount ? ` (${resolvedCount} thread(s) already resolved)` : ''}; this run will only bring its checks green.`);
  }

  // A review bot can open dozens of threads on its own, and counted with the reviewers
  // they look like a pull request somebody asked for changes on. Saying so is not a
  // reason to skip them - an inline bot comment sits on a real line - but it is what
  // tells the reader that no person has written anything here yet, which changes what
  // a green run at the end of it actually means. A thread counts as a person's the
  // moment one of its comments is, replies included.
  const humanCandidates = open.filter((thread) => !thread.comments.length || thread.comments.some((c) => !c.isBot)).length
    + conversation.comments.filter((c) => !c.isBot).length
    + reviews.reviews.filter((r) => !r.isBot).length;
  if (candidates > 0 && humanCandidates === 0) {
    result.warnings.push(`${branch}: every open comment on #${pr.number} came from a GitHub App - no reviewer has written one. They are still fixed on their merits; nobody is waiting on the result.`);
  }

  const dir = sanitizeBranchName(branch);
  const branchDir = path.join(reportsDir, dir);
  fs.mkdirSync(branchDir, { recursive: true });
  pruneArtifacts(branchDir);
  const commentsPath = path.join(branchDir, `${dir}-fix-pr-${stamp}.json`);
  const reportPath = path.join(branchDir, `${dir}-fix-pr-${stamp}.md`);
  // Where the branch's agent brief is rendered. Deliberately unstamped: one file
  // per branch, overwritten by each run, so the orchestrator never computes a
  // path of its own and the folder does not grow a prompt per run. Two runs
  // cannot race for it - the worktree guard refuses a second run on one branch.
  const promptPath = path.join(branchDir, `${dir}-fix-pr-agent-prompt.md`);
  // Where checks.cjs writes one log per gate step. Unstamped for the same reason
  // as the brief, and outside the worktree for the same reason as the report: a
  // build log written inside the checkout is a file the commit could pick up.
  const checksDir = path.join(branchDir, `${dir}-fix-pr-checks`);
  const payload = {
    branch,
    pr: { number: pr.number, title: pr.title, url: pr.url, base: pr.base },
    commitMessage,
    generatedAt: new Date(ctx.now).toISOString(),
    resolvedThreadCount: resolvedCount,
    threads: open.map(briefThread),
    conversation: conversation.comments.map(briefNote),
    reviews: reviews.reviews.map(briefNote),
  };
  fs.writeFileSync(commentsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return {
    branch,
    pr: payload.pr,
    commitMessage,
    commitPrefix: commitPrefixFor(pr.title),
    commentsPath,
    reportPath,
    promptPath,
    checksDir,
    worktree: worktreePathFor(project, branch),
    counts: {
      openThreads: open.length,
      resolvedThreads: resolvedCount,
      outdatedThreads: open.filter((thread) => thread.isOutdated).length,
      conversation: conversation.comments.length,
      reviews: reviews.reviews.length,
      candidates,
      humanCandidates,
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

module.exports = { parseArgs, commitPrefixFor, commitMessageFor, pruneArtifacts, collectBranch, collect, briefThread, briefNote };

if (require.main === module) main();
