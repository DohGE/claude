#!/usr/bin/env node
'use strict';

// Builds the project the fixPr meter runs on: a git repository whose branch `feature/meter`
// carries pull request #7 of key.json, with a bare `origin` beside it so the fix agent's push
// lands without GitHub, and the recording of the pull request's review that `pr-comments.cjs
// --replay` reads in place of the GitHub API.
//
//   <out>/origin.git   the remote: `main` and `feature/meter`
//   <out>/shop         the checkout, standing on `main` (the worktree guard refuses a branch
//                      checked out anywhere) with an empty `.claude/` so the run's artifacts
//                      land in `.claude/doh/`, not in the plugin
//   <out>/replay.json  the review: threads, conversation and review summaries, shaped like the
//                      API's answers; each entry also names its key item (`meterId`), which
//                      the brief the agent reads never carries
//   <out>/fixture.json what score-fix.cjs needs: the paths, the branch and the commit the run
//                      starts from
//
// Usage: node make-fixture.cjs --out=<empty or missing dir> [--key=<key.json>]
//   prints fixture.json; exit 1 when <out> holds anything already.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fixtureDir = path.join(__dirname, 'fixture');
const identity = ['-c', 'user.name=fixPr meter', '-c', 'user.email=meter@example.invalid'];

function parseArgs(argv) {
  const args = { out: null, key: path.join(__dirname, 'key.json') };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (m && m[1] === 'out') args.out = path.resolve(m[2]);
    else if (m && m[1] === 'key') args.key = path.resolve(m[2]);
    else throw new Error(`Unknown argument: ${arg} (expected --out=<dir> [--key=<key.json>]).`);
  }
  if (!args.out) throw new Error('Missing --out=<dir>.');
  return args;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else fs.copyFileSync(src, dest);
  }
}

// The anchor's 1-based line in the branch's file; a key whose anchor is missing or ambiguous
// would point every reader at the wrong line, so it stops the build.
function lineOf(lines, anchor, file) {
  const at = lines.map((line, i) => (line.trim() === anchor.trim() ? i + 1 : 0)).filter(Boolean);
  if (at.length !== 1) throw new Error(`${file}: anchor ${JSON.stringify(anchor)} found ${at.length} times, expected once.`);
  return at[0];
}

// GitHub's hunk for a comment ends at the commented line; the lines the branch added carry `+`.
function hunkFor(lines, line, baseText) {
  const from = Math.max(1, line - 3);
  const body = lines.slice(from - 1, line).map((text) => `${baseText.includes(`${text}\n`) ? ' ' : '+'}${text}`);
  return [`@@ -${from},${body.length} +${from},${body.length} @@`, ...body].join('\n');
}

function build(args) {
  if (fs.existsSync(args.out) && fs.readdirSync(args.out).length > 0) throw new Error(`${args.out} is not empty.`);
  const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
  const origin = path.join(args.out, 'origin.git');
  const project = path.join(args.out, 'shop');
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  git(origin, ['init', '--bare', '-q', '-b', key.pr.base]);
  git(project, ['init', '-q', '-b', key.pr.base]);
  git(project, ['config', 'core.autocrlf', 'false']);
  copyTree(path.join(fixtureDir, 'main'), project);
  git(project, ['add', '-A']);
  git(project, [...identity, 'commit', '-q', '-m', 'chore: cart library']);
  git(project, ['remote', 'add', 'origin', origin]);
  git(project, ['push', '-q', 'origin', key.pr.base]);
  git(project, ['checkout', '-q', '-b', key.branch]);
  copyTree(path.join(fixtureDir, 'branch'), project);
  git(project, ['add', '-A']);
  git(project, [...identity, 'commit', '-q', '-m', key.pr.title]);
  git(project, ['push', '-q', '-u', 'origin', key.branch]);
  const headBefore = git(project, ['rev-parse', 'HEAD']);
  git(project, ['checkout', '-q', key.pr.base]);
  fs.mkdirSync(path.join(project, '.claude'));
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), '.claude/\n');

  const branchText = (file) => fs.readFileSync(path.join(fixtureDir, 'branch', file), 'utf8');
  const baseText = (file) => {
    try {
      return fs.readFileSync(path.join(fixtureDir, 'main', file), 'utf8');
    } catch {
      return '';
    }
  };
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 9, n)).toISOString();
  const replay = { branch: key.branch, pr: key.pr, threads: [], conversation: [], reviews: [] };
  key.items.forEach((item, k) => {
    const comments = item.comments.map((c, j) => ({
      author: c.author,
      isBot: Boolean(item.isBot),
      body: c.body,
      createdAt: at(k * 2 + j),
      url: item.kind === 'thread'
        ? `${key.pr.url}#discussion_r${1000 + k * 10 + j}`
        : `${key.pr.url}#${item.kind === 'review' ? 'pullrequestreview' : 'issuecomment'}-${2000 + k}`,
    }));
    if (item.kind === 'thread') {
      const lines = branchText(item.path).split(/\r?\n/);
      const line = item.outdated ? null : lineOf(lines, item.anchor, item.path);
      replay.threads.push({
        meterId: item.id,
        id: `PRRT_meter_${item.id}`,
        isResolved: false,
        isOutdated: Boolean(item.outdated),
        viewerCanResolve: true,
        path: item.path,
        line,
        startLine: null,
        originalLine: item.outdated ? item.outdated.originalLine : line,
        originalStartLine: null,
        diffSide: 'RIGHT',
        diffHunk: item.outdated ? item.outdated.diffHunk : hunkFor(lines, line, baseText(item.path)),
        comments,
      });
    } else if (item.kind === 'conversation') {
      replay.conversation.push({ meterId: item.id, ...comments[0] });
    } else {
      replay.reviews.push({ meterId: item.id, ...comments[0], state: item.state });
    }
  });
  const replayPath = path.join(args.out, 'replay.json');
  fs.writeFileSync(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
  const fixture = {
    project, origin, branch: key.branch, base: key.pr.base, headBefore, replay: replayPath, key: args.key,
  };
  fs.writeFileSync(path.join(args.out, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(build(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, build, lineOf, hunkFor };

if (require.main === module) main();
