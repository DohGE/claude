#!/usr/bin/env node
'use strict';

// Where names are still used: in the worktree (leftovers of a rename or a removal) and in other
// revisions - the parts of a stack above this one (`--refs=origin/part-3,…`).
//
// Two jobs, both once done by a model:
// - The rename check after a fix (codeReview rulebook general#14). A verification sub-agent per
//   rename cost a fresh context each time (2026-11-06, part-3); `git grep` answers the same
//   question exactly, and the fixing agent still reads each hit.
// - The blast radius above a stacked part. On 2026-11-06 part-1's fix removed
//   `isLoadingTapeOperation`, which part-2..4 used: three conflict agents and a question to the
//   user followed. A fix that removes or renames something the parts above still use is named
//   before the commit, so the agent can keep it or report it (`stackImpact`).
//
// git is asked once per place and kind of name - the worktree once, every revision together once -
// and each hit is credited to the names its line holds: a dozen names over four parts took a call
// per name and part, 1.3-1.6 min, and printed 35-51 KB the harness saved to a file (2026-11-16).
// The answer keeps the first `--per` uses of each name in each place and every count; `--out`
// writes every use to a file.
//
// Usage:
//   node symbol-uses.cjs --root=<worktree> --names=<a,b,…> [--refs=<rev,rev,…>] [--limit=200] [--per=10] [--out=<file>] [--worktree=yes|no]
// Prints one JSON object: { uses: [{ name, ref, path, line, text }], counts: [{ name, ref, count }],
// truncated, errors }. `ref` is "worktree" for the files as they are now. Locale files other than
// the base language (en.json) are skipped: the translation team owns them (rule i18n#1). A dotted
// translation key is also looked for as its leaf `"key":` inside en.json files.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { root: '', names: [], refs: [], limit: 200, per: 10, out: '', worktree: true };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'names') args.names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'refs') args.refs = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'limit' && /^\d+$/.test(m[2])) args.limit = Number(m[2]);
    else if (m[1] === 'per' && /^\d+$/.test(m[2])) args.per = Number(m[2]);
    else if (m[1] === 'out') args.out = m[2];
    // A codeReview walker asks a later part of a stack, never the checkout it runs in.
    else if (m[1] === 'worktree' && ['yes', 'no'].includes(m[2])) args.worktree = m[2] === 'yes';
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --root, --names, --refs, --limit, --per, --out, --worktree).`);
  if (!args.root) throw new Error('No worktree given (expected --root=<dir>).');
  if (args.names.length === 0) throw new Error('No names given (expected --names=<a,b>).');
  return args;
}

// A locale file of another language: `de.json`, `pt-BR.json`, `zh_Hans.json` - never `en.json`.
const otherLocale = (file) => {
  const base = path.basename(file).toLowerCase();
  return /^[a-z]{2,3}([-_][a-z0-9]{2,4})?\.json$/.test(base) && !/^en([-_]|\.json)/.test(base);
};

// One git grep over the worktree (refs empty) or over every revision in `refs` at once.
function grep(root, patterns, { refs = [], word = true, pathspec = [] } = {}) {
  const args = ['-C', root, 'grep', '-n', '-I', '--no-color', '-F', ...(word ? ['-w'] : []), ...patterns.flatMap((p) => ['-e', p])];
  if (refs.length > 0) args.push(...refs);
  else args.push('--untracked');
  if (pathspec.length) args.push('--', ...pathspec);
  const res = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (res.status === 1) return { lines: [], error: null };
  if (res.status !== 0) return { lines: [], error: String(res.stderr || '').trim().split(/\r?\n/)[0] || `git grep exited ${res.status}` };
  return { lines: String(res.stdout).split(/\r?\n/).filter(Boolean), error: null };
}

// worktree: path:line:text ; a revision: rev:path:line:text
function parseLine(line, refs) {
  const ref = refs.find((r) => line.startsWith(`${r}:`)) || null;
  const rest = ref ? line.slice(ref.length + 1) : line;
  const m = rest.match(/^(.*?):(\d+):(.*)$/);
  return m ? { ref, path: m[1], line: Number(m[2]), full: m[3] } : null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findUses(options, deps = {}) {
  const run = deps.grep || grep;
  const root = path.resolve(options.root);
  const refs = options.refs || [];
  const per = Number.isInteger(options.per) && options.per > 0 ? options.per : 10;
  const limit = Number.isInteger(options.limit) ? options.limit : 200;
  const result = { uses: [], counts: [], truncated: false, errors: [] };
  const wordNames = options.names.filter((n) => !/[^\w$]/.test(n));
  const otherNames = options.names.filter((n) => /[^\w$]/.test(n));
  const leaves = options.names.filter((n) => n.includes('.')).map((n) => ({ name: n, pattern: `"${n.split('.').pop()}":` }));
  const searches = [
    ...(wordNames.length ? [{ patterns: wordNames, word: true, credit: (text) => wordNames.filter((n) => new RegExp(`(^|[^\\w$])${escape(n)}([^\\w$]|$)`).test(text)) }] : []),
    ...(otherNames.length ? [{ patterns: otherNames, word: false, credit: (text) => otherNames.filter((n) => text.includes(n)) }] : []),
    ...(leaves.length ? [{ patterns: leaves.map((l) => l.pattern), word: false, pathspec: [':(glob)**/en.json'], credit: (text) => leaves.filter((l) => text.includes(l.pattern)).map((l) => l.name) }] : []),
  ];
  const all = [];
  const seen = new Set();
  for (const place of [...(options.worktree === false ? [] : [[]]), ...(refs.length ? [refs] : [])]) {
    for (const s of searches) {
      const { lines, error } = run(root, s.patterns, { refs: place, word: s.word, pathspec: s.pathspec || [] });
      if (error) result.errors.push(`${place.length ? place.join(',') : 'worktree'}: ${error}`);
      for (const line of lines) {
        const hit = parseLine(line, place);
        if (!hit || otherLocale(hit.path)) continue;
        for (const name of s.credit(hit.full)) {
          const key = `${name}|${hit.ref || 'worktree'}|${hit.path}|${hit.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({ name, ref: hit.ref || 'worktree', path: hit.path, line: hit.line, text: hit.full.trim().slice(0, 200) });
        }
      }
    }
  }
  const counts = new Map();
  for (const use of all) {
    const key = `${use.name}|${use.ref}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.get(key) > per || result.uses.length >= limit) {
      result.truncated = true;
      continue;
    }
    result.uses.push(use);
  }
  result.counts = [...counts.entries()].map(([key, count]) => {
    const [name, ref] = key.split('|');
    return { name, ref, count };
  });
  if (options.out) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      fs.writeFileSync(options.out, `${JSON.stringify({ uses: all }, null, 1)}\n`, 'utf8');
      result.out = path.resolve(options.out);
    } catch (err) {
      result.errors.push(`Could not write ${options.out}: ${(err && err.message) || err}`);
    }
  }
  return result;
}

function main() {
  let result;
  try {
    result = findUses(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { uses: [], counts: [], truncated: false, errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length && result.uses.length === 0 ? 1 : 0);
}

module.exports = { parseArgs, findUses, otherLocale };

if (require.main === module) main();
