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
// Usage:
//   node symbol-uses.cjs --root=<worktree> --names=<a,b,…> [--refs=<rev,rev,…>] [--limit=200]
// Prints one JSON object: { uses: [{ name, ref, path, line, text }], truncated, errors }.
// `ref` is "worktree" for the files as they are now. Locale files other than the base language
// (en.json) are skipped: the translation team owns them (rule i18n#1). A dotted translation key
// is also looked for as its leaf `"key":` inside en.json files.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { root: '', names: [], refs: [], limit: 200 };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'names') args.names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'refs') args.refs = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'limit' && /^\d+$/.test(m[2])) args.limit = Number(m[2]);
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --root, --names, --refs, --limit).`);
  if (!args.root) throw new Error('No worktree given (expected --root=<dir>).');
  if (args.names.length === 0) throw new Error('No names given (expected --names=<a,b>).');
  return args;
}

// A locale file of another language: `de.json`, `pt-BR.json`, `zh_Hans.json` - never `en.json`.
const otherLocale = (file) => {
  const base = path.basename(file).toLowerCase();
  return /^[a-z]{2,3}([-_][a-z0-9]{2,4})?\.json$/.test(base) && !/^en([-_]|\.json)/.test(base);
};

function grep(root, pattern, { ref = null, word = true, pathspec = [] } = {}) {
  const args = ['-C', root, 'grep', '-n', '-I', '--no-color', '-F', ...(word ? ['-w'] : []), '-e', pattern];
  if (ref) args.push(ref);
  else args.push('--untracked');
  if (pathspec.length) args.push('--', ...pathspec);
  const res = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (res.status === 1) return { lines: [], error: null };
  if (res.status !== 0) return { lines: [], error: String(res.stderr || '').trim().split(/\r?\n/)[0] || `git grep exited ${res.status}` };
  return { lines: String(res.stdout).split(/\r?\n/).filter(Boolean), error: null };
}

function parseLine(line, ref) {
  // worktree: path:line:text ; a revision: rev:path:line:text
  const rest = ref ? line.slice(ref.length + 1) : line;
  const m = rest.match(/^(.*?):(\d+):(.*)$/);
  return m ? { path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) } : null;
}

function findUses(options) {
  const root = path.resolve(options.root);
  const result = { uses: [], truncated: false, errors: [] };
  const where = [null, ...(options.refs || [])];
  for (const name of options.names) {
    const searches = [{ pattern: name, word: !/[^\w$]/.test(name) }];
    if (name.includes('.')) searches.push({ pattern: `"${name.split('.').pop()}":`, word: false, pathspec: [':(glob)**/en.json'] });
    for (const ref of where) {
      for (const s of searches) {
        const { lines, error } = grep(root, s.pattern, { ref, word: s.word, pathspec: s.pathspec || [] });
        if (error) result.errors.push(`${ref || 'worktree'}: ${error}`);
        for (const line of lines) {
          const hit = parseLine(line, ref);
          if (!hit || otherLocale(hit.path)) continue;
          if (result.uses.length >= options.limit) { result.truncated = true; return result; }
          result.uses.push({ name, ref: ref || 'worktree', ...hit });
        }
      }
    }
  }
  return result;
}

function main() {
  let result;
  try {
    result = findUses(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { uses: [], truncated: false, errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length && result.uses.length === 0 ? 1 : 0);
}

module.exports = { parseArgs, findUses, otherLocale };

if (require.main === module) main();
