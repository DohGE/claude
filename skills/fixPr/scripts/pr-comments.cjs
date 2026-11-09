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
  const args = { branches: '', project: process.cwd(), skillDir: '', replay: '', local: null, task: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'branches') args.branches = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'skill-dir') args.skillDir = m[2];
    else if (m[1] === 'replay') args.replay = m[2];
    else if (m[1] === 'task') args.task = m[2].trim();
    else if (m[1] === 'local') args.local = m[2].split(/[\s,;]+/).map((id) => id.trim().toLowerCase()).filter(Boolean);
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --branches, --project, --skill-dir, --replay, --local, --task).`);
  }
  if (args.local !== null && args.local.length === 0) {
    throw new Error('--local needs the ids of the codeReview findings to fix (--local="da3d32cd,b4309764").');
  }
  const bad = (args.local || []).filter((id) => !reFindingId.test(id));
  if (bad.length > 0) {
    throw new Error(`--local: ${bad.join(', ')} is no codeReview finding id - an id is the 8 hex characters the report shows on a finding (e.g. da3d32cd, or da3d32cd-2 for a repeat).`);
  }
  return args;
}

// A finding's id in a codeReview report (render-report.cjs findingId): 8 hex characters, and a
// `-<n>` suffix for the second identical finding of a file.
const reFindingId = /^[0-9a-f]{8}(?:-\d+)?$/;

// The codeReview reports of one branch, newest run first: `<root>/runs/<stamp>/<branch>/raport.html`
// (its findings in the page's `report-data` JSON) or `raport.md` (parsed the way the renderer does).
function reportFilesOf(project, branch, skillDir) {
  const dir = sanitizeBranchName(branch);
  const roots = [path.join(project, '.claude', 'doh', 'codeReview'), path.join(skillDir, '..', 'codeReview', 'reports')];
  const out = [];
  for (const root of roots) {
    let stamps = [];
    try {
      stamps = fs.readdirSync(path.join(root, 'runs'));
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      for (const name of ['raport.html', 'raport.md']) {
        const file = path.join(root, 'runs', stamp, dir, name);
        if (fs.existsSync(file)) out.push({ stamp, file });
      }
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.file.endsWith('.html') ? -1 : 1));
}

function findingsOfReport(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    const m = text.match(/<script id="report-data"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    const data = JSON.parse(m[1].replace(/<\\\/script/gi, '</script'));
    return (data.files || []).flatMap((f) => (f.findings || []).map((finding) => ({ ...finding, file: finding.file || f.path })));
  }
  const report = require('../../codeReview/scripts/render-report.cjs').parseReport(text);
  return report.files.flatMap((f) => f.findings.map((finding) => ({ ...finding, file: f.path })));
}

// The findings of `ids` the branch's reports hold, each from the newest report that has it,
// as the agent reads them: where, how bad, what is wrong, what is expected, and which report.
function localFindings(project, branch, ids, skillDir) {
  const wanted = new Set(ids);
  const found = new Map();
  for (const { file } of reportFilesOf(project, branch, skillDir)) {
    let findings = [];
    try {
      findings = findingsOfReport(file);
    } catch {
      continue;
    }
    for (const f of findings) {
      const id = String(f.id || '').toLowerCase();
      if (!wanted.has(id) || found.has(id)) continue;
      found.set(id, {
        id,
        path: f.file,
        lines: f.lines,
        severity: f.severity,
        rule: f.rule,
        problem: f.problem,
        expected: f.expected,
        ...(f.prProblem ? { prProblem: f.prProblem } : {}),
        ...(f.prExpected ? { prExpected: f.prExpected } : {}),
        ...(f.prLocations ? { prLocations: f.prLocations } : {}),
        report: file.replace(/\\/g, '/'),
      });
    }
  }
  return ids.filter((id) => found.has(id)).map((id) => found.get(id));
}

// A recorded review in place of the GitHub API - the fixPr meter (test-key/README.md) runs the
// skill on a fixture with no pull request behind it. The file holds what the API would answer
// for one branch: `{ branch, pr, threads, conversation, reviews }`, threads in the shape
// `reviewThreads` returns. Fields beyond that shape never reach the brief: briefThread and
// briefNote copy only the ones the agent's contract names.
function replaySource(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const threads = (data.threads || []).map((thread) => ({ isResolved: false, viewerCanResolve: true, ...thread, comments: thread.comments || [] }));
  return {
    findOpenPr: (project, branch) => ({ slug: 'replay', tokenSource: 'replay', pr: !data.branch || data.branch === branch ? data.pr : null }),
    api: {
      reviewThreads: () => ({ threads }),
      issueComments: () => ({ comments: data.conversation || [] }),
      reviewBodies: () => ({ reviews: data.reviews || [] }),
    },
  };
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
  if (comment.media) out.media = comment.media;
  return out;
}

// A scanner bot posts the same report on every push: three copies of one CVE table sat in the
// conversation of each DPXN-11967 part (2026-11-05), ~2k tokens apiece, every one `answered`.
// Only the newest copy of each bot report travels, cut to its head; the count says how many went.
const botBodyChars = 1500;
function dedupeBotNotes(notes) {
  const keyOf = (n) => `${n.author}\n${String(n.body || '').replace(/[0-9a-f]{7,40}/gi, '#').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  const newest = new Map();
  notes.forEach((n, i) => { if (n.isBot) newest.set(keyOf(n), i); });
  const kept = [];
  let dropped = 0;
  notes.forEach((n, i) => {
    if (!n.isBot) { kept.push(n); return; }
    if (newest.get(keyOf(n)) !== i) { dropped += 1; return; }
    const body = String(n.body || '');
    kept.push(body.length > botBodyChars ? { ...n, body: `${body.slice(0, botBodyChars)}\n[... ${body.length - botBodyChars} more characters of this bot report left out]` } : n);
  });
  return { notes: kept, dropped };
}

// Attachments of every comment, thread reply and review summary, downloaded once for the run
// (pr-media.cjs). Each one comes back on its comment as `media[]`.
function attachMedia(open, notes, reviews, ctx, found, pr, mediaDir) {
  const items = [];
  open.forEach((thread, t) => (thread.comments || []).forEach((c, k) => items.push({ key: `thread-${t + 1}-${k + 1}`, kind: 'review-comment', id: c.id, body: c.body, target: c })));
  notes.forEach((n) => items.push({ key: `conversation-${n.id}`, kind: 'issue-comment', id: n.id, body: n.body, target: n }));
  reviews.forEach((r) => items.push({ key: `review-${r.id}`, kind: 'review', id: r.id, body: r.body, target: r }));
  const withMedia = items.filter((item) => require('./pr-media.cjs').mediaUrls(item.body).length > 0);
  if (withMedia.length === 0) return { count: 0, warnings: [] };
  const { media, warnings } = ctx.collectMedia({ project: ctx.project, slug: found.slug, prNumber: pr.number, items: withMedia, dir: mediaDir });
  let count = 0;
  for (const item of withMedia) {
    const entries = media.get(item.key);
    if (entries && entries.length) {
      item.target.media = entries;
      count += entries.length;
    }
  }
  return { count, warnings };
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
  // The id is what the agent's `verdicts[]` names a conversation comment or a review by, and
  // what verify-fix.cjs checks every item of this file against.
  if (note.id != null) out.id = note.id;
  if (note.state) out.state = note.state;
  if (note.media) out.media = note.media;
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

function artifactPaths(branch, reportsDir, stamp) {
  const dir = sanitizeBranchName(branch);
  const branchDir = path.join(reportsDir, dir);
  fs.mkdirSync(branchDir, { recursive: true });
  pruneArtifacts(branchDir);
  return {
    commentsPath: path.join(branchDir, `${dir}-fix-pr-${stamp}.json`),
    reportPath: path.join(branchDir, `${dir}-fix-pr-${stamp}.md`),
    // Where the branch's agent brief is rendered. Deliberately unstamped: one file
    // per branch, overwritten by each run, so the orchestrator never computes a
    // path of its own and the folder does not grow a prompt per run. Two runs
    // cannot race for it - the worktree guard refuses a second run on one branch.
    promptPath: path.join(branchDir, `${dir}-fix-pr-agent-prompt.md`),
    // Where checks.cjs writes one log per gate step. Unstamped for the same reason
    // as the brief, and outside the worktree for the same reason as the report: a
    // build log written inside the checkout is a file the commit could pick up.
    checksDir: path.join(branchDir, `${dir}-fix-pr-checks`),
    // The screenshots and recordings of the comments (pr-media.cjs), replaced each run.
    mediaDir: path.join(branchDir, `${dir}-fix-pr-media`),
  };
}

// `--local`: the branch's work is the codeReview findings whose ids the user named, read from the
// branch's reports, in place of the pull request's comments. The pull request still names the
// base, the commit message and where the push goes; nothing is read from or resolved on its threads.
function collectLocal(branch, pr, commitMessage, ctx) {
  const { project, reportsDir, stamp, result } = ctx;
  const findings = localFindings(project, branch, ctx.local, ctx.skillDir);
  for (const f of findings) ctx.matched.add(f.id);
  if (findings.length === 0) {
    result.warnings.push(`${branch}: none of the --local ids is in a codeReview report of this branch; this run will only bring its checks green.`);
  }
  const { commentsPath, reportPath, promptPath, checksDir } = artifactPaths(branch, reportsDir, stamp);
  const payload = {
    branch,
    pr: { number: pr.number, title: pr.title, url: pr.url, base: pr.base },
    commitMessage,
    generatedAt: new Date(ctx.now).toISOString(),
    source: 'local',
    ...(ctx.task ? { task: ctx.task } : {}),
    threads: [],
    conversation: [],
    reviews: [],
    findings,
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
    local: true,
    counts: {
      findings: findings.length,
      openThreads: 0,
      resolvedThreads: 0,
      outdatedThreads: 0,
      conversation: 0,
      reviews: 0,
      candidates: findings.length + (ctx.task ? 1 : 0),
      humanCandidates: findings.length + (ctx.task ? 1 : 0),
      ...(ctx.task ? { task: true } : {}),
    },
  };
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

  // `--local`: the work is the codeReview findings named by id, not the pull request's comments.
  if (ctx.local) return collectLocal(branch, pr, commitMessage, ctx);

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
  if (candidates === 0 && !ctx.task) {
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

  const { commentsPath, reportPath, promptPath, checksDir, mediaDir } = artifactPaths(branch, reportsDir, stamp);
  // The gate's files of an earlier run: on 2026-11-06 two agents found gate-2.json taken by one
  // and wrote their pass beside it as gate-2.json.tmp. Each run starts with the folder empty.
  try {
    fs.rmSync(checksDir, { recursive: true, force: true });
  } catch {
    // a log another process holds stays; the passes of this run overwrite their own files
  }
  const bots = dedupeBotNotes(conversation.comments);
  let mediaCount = 0;
  if (ctx.collectMedia) {
    try {
      const attached = attachMedia(open, bots.notes, reviews.reviews, ctx, found, pr, mediaDir);
      mediaCount = attached.count;
      for (const w of attached.warnings) result.warnings.push(`${branch}: ${w}`);
    } catch (err) {
      result.warnings.push(`${branch}: the attachments of the comments could not be downloaded (${(err && err.message) || err}); the agent reads their words only.`);
    }
  }
  const payload = {
    branch,
    pr: { number: pr.number, title: pr.title, url: pr.url, base: pr.base },
    commitMessage,
    generatedAt: new Date(ctx.now).toISOString(),
    resolvedThreadCount: resolvedCount,
    ...(bots.dropped ? { botDuplicatesDropped: bots.dropped } : {}),
    ...(ctx.task ? { task: ctx.task } : {}),
    threads: open.map(briefThread),
    conversation: bots.notes.map(briefNote),
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
      conversation: bots.notes.length,
      reviews: reviews.reviews.length,
      candidates: candidates - bots.dropped + (ctx.task ? 1 : 0),
      ...(ctx.task ? { task: true } : {}),
      humanCandidates,
      ...(mediaCount ? { media: mediaCount } : {}),
    },
  };
}

// Where every branch stands on origin now, in one `ls-remote`: the lease a held part is pushed
// with, and the old tip its children are moved off once that part is rewritten.
function remoteTips(project, branches, run = tryGit) {
  const tips = new Map();
  if (branches.length === 0) return tips;
  const out = run(project, ['ls-remote', 'origin', ...branches.map((b) => `refs/heads/${b}`)]);
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);
    if (m) tips.set(m[2].trim(), m[1]);
  }
  return tips;
}

// Pull requests of one run that build on each other - a stack, each one's base the branch of
// another - land bottom-up. Landed side by side, each rebased at its own finish: part-1 rebased
// onto master rewrote the commits part-2 sat on (its rebase then conflicted), and part-4 pushed
// before part-3 did, so it stayed on the old part-3 (DPXN-11966, 2026-11-03). So a part above
// the bottom only commits (`hold`) and the orchestrator moves it onto its parent once that one
// has landed (restack.cjs); the bottom keeps its base unless it no longer merges (`keep-base`),
// since a rebase there rewrites every part above it; a branch outside any stack `rebase`s.
//
// The stack is read from GitHub too (`gh`: `isPrHead(branch)`, `childrenOf(branch)`), never from
// the named branches alone. On 2026-11-06 part-2's threads failed to load, and part-1 - alone
// in the run - came out `rebase`: its agent would have rebased it onto master under four open
// pull requests. The same day part-4, named alone, came out `rebase` with no parent. A part whose
// base is another open pull request's branch is held; one with open pull requests above it keeps
// its base, and those parts travel as `stack.above` for the cascade after it lands.
function annotateStacks(targets, tips = new Map(), gh = null) {
  const warnings = [];
  const byBranch = new Map(targets.map((t) => [t.branch, t]));
  const parentOf = new Map();
  for (const t of targets) {
    const base = t.pr && t.pr.base;
    if (base && base !== t.branch && byBranch.has(base)) parentOf.set(t.branch, base);
  }
  // Two pull requests based on each other have no bottom: the first of them in the run's order
  // lands by itself.
  for (const t of targets) {
    const seen = new Set([t.branch]);
    for (let at = parentOf.get(t.branch); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) {
        warnings.push(`${[...seen].join(', ')} are based on each other in a cycle; ${t.branch} lands first, on its own base.`);
        parentOf.delete(t.branch);
        break;
      }
      seen.add(at);
    }
  }
  const childrenOf = new Map(targets.map((t) => [t.branch, []]));
  for (const t of targets) if (parentOf.has(t.branch)) childrenOf.get(parentOf.get(t.branch)).push(t.branch);
  const ordered = [];
  const stacks = [];
  const visit = (branch, chain) => {
    ordered.push(byBranch.get(branch));
    chain.push(branch);
    for (const child of childrenOf.get(branch)) visit(child, chain);
  };
  for (const t of targets) {
    if (parentOf.has(t.branch)) continue;
    const chain = [];
    visit(t.branch, chain);
    if (chain.length > 1) stacks.push(chain);
  }
  const isPrHead = (gh && gh.isPrHead) || (() => false);
  const named = new Set(targets.map((t) => t.branch));
  for (const t of ordered) {
    let parent = parentOf.get(t.branch) || null;
    const base = t.pr && t.pr.base;
    const outside = !parent && Boolean(base) && base !== t.branch && !named.has(base) && isPrHead(base);
    if (outside) parent = base;
    const children = childrenOf.get(t.branch);
    const above = children.length === 0 && gh && gh.childrenOf ? stackAbove(t.branch, gh.childrenOf, warnings) : [];
    t.remoteTipAtStart = tips.get(t.branch) || null;
    t.stack = { parent, children, parentTipAtStart: parent ? tips.get(parent) || null : null };
    if (outside) t.stack.parentOutsideRun = true;
    if (above.length) t.stack.above = above;
    t.landing = parent ? 'hold' : children.length > 0 || above.length > 0 ? 'keep-base' : 'rebase';
  }
  // Every open pull request stacked above a part, in the run or not: what its fix must not break
  // (the brief's ABOVE, symbol-uses.cjs --refs).
  const allAbove = (branch, seen = new Set()) => {
    const t = byBranch.get(branch);
    if (!t || seen.has(branch)) return [];
    seen.add(branch);
    return [...t.stack.children.flatMap((c) => [c, ...allAbove(c, seen)]), ...(t.stack.above || [])];
  };
  for (const t of ordered) t.stack.allAbove = allAbove(t.branch);
  return { targets: ordered, stacks, warnings };
}

// The open pull requests based on `branch`: the parts of its stack above it. A follow-up task
// (--task) on part-1 changes what part-2..5 sit on, and those are moved after it lands
// (restack.cjs --action=cascade) - even when the run named part-1 alone.
function openChildren(project, branch, request = github.request) {
  const slug = github.repoSlug(project);
  if (!slug) return [];
  const res = request(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=100&base=${encodeURIComponent(branch)}` });
  return res && res.ok && Array.isArray(res.json) ? res.json.map((pr) => pr.head && pr.head.ref).filter(Boolean) : [];
}

function stackAbove(branch, childrenOf, warnings, limit = 20) {
  const chain = [];
  for (let at = branch; chain.length < limit;) {
    const kids = childrenOf(at).filter((k) => k !== branch && !chain.includes(k));
    if (kids.length === 0) break;
    if (kids.length > 1) warnings.push(`${at} has ${kids.length} open pull requests based on it (${kids.join(', ')}); only ${kids[0]} and the parts above it are moved after the task.`);
    chain.push(kids[0]);
    at = kids[0];
  }
  return chain;
}

function collect(options) {
  const project = path.resolve(options.project || process.cwd());
  const skillDir = options.skillDir || defaultSkillDir;
  const now = options.now || new Date();
  const replay = options.replay ? replaySource(options.replay) : null;
  const api = options.api || (replay && replay.api) || prApi;
  const findPr = options.findOpenPr || (replay && replay.findOpenPr) || github.findOpenPr;
  const result = {
    project, tokenSource: null, targets: [], stacks: [], errors: [], warnings: [],
  };
  if (replay) result.warnings.push(`Review replayed from ${options.replay}: nothing is read from GitHub, and resolve-threads.cjs only rehearses.`);

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
  const local = Array.isArray(options.local) ? options.local : null;
  // Attachments come from GitHub itself: never in a replay, and in a test only when it hands in
  // its own collector.
  const collectMedia = options.collectMedia !== undefined
    ? options.collectMedia
    : (replay || options.api || options.media === false ? null : (args) => require('./pr-media.cjs').collectMedia({ ...args, token: github.token(project), request: github.request }));
  const task = String(options.task || '').trim() || null;
  const ctx = { project, reportsDir, stamp: `${ts.date}-${ts.time}`, api, findPr, result, now, skillDir, local, matched: new Set(), collectMedia, task };
  for (const branch of names) {
    const target = collectBranch(branch, ctx);
    if (target) result.targets.push(target);
  }
  // A replayed review reads nothing from the network, the remote's tips included.
  const tipNames = [...new Set(result.targets.flatMap((t) => [t.branch, t.pr && t.pr.base].filter(Boolean)))];
  const tips = replay ? new Map() : (options.remoteTips || remoteTips)(project, tipNames);
  const heads = new Map();
  const gh = replay ? null : {
    isPrHead: options.isPrHead || ((branch) => {
      if (!heads.has(branch)) {
        const found = findPr(project, branch);
        heads.set(branch, Boolean(found && found.pr));
      }
      return heads.get(branch);
    }),
    childrenOf: options.openChildren || ((branch) => openChildren(project, branch)),
  };
  const stacked = annotateStacks(result.targets, tips, gh);
  result.targets = stacked.targets;
  result.stacks = stacked.stacks;
  result.warnings.push(...stacked.warnings);
  // Code newer than the branch's last codeReview was read by the reviewers alone: on 2026-11-06,
  // 9 of 24 threads of DPXN-11967 sat on such code. Named per branch, with the command that
  // reviews just that, so the next round of comments is not the review the skill could have made.
  if (!replay) {
    try {
      const freshness = (options.freshness || ((branches) => require('../../codeReview/scripts/review-freshness.cjs').check({ project, branches, bases: Object.fromEntries(result.targets.map((t) => [t.branch, t.pr && t.pr.base])) })))(result.targets.map((t) => t.branch));
      for (const b of freshness.branches || []) {
        const t = result.targets.find((x) => x.branch === b.branch);
        if (t) t.review = { reviewedAt: b.reviewedAt, unreviewedCommits: b.unreviewedCommits, changedFiles: b.changedFiles.length, command: b.command };
      }
      result.warnings.push(...(freshness.warnings || []));
    } catch {
      // a review history that cannot be read is no reason to stop the fixes
    }
  }
  // A branch of the stack that could not be collected still moves: say where it sits.
  const collected = new Set(result.targets.map((t) => t.branch));
  for (const t of result.targets) {
    for (const name of [...(t.stack.above || []), t.stack.parentOutsideRun ? t.stack.parent : null].filter(Boolean)) {
      if (names.includes(name) && !collected.has(name)) {
        result.warnings.push(`${name} was named but could not be collected (see errors); it is still part of the stack of ${t.branch}, which ${t.stack.parent === name ? 'is held on it' : 'keeps its base, and moves it with the cascade after landing'}.`);
      }
    }
  }
  if (local) {
    const missing = local.filter((id) => !ctx.matched.has(id));
    if (missing.length > 0) {
      result.warnings.push(`--local: ${missing.join(', ')} found in no codeReview report of ${names.join(', ')} - check the id on the report page, and that its branch is among the named ones.`);
    }
  }
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    // The meter starts the whole skill with the variable set; the orchestrator's command
    // stays the one SKILL.md prints.
    if (!args.replay && process.env.DOH_FIXPR_REPLAY) args.replay = process.env.DOH_FIXPR_REPLAY;
    result = collect(args);
    writeRunFile(result);
  } catch (err) {
    result = { targets: [], errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.targets.length > 0 ? 0 : 1);
}

// The run's state, for the scripts that act on it later: `restack.cjs --run=<file>` takes a
// part's worktree, parent, tips and checks folder from here (eight flags the orchestrator used
// to copy by hand, part by part), and `verify --run` its pairs.
function writeRunFile(result) {
  if (!result.targets || result.targets.length === 0) return null;
  const dir = path.dirname(path.dirname(result.targets[0].commentsPath));
  const stamp = formatTimestamp(new Date());
  const file = path.join(dir, `fixpr-run-${stamp.date}-${stamp.time}.json`);
  result.runPath = file;
  fs.writeFileSync(file, `${JSON.stringify({ project: result.project, targets: result.targets, stacks: result.stacks }, null, 1)}\n`);
  return file;
}

module.exports = { writeRunFile, openChildren, stackAbove, dedupeBotNotes, parseArgs, commitPrefixFor, commitMessageFor, pruneArtifacts, collectBranch, collect, briefThread, briefNote, replaySource, localFindings, reportFilesOf, annotateStacks, remoteTips };

if (require.main === module) main();
