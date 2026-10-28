#!/usr/bin/env node
'use strict';

// A split task's parts are commits on stacked branches (`<branch>-part-<n>`), the last one checked
// out in ROOT. The reviews and validation fix on top of the last part; this folds each fix into the
// part whose lines it touches - an amend of that part's commit, never a commit of its own - so
// every part branch carries its own fixes.
//
//   node split-fixups.cjs --root=<ROOT> --base=<BASE> --branch=<form's branch> --parts=<N> [--stage-all]
//
// `--stage-all`, before a review: HEAD is detached at the commit the parts start from, the index and
// the working tree untouched, so `doh:codeReview staged` sees the whole feature as one staged change.
// One line: `STAGED_ALL <files>`, or `FIXUPS_KEPT <reason>` with nothing moved.
//
// Without it, after a step that fixes: HEAD goes back to `<branch>-part-<N>` (from the detached state
// too), every hunk the index holds over that commit goes to its part and the parts are rebuilt. One
// line, a FIXED IDENTIFIER: `FIXUPS_APPLIED {"<part>":<hunks>,…}`, `NOTHING_STAGED`, or
// `FIXUPS_KEPT <reason>` - HEAD is then on `<branch>-part-<N>` with every fix still staged on it.
//
// Nothing is replayed: part n is rebuilt as its own tree plus every fix owned by parts 1..n, so two
// fixes on adjacent lines of different parts cannot conflict the way a rebase would make them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (root, args, env) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  env: env ? { ...process.env, ...env } : process.env
});
const tryGit = (root, args) => { try { return git(root, args).trim(); } catch (_e) { return null; } };

// Part number → its branch tip, and every commit of a part → that part's number.
function partCommits(root, base, branch, parts) {
  const bySha = new Map();
  const byPart = new Map();
  let prev = null;
  for (let n = 1; n <= parts; n++) {
    const sha = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}-part-${n}^{commit}`]);
    if (!sha) return { missing: n };
    byPart.set(n, sha);
    const from = prev || tryGit(root, ['merge-base', base, sha]);
    if (!from) return { missing: n };
    for (const c of git(root, ['rev-list', `${from}..${sha}`]).split('\n').filter(Boolean)) bySha.set(c, n);
    prev = sha;
  }
  return { bySha, byPart, start: tryGit(root, ['merge-base', base, byPart.get(1)]) };
}

// A zero-context diff, one entry per file: its header lines and its hunks.
function parseDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { header: [line], hunks: [], file: null, added: false };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      cur.hunks.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: [] });
    } else if (cur.hunks.length) {
      if (line !== '') cur.hunks[cur.hunks.length - 1].body.push(line);
    } else {
      cur.header.push(line);
      if (line === '--- /dev/null') cur.added = true;
      const m = /^--- a\/(.*)$/.exec(line);
      if (m) cur.file = m[1];
    }
  }
  return files;
}

// A hunk that rewrites as many lines as it removes is split line by line: adjacent lines can
// belong to different parts, and each goes to its own.
function splitHunks(f) {
  return f.hunks.flatMap(h => {
    const minus = h.body.filter(l => l[0] === '-');
    const plus = h.body.filter(l => l[0] === '+');
    if (h.count < 2 || minus.length !== plus.length || h.body.some(l => l[0] === '\\')) return [h];
    return minus.map((m, i) => ({ start: h.start + i, count: 1, newStart: h.newStart + i, newCount: 1,
      body: [m, plus[i]] }));
  });
}

// The latest part that last wrote lines from..to of `file` in the last part; null when all
// predate the task.
function blameOwner(root, tip, file, from, to, bySha) {
  let owner = null;
  const out = git(root, ['blame', '--porcelain', '-L', `${from},${to}`, tip, '--', file]);
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m && bySha.has(m[1])) owner = Math.max(owner || 0, bySha.get(m[1]));
  }
  return owner;
}

function ownerOf(root, f, h, ctx) {
  if (f.added || !f.file) return ctx.parts;
  let owner = null;
  if (h.count > 0) owner = blameOwner(root, ctx.tip, f.file, h.start, h.start + h.count - 1, ctx.bySha);
  else {
    // A pure insertion after line `start`: it goes with the line above it, else the one below.
    const length = git(root, ['show', `${ctx.tip}:${f.file}`]).split('\n').length - 1;
    if (h.start > 0) owner = blameOwner(root, ctx.tip, f.file, h.start, h.start, ctx.bySha);
    if (owner == null && h.start < length) owner = blameOwner(root, ctx.tip, f.file, h.start + 1, h.start + 1, ctx.bySha);
  }
  if (owner != null) return owner;
  // Lines older than the task: the latest part that touched the file, else the last part.
  const last = git(root, ['log', '-1', '--format=%H', `${ctx.start}..${ctx.tip}`, '--', f.file]).trim();
  return (last && ctx.bySha.get(last)) || ctx.parts;
}

// The last part's line `line` of `file` as a line of `commit`'s copy: past the lines the two differ
// in, the offset of the hunks before it. A line inside a difference has no place there - null.
function mapLine(root, commit, tip, file, line, insertion) {
  const hunks = parseDiff(git(root, ['diff', '-U0', '--no-color', '--no-renames', commit, tip, '--', file]))
    .flatMap(f => f.hunks);
  let offset = 0;
  for (const h of hunks) {
    const end = h.newStart + h.newCount - (h.newCount ? 1 : 0);
    if (h.newCount === 0 ? line <= h.newStart : line < h.newStart) break;
    if (h.newCount && line <= end) {
      // An insertion after a part's last line still lands right after it.
      if (insertion && line === end) return h.start + h.count - (h.count ? 1 : 0);
      return null;
    }
    offset += h.count - h.newCount;
  }
  return line + offset;
}

function commitLike(root, original, tree, parent) {
  const [name, email, date, message] = git(root, ['log', '-1', '--format=%an%x00%ae%x00%ad%x00%B', original]).split('\0');
  return git(root, ['commit-tree', tree, '-p', parent, '-m', message.replace(/\n+$/, '')],
    { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }).trim();
}

function stageAll({ root, base, branch, parts }) {
  const p = partCommits(root, base, branch, parts);
  if (p.missing) return `FIXUPS_KEPT no branch ${branch}-part-${p.missing} on ${base}`;
  const head = tryGit(root, ['symbolic-ref', '-q', 'HEAD']);
  if (head === null && tryGit(root, ['rev-parse', 'HEAD']) === p.start) {
    return `STAGED_ALL ${git(root, ['diff', '--cached', '--name-only', p.start]).split('\n').filter(Boolean).length}`;
  }
  if (head !== `refs/heads/${branch}-part-${parts}`) return `FIXUPS_KEPT HEAD is not ${branch}-part-${parts}`;
  git(root, ['add', '-A']);
  // Detached, so no branch moves: the index and the working tree stay, and now differ from HEAD by
  // the whole feature.
  git(root, ['update-ref', '--no-deref', 'HEAD', p.start]);
  return `STAGED_ALL ${git(root, ['diff', '--cached', '--name-only', 'HEAD']).split('\n').filter(Boolean).length}`;
}

function splitFixups({ root, base, branch, parts }) {
  parts = Number(parts);
  const p = partCommits(root, base, branch, parts);
  if (p.missing) return `FIXUPS_KEPT no branch ${branch}-part-${p.missing} on ${base}`;
  const { bySha, byPart, start } = p;
  const lastRef = `refs/heads/${branch}-part-${parts}`;
  // Back on the last part first, whatever happens next: the index is untouched, so it now holds
  // exactly the fixes over that commit.
  if (tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== lastRef) git(root, ['symbolic-ref', 'HEAD', lastRef]);
  git(root, ['add', '-A']);
  if (!git(root, ['diff', '--cached', '--name-only']).trim()) return 'NOTHING_STAGED';
  const tip = byPart.get(parts);
  const ctx = { parts, bySha, tip, start };
  const target = git(root, ['write-tree']).trim();
  const files = parseDiff(git(root, ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff',
    '--cached', tip]));
  // Each hunk with its owner, decided once against the last part.
  const owned = files.map(f => ({ f, hunks: splitHunks(f).map(h => ({ h, owner: ownerOf(root, f, h, ctx) })),
    // A change without hunks (a mode, a binary) goes whole with the file's latest part.
    whole: f.hunks.length ? null : ownerOf(root, f, { start: 1, count: 0 }, ctx) }));
  const counts = {};
  for (const o of owned) {
    for (const { owner } of o.hunks) counts[owner] = (counts[owner] || 0) + 1;
    if (o.whole != null) counts[o.whole] = (counts[o.whole] || 0) + 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-fixups-'));
  try {
    let parent = start;
    const rebuilt = [];
    for (let n = 1; n <= parts; n++) {
      const commit = byPart.get(n);
      let tree = target;   // the last part is the whole staged tree
      if (n < parts) {
        const patch = [];
        for (const o of owned) {
          const mine = o.hunks.filter(x => x.owner <= n);
          if (o.whole != null && o.whole <= n) throw new Error(`${o.f.file} changes whole, under part ${o.whole}`);
          if (!mine.length) continue;
          patch.push(...o.f.header);
          let shift = 0;
          for (const { h } of mine) {
            const at = mapLine(root, commit, tip, o.f.file, h.start, !h.count);
            if (at == null) throw new Error(`a fix to ${o.f.file}:${h.start} has no place in part ${n}`);
            const plus = h.body.filter(l => l[0] === '+').length;
            const newAt = (h.count ? at : at + 1) + shift - (plus ? 0 : 1);
            patch.push(`@@ -${at},${h.count} +${newAt},${plus} @@`, ...h.body);
            shift += plus - h.count;
          }
        }
        const index = path.join(tmp, `index-${n}`);
        const env = { GIT_INDEX_FILE: index };
        git(root, ['read-tree', commit], env);
        if (patch.length) {
          const file = path.join(tmp, `part-${n}.patch`);
          fs.writeFileSync(file, `${patch.join('\n')}\n`);
          git(root, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', file], env);
        }
        tree = git(root, ['write-tree'], env).trim();
      }
      // The part's own message and author: the fix is amended into it.
      parent = commitLike(root, commit, tree, parent);
      rebuilt.push(parent);
    }
    // Only now is anything moved: up to here a failure leaves every ref and the index untouched.
    git(root, ['reset', '-q', '--soft', rebuilt[parts - 1]]);
    for (let n = 1; n < parts; n++) git(root, ['branch', '-f', `${branch}-part-${n}`, rebuilt[n - 1]]);
    return `FIXUPS_APPLIED ${JSON.stringify(counts)}`;
  } catch (e) {
    return `FIXUPS_KEPT ${String(e.stderr || e.message).trim().split('\n')[0]}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { splitFixups, stageAll };

if (require.main === module) {
  const opts = {};
  let all = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--stage-all') { all = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    if (m[1] === 'root') opts.root = m[2];
    else if (m[1] === 'base') opts.base = m[2];
    else if (m[1] === 'branch') opts.branch = m[2];
    else if (m[1] === 'parts') opts.parts = Number(m[2]);
  }
  console.log(all ? stageAll(opts) : splitFixups(opts));
}
