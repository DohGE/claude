#!/usr/bin/env node
'use strict';

// Opens the pull request of a finished task (SKILL.md, Final summary: "Shut down and create pull
// request"). The token, the owner/repo slug and the request itself are codeReview's github.cjs -
// the same six token sources the review and fixPr use - so the button needs no `gh` installed.
// A branch that already has an open pull request gets that one back, not a second.
//
// Usage: node create-pr.cjs --root=<repository> --head=<branch> --base=<branch> --title=<text> --body-file=<path>
// Prints one line, a FIXED IDENTIFIER: `PR_CREATED <url>`, `PR_EXISTS <url>` or `PR_FAILED <reason>`.

const fs = require('node:fs');
const path = require('node:path');

const github = require('../../codeReview/scripts/github.cjs');

function parseArgs(argv) {
  const args = { root: '', head: '', base: '', title: '', bodyFile: '' };
  for (const arg of argv) {
    const m = arg.match(/^--(root|head|base|title|body-file)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg} (expected --root, --head, --base, --title, --body-file)`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'head') args.head = m[2];
    else if (m[1] === 'base') args.base = m[2];
    else if (m[1] === 'title') args.title = m[2];
    else if (m[1] === 'body-file') args.bodyFile = m[2];
  }
  for (const key of ['root', 'head', 'base', 'title']) if (!args[key].trim()) throw new Error(`--${key} is required`);
  return args;
}

// `origin/master` and `refs/heads/x` are what a pipeline has to hand; GitHub wants the branch name.
const branchName = (ref) => String(ref).trim().replace(/^refs\/heads\//, '').replace(/^(?:refs\/remotes\/)?origin\//, '');

function createPr(options, { send = github.request, findPr = github.findOpenPr, slugOf = github.repoSlug } = {}) {
  const root = path.resolve(options.root);
  const head = branchName(options.head);
  const base = branchName(options.base);
  const slug = slugOf(root);
  if (!slug) return `PR_FAILED ${root} has no github.com remote`;
  if (head === base) return `PR_FAILED the branch ${head} is its own base`;
  const open = findPr(root, head);
  if (open && open.pr) return `PR_EXISTS ${open.pr.url}`;
  let body = '';
  if (options.bodyFile) {
    try {
      body = fs.readFileSync(options.bodyFile, 'utf8');
    } catch (err) {
      return `PR_FAILED cannot read ${options.bodyFile} (${err.message})`;
    }
  }
  const res = send(root, { path: `/repos/${slug.owner}/${slug.repo}/pulls`, method: 'POST',
    body: { title: options.title.trim(), head, base, body } });
  if (res.ok && res.json && res.json.html_url) return `PR_CREATED ${res.json.html_url}`;
  // Opened between the lookup and the request, by the user or another session.
  if (res.status === 422) {
    const again = findPr(root, head);
    if (again && again.pr) return `PR_EXISTS ${again.pr.url}`;
  }
  const detail = res.json && Array.isArray(res.json.errors) && res.json.errors.length
    ? `: ${res.json.errors.map((e) => e.message || e.code).filter(Boolean).join('; ')}` : '';
  return `PR_FAILED ${res.error || `HTTP ${res.status}`}${detail}`;
}

if (require.main === module) {
  let line;
  try {
    line = createPr(parseArgs(process.argv.slice(2)));
  } catch (err) {
    line = `PR_FAILED ${(err && err.message) || err}`;
  }
  process.stdout.write(`${line}\n`);
  process.exitCode = line.startsWith('PR_FAILED') ? 1 : 0;
}

module.exports = { parseArgs, createPr, branchName };
