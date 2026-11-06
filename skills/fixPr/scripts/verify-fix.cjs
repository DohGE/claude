#!/usr/bin/env node
'use strict';

// The last check of a branch's run: was every comment of the pull request actually dealt with?
//
// The fixing agent reports a verdict per item (fix-agent.md, `verdicts[]`). This holds that list
// against the comments file the agent was given and, after resolve-threads.cjs, against GitHub:
//
// - unaccounted   an item of the comments file no verdict names - a review summary with two
//                 requests in it, a thread verdicted on its first comment only, a reply that
//                 arrived while the agent worked (2026-11-05: the part-4 review asked for the
//                 checkbox padding AND the row highlight, and only the user noticed what was left);
// - noGround      a `rejected` or `answered` verdict without the ground the brief requires;
// - inconsistent  `fixed` threads and `fixedThreadIds` that do not say the same thing;
// - mediaNotSeen  an item with screenshots or a recording whose verdict does not say they were
//                 looked at (`sawMedia`);
// - stillOpen     (with --remote) a thread verdicted `fixed` that GitHub still shows unresolved;
// - newSinceRun   (with --remote) an unresolved thread the comments file never held.
//
// Usage: node verify-fix.cjs --comments=<commentsPath> --result=<agent result JSON file>
//        [--project=<dir>] [--remote=yes|no]
// Prints one JSON object; `ok` is false when any list above is non-empty.

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { comments: '', result: '', project: process.cwd(), remote: 'no' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'comments') args.comments = m[2].trim();
    else if (m[1] === 'result') args.result = m[2].trim();
    else if (m[1] === 'project') args.project = m[2].trim();
    else if (m[1] === 'remote') args.remote = m[2].trim();
    else unknown.push(arg);
  }
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --comments, --result, --project, --remote).`);
  if (!args.comments || !args.result) throw new Error('--comments and --result are required.');
  if (!['yes', 'no'].includes(args.remote)) throw new Error('--remote takes yes or no.');
  return args;
}

const hasMedia = (entry) => Array.isArray(entry.media) && entry.media.some((m) => m.path);

// Every item of the comments file, under the key a verdict names it by.
function itemsOf(comments) {
  const items = [];
  for (const t of comments.threads || []) {
    const first = (t.comments || [])[0] || {};
    items.push({ key: `thread:${t.id}`, kind: 'thread', id: t.id, author: first.author || null, url: first.url || null, path: t.path || null, media: (t.comments || []).some(hasMedia) });
  }
  for (const c of comments.conversation || []) {
    items.push({ key: `conversation:${c.id}`, kind: 'conversation', id: c.id, author: c.author || null, url: c.url || null, isBot: Boolean(c.isBot), media: hasMedia(c) });
  }
  for (const r of comments.reviews || []) {
    items.push({ key: `review:${r.id}`, kind: 'review', id: r.id, author: r.author || null, url: r.url || null, media: hasMedia(r) });
  }
  for (const f of comments.findings || []) {
    items.push({ key: `finding:${f.id}`, kind: 'finding', id: f.id, path: f.path || null, media: false });
  }
  if (comments.task) items.push({ key: 'task', kind: 'task', id: 'task', media: false });
  return items;
}

const excerpt = (item) => {
  const out = { item: item.key };
  for (const k of ['author', 'url', 'path']) if (item[k]) out[k] = item[k];
  return out;
};

function verify({ comments, result, openThreads = null }) {
  const items = itemsOf(comments);
  const verdicts = Array.isArray(result.verdicts) ? result.verdicts : [];
  const byKey = new Map();
  const duplicate = [];
  for (const v of verdicts) {
    const key = String(v.item || '');
    if (byKey.has(key)) duplicate.push(key);
    byKey.set(key, v);
  }
  const out = {
    ok: true, total: items.length, accounted: 0, fixed: 0, rejected: 0, answered: 0,
    unaccounted: [], noGround: [], inconsistent: [], mediaNotSeen: [], unknownItems: [], stillOpen: [], newSinceRun: [], warnings: [], errors: [],
  };
  if (!Array.isArray(result.verdicts)) out.errors.push('the agent result carries no verdicts[] - nothing can be checked item by item');
  for (const key of duplicate) out.inconsistent.push({ item: key, reason: 'two verdicts for one item' });
  const known = new Set(items.map((i) => i.key));
  for (const key of byKey.keys()) if (!known.has(key)) out.unknownItems.push(key);

  for (const item of items) {
    const v = byKey.get(item.key);
    if (!v) {
      out.unaccounted.push(excerpt(item));
      continue;
    }
    out.accounted += 1;
    const verdict = String(v.verdict || '');
    if (!['fixed', 'rejected', 'answered'].includes(verdict)) {
      out.inconsistent.push({ item: item.key, reason: `verdict ${JSON.stringify(v.verdict)} is none of fixed, rejected, answered` });
      continue;
    }
    out[verdict] += 1;
    if (verdict !== 'fixed' && !String(v.ground || '').trim() && !(verdict === 'answered' && item.isBot)) out.noGround.push(excerpt(item));
    if (item.media && v.sawMedia !== true) out.mediaNotSeen.push(excerpt(item));
  }

  // The ids the orchestrator resolves on GitHub must be exactly the threads verdicted fixed.
  const fixedThreads = items.filter((i) => i.kind === 'thread' && (byKey.get(i.key) || {}).verdict === 'fixed').map((i) => i.id);
  const reported = new Set(result.fixedThreadIds || []);
  for (const id of fixedThreads) if (!reported.has(id) && result.committed !== false) out.inconsistent.push({ item: `thread:${id}`, reason: 'verdicted fixed but missing from fixedThreadIds - it will stay open on GitHub' });
  for (const id of reported) if (!fixedThreads.includes(id)) out.inconsistent.push({ item: `thread:${id}`, reason: 'in fixedThreadIds without a fixed verdict - it would be closed as addressed' });

  if (openThreads) {
    const open = new Map(openThreads.map((t) => [t.id, t]));
    for (const id of fixedThreads) {
      if (open.has(id)) out.stillOpen.push({ item: `thread:${id}`, reason: result.pushed ? 'fixed and pushed, still unresolved on GitHub (resolve-threads unverified or failed)' : 'fixed but not pushed, so not resolved' });
    }
    const given = new Set(items.filter((i) => i.kind === 'thread').map((i) => i.id));
    for (const [id, t] of open) {
      if (!given.has(id)) {
        const first = (t.comments || [])[0] || {};
        out.newSinceRun.push({ item: `thread:${id}`, author: first.author || null, url: first.url || null, path: t.path || null });
      }
    }
  }
  out.ok = out.errors.length === 0 && ['unaccounted', 'noGround', 'inconsistent', 'mediaNotSeen', 'unknownItems', 'stillOpen', 'newSinceRun'].every((k) => out[k].length === 0);
  return out;
}

function main() {
  let out;
  try {
    const args = parseArgs(process.argv.slice(2));
    const comments = JSON.parse(fs.readFileSync(args.comments, 'utf8'));
    const result = JSON.parse(fs.readFileSync(args.result, 'utf8'));
    let openThreads = null;
    const warnings = [];
    if (args.remote === 'yes' && comments.pr && comments.pr.number && !process.env.DOH_FIXPR_REPLAY) {
      const github = require('../../codeReview/scripts/github.cjs');
      const prApi = require('./pr-api.cjs');
      const slug = github.repoSlug(path.resolve(args.project));
      const answer = slug ? prApi.withRetry(() => prApi.reviewThreads(path.resolve(args.project), slug, comments.pr.number)) : { error: 'no github.com remote' };
      if (answer.error) warnings.push(`GitHub was not asked again (${answer.error}); stillOpen and newSinceRun are not checked.`);
      else openThreads = answer.threads.filter((t) => !t.isResolved);
    }
    out = verify({ comments, result, openThreads });
    out.warnings.push(...warnings);
  } catch (err) {
    out = { ok: false, errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = { parseArgs, itemsOf, verify };

if (require.main === module) main();
