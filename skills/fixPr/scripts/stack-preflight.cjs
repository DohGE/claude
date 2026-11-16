#!/usr/bin/env node
'use strict';

// Before the fix agents of a stack start: every part that imports a file only a later part adds.
//
// A stack split into parts is meant to compile part by part, and DPXN-12003 did not: part-1..4
// imported a constant, two mocks and a store that only part-5 added (2026-11-16). Every one of the
// four fix agents found its first gate red, worked out why, and copied the missing files on its
// own - and two of them made different choices, which a conflict agent then had to undo at the
// landing. Read from git alone, before any worktree exists, the same answer costs seconds: each
// part's changed source files are read at the part's tip, their relative and tsconfig-alias
// imports resolved, and a target missing from the part's tree but present in a later part's is a
// leak - with the files that file imports in turn, while they are missing too. The fix agent of
// the part then restores them verbatim from that part, so every agent makes the same copy and the
// landing sees an add/add of identical files.
//
// Usage:
//   node stack-preflight.cjs --run=<fixpr-run-*.json> [--write=yes|no]
// Prints one JSON object: { targets: [{ branch, leaks: [{ path, from, importers }], restore:
// [{ path, from }], unresolved }], leakCount, warnings, errors }. `restore` adds the leaks of the
// parts below that the part's tree still lacks. --write=yes (the default) stores `leaks` and
// `restore` of each target in the run file.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { run: '', write: 'yes' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'run') args.run = m[2].trim();
    else if (m[1] === 'write') args.write = m[2].trim();
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --write).`);
  if (!args.run) throw new Error('No run file given (expected --run=<fixpr-run-*.json>).');
  if (!['yes', 'no'].includes(args.write)) throw new Error('--write takes yes or no.');
  return args;
}

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { ok: res.status === 0, out: String(res.stdout || ''), err: String(res.stderr || '').trim() };
}

const codeFile = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// An import naming a file with its own extension; `./x.component` is no such name.
const assetFile = /\.(json|scss|sass|css|less|html|svg|png|jpe?g|gif|webp|txt|md)$/i;
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

// tsconfig.json is JSON with comments and trailing commas.
function looseJson(text) {
  const stripped = String(text)
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (whole, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

function aliasesAt(project, ref) {
  const shown = git(project, ['show', `${ref}:tsconfig.json`]);
  if (!shown.ok) return [];
  try {
    const options = (looseJson(shown.out).compilerOptions) || {};
    const base = path.posix.normalize(options.baseUrl || '.');
    return Object.entries(options.paths || {}).map(([key, targets]) => ({
      prefix: key.replace(/\*$/, ''), wild: key.endsWith('*'),
      targets: (targets || []).map((t) => path.posix.join(base, t)),
    }));
  } catch {
    return [];
  }
}

// The repository paths an import specifier may name, most likely first; [] for a package.
function candidatesOf(importer, specifier, aliases) {
  let bases = [];
  if (specifier.startsWith('.')) bases = [path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))];
  else {
    for (const alias of aliases) {
      if (alias.wild ? specifier.startsWith(alias.prefix) : specifier === alias.prefix) {
        const rest = alias.wild ? specifier.slice(alias.prefix.length) : '';
        bases.push(...alias.targets.map((t) => path.posix.normalize(t.replace(/\*$/, rest))));
      }
    }
  }
  return bases.flatMap((b) => (assetFile.test(b) ? [b] : [b, ...extensions.map((e) => b + e)]));
}

function importsOf(text) {
  return [...String(text).matchAll(importPattern)].map((m) => m[1]);
}

// `stack` bottom-first, `base` the branch the bottom is based on, `above` the open parts above the
// run's top; `refOf(branch)` the ref a branch is read at (origin/<branch> in a run).
function findLeaks(project, { base, stack, above = [], refOf = (b) => `origin/${b}` }) {
  const result = { targets: [], leakCount: 0, warnings: [], errors: [] };
  const all = [...stack, ...above];
  const trees = new Map();
  const treeOf = (branch) => {
    if (!trees.has(branch)) {
      const listed = git(project, ['ls-tree', '-r', '--name-only', refOf(branch)]);
      if (!listed.ok) result.errors.push(`Could not list ${refOf(branch)}: ${listed.err.split(/\r?\n/)[0]}`);
      trees.set(branch, new Set(listed.out.split(/\r?\n/).filter(Boolean)));
    }
    return trees.get(branch);
  };
  const contentAt = (branch, file) => {
    const shown = git(project, ['show', `${refOf(branch)}:${file}`]);
    return shown.ok ? shown.out : '';
  };
  // A part's tree holds the files of the parts below it, so their leaks break its gate as well:
  // `restore` is every leak of the part and of the parts below it that its own tree still lacks.
  let below = [];
  stack.forEach((branch, i) => {
    const parent = i === 0 ? base : stack[i - 1];
    const own = treeOf(branch);
    const aliases = aliasesAt(project, refOf(branch));
    const entry = { branch, leaks: [], restore: [], unresolved: [] };
    const settle = () => {
      const byPath = new Map([...below, ...entry.leaks].filter((l) => !own.has(l.path)).map((l) => [l.path, { path: l.path, from: l.from }]));
      entry.restore = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
      below = entry.restore;
    };
    const fork = git(project, ['merge-base', refOf(parent), refOf(branch)]);
    if (!fork.ok) {
      result.warnings.push(`${branch}: no merge base with ${parent}; its imports were not checked.`);
      settle();
      result.targets.push(entry);
      return;
    }
    const changed = git(project, ['diff', '--name-only', '--diff-filter=AMR', fork.out.trim(), refOf(branch)]).out
      .split(/\r?\n/).filter((f) => codeFile.test(f));
    const leaks = new Map();
    // [importer, the part its text is read at]: the part's own files, then each leaked file.
    const queue = changed.map((file) => [file, branch]);
    while (queue.length > 0) {
      const [importer, at] = queue.shift();
      for (const specifier of importsOf(contentAt(at, importer))) {
        const candidates = candidatesOf(importer, specifier, aliases);
        if (candidates.length === 0 || candidates.some((c) => own.has(c))) continue;
        const later = all.slice(i + 1);
        let found = null;
        for (const other of later) {
          const hit = candidates.find((c) => treeOf(other).has(c));
          if (hit) { found = { path: hit, from: other }; break; }
        }
        if (!found) {
          if (at === branch) entry.unresolved.push({ importer, specifier });
          continue;
        }
        const known = leaks.get(found.path);
        if (known) {
          if (!known.importers.includes(importer)) known.importers.push(importer);
          continue;
        }
        leaks.set(found.path, { path: found.path, from: found.from, importers: [importer] });
        queue.push([found.path, found.from]);
      }
    }
    entry.leaks = [...leaks.values()].map((l) => ({ ...l, importers: l.importers.sort() })).sort((a, b) => (a.path < b.path ? -1 : 1));
    result.leakCount += entry.leaks.length;
    settle();
    result.targets.push(entry);
  });
  return result;
}

// Every stack of a fixPr run (pr-comments.cjs), its targets' leaks written back into the run file.
function preflightRun(runFile, { refOf, write = true } = {}) {
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const project = run.project || path.dirname(runFile);
  const targets = run.targets || [];
  const byBranch = new Map(targets.map((t) => [t.branch, t]));
  const stacks = Array.isArray(run.stacks) && run.stacks.length > 0
    ? run.stacks
    : targets.filter((t) => !(t.stack && t.stack.parent && byBranch.has(t.stack.parent))).map((t) => [t.branch]);
  const out = { targets: [], leakCount: 0, warnings: [], errors: [] };
  for (const stack of stacks) {
    const bottom = byBranch.get(stack[0]);
    const top = byBranch.get(stack[stack.length - 1]);
    const base = bottom && bottom.pr ? bottom.pr.base : null;
    if (!base) {
      out.warnings.push(`${stack[0]}: no base branch in the run file; its stack was not checked.`);
      continue;
    }
    const above = ((top && top.stack && top.stack.allAbove) || []).filter((b) => !stack.includes(b));
    if (!refOf) git(project, ['fetch', '--quiet', 'origin', base, ...stack, ...above]);
    const found = findLeaks(project, { base, stack, above, ...(refOf ? { refOf } : {}) });
    out.targets.push(...found.targets);
    out.leakCount += found.leakCount;
    out.warnings.push(...found.warnings);
    out.errors.push(...found.errors);
  }
  if (write) {
    for (const t of out.targets) {
      const target = byBranch.get(t.branch);
      if (target) Object.assign(target, { leaks: t.leaks, restore: t.restore });
    }
    fs.writeFileSync(runFile, `${JSON.stringify(run, null, 1)}\n`, 'utf8');
  }
  return out;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = preflightRun(args.run, { write: args.write === 'yes' });
  } catch (err) {
    result = { targets: [], leakCount: 0, warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, findLeaks, preflightRun, candidatesOf, importsOf, looseJson };

if (require.main === module) main();
