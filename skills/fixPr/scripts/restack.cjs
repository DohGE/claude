#!/usr/bin/env node
'use strict';

// Lands a part of a stack - a pull request whose base is another branch of the same run - once
// its parent has landed: moves its held commit onto where the parent stands now, runs the gate
// when the move brought new code under it, and pushes with a lease pinned to where the branch
// stood when the run began.
//
// Why a script and not each fixing agent's own rebase: on 2026-11-03 five parts of one stack
// were fixed side by side and each rebased at its own finish. part-1 rebased onto master
// rewrote the commits part-2 sat on, and part-2's plain `git rebase origin/part-1` then replayed
// the old part-1 commits against the new ones and conflicted; part-4 finished before part-3
// pushed, rebased onto nothing and stayed on the old part-3. `--onto <parent now> <parent at
// start>` moves only the part's own commits, and landing bottom-up is what makes "the parent
// now" final. The parts were moved this way by hand afterwards, without a conflict past part-2.
//
// Usage:
//   node restack.cjs --action=land --worktree=<dir> --branch=<part> --parent=<branch>
//        [--parent-tip-at-start=<sha>] [--remote-tip-at-start=<sha>] [--checks-dir=<dir>]
//        [--push=yes|no] [--gate=yes|no] [--auto-resolve=yes|no]
//   node restack.cjs --action=verify --project=<dir> --pairs="<parent>><child>[@<old tip>],..."
//   node restack.cjs --action=push --worktree=<dir> --branch=<branch> [--lease=<sha>]
//   node restack.cjs --action=cascade --project=<dir> --stack="<bottom>;<part>;..." --from=<part>
//        [--from-old-tip=<sha>] [--checks-dir=<dir>] [--push=yes|no] [--gate=yes|no]
//   node restack.cjs --action=plan --project=<dir> --stack="<part>"|"<bottom>;…" [--base=<branch>]
//   node restack.cjs --action=stack --project=<dir> --stack="<bottom>;<part>;..."|"<any part>"
//        [--base=<branch>] [--start=<part>] [--parent-old-tip=<sha>] [--onto-base=yes|no]
//        [--checks-dir=<dir>] [--push=yes|no] [--gate=yes|no] [--language=<name>] [--resume=yes|no]
// land and verify also take --run=<fixpr-run-*.json> (pr-comments.cjs): a part's worktree,
// parent, tips and checks folder come from there. --summary=yes prints the compact form.
// --pending-steps=build: gate steps the fixing agent left to the landing (a held part's build).
// Prints one JSON object. land: `status` is landed | noop | conflict | gate-red | push-rejected |
// error. `noop`: nothing moved - the part already sat on its parent and origin already had it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checksScript = path.join(__dirname, 'checks.cjs');

function parseArgs(argv) {
  const args = {
    action: 'land', push: 'yes', gate: 'yes', autoResolve: 'yes', parentTipAtStart: '', remoteTipAtStart: '', checksDir: '', pairs: [],
    lease: '', stack: [], from: '', fromOldTip: '', run: '', summary: 'no', pendingSteps: [], start: '', parentOldTip: '', base: '', ontoBase: 'yes',
    resume: 'no', language: 'English', preflight: '',
  };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    const value = m[2].trim();
    if (m[1] === 'action') args.action = value;
    else if (m[1] === 'worktree') args.worktree = value;
    else if (m[1] === 'branch') args.branch = value;
    else if (m[1] === 'parent') args.parent = value;
    else if (m[1] === 'parent-tip-at-start') args.parentTipAtStart = value;
    else if (m[1] === 'remote-tip-at-start') args.remoteTipAtStart = value;
    else if (m[1] === 'checks-dir') args.checksDir = value;
    else if (m[1] === 'push') args.push = value;
    else if (m[1] === 'gate') args.gate = value;
    else if (m[1] === 'auto-resolve') args.autoResolve = value;
    else if (m[1] === 'project') args.project = value;
    else if (m[1] === 'pairs') args.pairs = parsePairs(value);
    else if (m[1] === 'lease') args.lease = value;
    else if (m[1] === 'stack') args.stack = value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'from') args.from = value;
    else if (m[1] === 'from-old-tip') args.fromOldTip = value;
    else if (m[1] === 'run') args.run = value;
    else if (m[1] === 'summary') args.summary = value;
    else if (m[1] === 'pending-steps') args.pendingSteps = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'start') args.start = value;
    else if (m[1] === 'parent-old-tip') args.parentOldTip = value;
    else if (m[1] === 'base') args.base = value;
    else if (m[1] === 'onto-base') args.ontoBase = value;
    else if (m[1] === 'resume') args.resume = value;
    else if (m[1] === 'language') args.language = value;
    else if (m[1] === 'preflight') args.preflight = value;
    else unknown.push(arg);
  }
  // The environment check runs by default where a climb starts (plan, stack); a land or a cascade
  // runs inside a run that already passed it.
  if (!args.preflight) args.preflight = ['plan', 'stack'].includes(args.action) ? 'yes' : 'no';
  // This script rewrites and pushes a branch: a mistyped flag stops it.
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --worktree, --branch, --parent, --parent-tip-at-start, --remote-tip-at-start, --checks-dir, --push, --gate, --auto-resolve, --project, --pairs, --lease, --stack, --from, --from-old-tip, --run, --summary, --pending-steps, --start, --parent-old-tip, --base, --onto-base, --resume, --language, --preflight).`);
  if (!['land', 'verify', 'push', 'cascade', 'stack', 'plan'].includes(args.action)) throw new Error(`Unknown --action=${args.action} (expected land|verify|push|cascade|stack|plan).`);
  if (![args.push, args.gate, args.autoResolve, args.summary, args.ontoBase, args.resume, args.preflight].every((v) => ['yes', 'no'].includes(v))) throw new Error('--push, --gate, --auto-resolve, --summary, --onto-base, --resume and --preflight take yes or no.');
  if (args.resume === 'yes' && (args.start || args.parentOldTip)) throw new Error('--resume=yes reads where the climb stopped from its state file: give it without --start and --parent-old-tip.');
  if (args.run) fillFromRun(args);
  if (args.action === 'land' && (!args.worktree || !args.branch || !args.parent)) throw new Error('land needs --worktree, --branch and --parent (or --run and --branch).');
  if (args.action === 'verify' && (!args.project || args.pairs.length === 0)) throw new Error('verify needs --project and --pairs (or --run).');
  if (['stack', 'plan'].includes(args.action) && (!args.project || args.stack.length === 0)) throw new Error(`${args.action} needs --project and --stack.`);
  if (args.action === 'stack' && args.start && args.stack.length > 1 && !args.stack.includes(args.start)) throw new Error('--start names a part of --stack.');
  if (args.action === 'push' && (!args.worktree || !args.branch)) throw new Error('push needs --worktree and --branch.');
  if (args.action === 'cascade' && (!args.project || args.stack.length < 2 || !args.stack.includes(args.from))) throw new Error('cascade needs --project, --stack with two parts or more, and --from naming one of them.');
  return args;
}

// --run=<fixpr-run-*.json>: what pr-comments.cjs collected. land takes the named part's worktree,
// parent and tips from it (a flag given explicitly wins); verify takes every parent>child pair.
function readRun(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!run || !Array.isArray(run.targets)) throw new Error(`${file} is no fixPr run file (no targets).`);
  return run;
}

function landOptionsFromRun(run, branch) {
  const t = run.targets.find((x) => x.branch === branch);
  if (!t) throw new Error(`${branch} is not a target of the run file.`);
  const stack = t.stack || {};
  return {
    worktree: t.worktree, branch, parent: stack.parent || (t.pr && t.pr.base) || '',
    parentTipAtStart: stack.parentTipAtStart || '', remoteTipAtStart: t.remoteTipAtStart || '',
    checksDir: t.checksDir ? path.join(t.checksDir, 'restack') : '',
    parentImpact: parentImpactOf(run, branch),
  };
}

// What the fix agents of the parts below a part removed, renamed or re-signed that this part still
// uses: each agent's `stackImpact` (<reportPath>.result.json), the uses of this branch only,
// bottom-first - [{ symbol, change, uses: ['path:line', …] }]. On 2026-11-16 the orchestrator
// gathered these by hand for every conflict agent, and part-5 needed part-1's and part-3's too.
function parentImpactOf(run, branch) {
  const byBranch = new Map((run.targets || []).map((t) => [t.branch, t]));
  const below = [];
  for (let at = byBranch.get(branch), guard = 0; at && at.stack && at.stack.parent && guard < 50; guard += 1) {
    const parent = byBranch.get(at.stack.parent);
    if (!parent) break;
    below.unshift(parent);
    at = parent;
  }
  const items = [];
  const seen = new Set();
  for (const part of below) {
    let impact = [];
    try {
      impact = JSON.parse(fs.readFileSync(`${part.reportPath}.result.json`, 'utf8')).stackImpact || [];
    } catch {
      impact = [];
    }
    for (const item of Array.isArray(impact) ? impact : []) {
      // symbol-uses.cjs names a revision `origin/<branch>`; an agent may copy that into usedIn.
      const uses = (item.usedIn || []).map(String).map((u) => u.replace(/^origin\//, '')).filter((u) => u.startsWith(`${branch}:`)).map((u) => u.slice(branch.length + 1));
      const key = `${item.symbol}|${item.change}`;
      if (uses.length === 0 || seen.has(key)) continue;
      seen.add(key);
      items.push({ symbol: String(item.symbol), change: String(item.change), uses });
    }
  }
  return items;
}

// "symbol: change (path:line, line; path:line); …", or `none`: a path is written once however many
// lines of it use the name (2026-11-18: the same file:line pairs, repeated with full paths, made
// most of a 9 KB section).
function formatImpact(items) {
  const text = (items || []).map((item) => {
    const byPath = new Map();
    for (const use of item.uses || []) {
      const m = String(use).match(/^(.*?):(\d+)$/);
      const [file, line] = m ? [m[1], m[2]] : [String(use), ''];
      if (!byPath.has(file)) byPath.set(file, []);
      if (line) byPath.get(file).push(line);
    }
    const where = [...byPath].map(([file, lines]) => (lines.length ? `${file}:${lines.join(', ')}` : file)).join('; ');
    return `${item.symbol}: ${item.change}${where ? ` (${where})` : ''}`;
  });
  return text.length > 0 ? text.join('; ') : 'none';
}

function parentChangesOf(run, branch) {
  return formatImpact(parentImpactOf(run, branch));
}

function pairsFromRun(run) {
  const pairs = [];
  for (const t of run.targets) {
    const stack = t.stack || {};
    if (stack.parent) pairs.push({ parent: stack.parent, child: t.branch, oldTip: stack.parentTipAtStart || null });
    let below = t.branch;
    for (const above of stack.above || []) {
      pairs.push({ parent: below, child: above, oldTip: below === t.branch ? t.remoteTipAtStart || null : null });
      below = above;
    }
  }
  return pairs;
}

function fillFromRun(args) {
  const run = readRun(args.run);
  if (!args.project && run.project) args.project = run.project;
  if (args.action === 'land' && args.branch) {
    const from = landOptionsFromRun(run, args.branch);
    for (const key of ['worktree', 'parent', 'parentTipAtStart', 'remoteTipAtStart', 'checksDir', 'parentImpact']) if (!args[key]) args[key] = from[key];
  }
  if (args.action === 'verify' && args.pairs.length === 0) args.pairs = pairsFromRun(run);
}

function parsePairs(text) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const m = pair.match(/^([^>@\s]+)>([^>@\s]+)(?:@([0-9a-fA-F]{4,40}))?$/);
    if (!m) throw new Error(`Not a pair: ${pair} (expected <parent>><child>[@<old tip>]).`);
    return { parent: m[1], child: m[2], oldTip: m[3] || null };
  });
}

function git(dir, args, env) {
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || res.error || '').trim() };
}

const firstLine = (text) => String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';

// The gate after a move, the fixing agent's own: checks.cjs on what the pull request changes.
function defaultGate({ worktree, checksDir, parent, only = [] }) {
  const res = spawnSync(process.execPath, [checksScript, `--root=${worktree}`, `--out-dir=${checksDir}`, `--changed-since=origin/${parent}`, ...(only.length ? [`--only=${only.join(',')}`] : [])], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(String(res.stdout || '').trim().split(/\r?\n/).pop());
  } catch {
    return { gate: 'error', steps: [], errors: [firstLine(res.stderr) || 'checks.cjs printed no result'] };
  }
}

// --- Conflicts where two parts only appended -------------------------------------------------
//
// On 2026-11-05 part-1 of DPXN-11967 added `loadInto` to `en.json` and `ButtonTooltip`, and
// part-2..4 each added their own key next to it: every restack stopped on a conflict that was
// "keep both", and a conflict agent (or the user) was spent on each. Those are merged here: a
// JSON file key by key (both sides' additions kept, a key both changed differently refused),
// any other file only where every conflicting hunk is two insertions at one spot. Anything else
// stays a conflict. The gate after the move is what proves the merge, so this runs only with it.

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = Symbol('absent');

// Three-way merge of parsed JSON; `absent` marks a missing key. Throws on a real conflict.
function mergeJson3(base, ours, theirs, at = '') {
  if (sameJson(ours, theirs)) return ours;
  // A key only one side added.
  if (base === absent && theirs === absent) return ours;
  if (base === absent && ours === absent) return theirs;
  if (base !== absent && sameJson(base, ours)) return theirs;
  if (base !== absent && sameJson(base, theirs)) return ours;
  if (isPlainObject(ours) && isPlainObject(theirs) && (base === absent || isPlainObject(base))) {
    const b = base === absent ? {} : base;
    const keys = Object.keys(ours);
    const theirKeys = Object.keys(theirs);
    theirKeys.forEach((key, i) => {
      if (keys.includes(key)) return;
      // A key only `theirs` has goes right after the key it follows there.
      let prev = -1;
      for (let j = i - 1; j >= 0; j -= 1) {
        prev = keys.indexOf(theirKeys[j]);
        if (prev !== -1) break;
      }
      keys.splice(prev + 1, 0, key);
    });
    const out = {};
    for (const key of keys) {
      const value = mergeJson3(key in b ? b[key] : absent, key in ours ? ours[key] : absent, key in theirs ? theirs[key] : absent, `${at}.${key}`);
      if (value !== absent) out[key] = value;
    }
    return out;
  }
  throw new Error(`both sides changed ${at || 'the document'}`);
}

// git() trims; a merge needs the bytes as they are.
function stageRaw(tree, stage, file) {
  const res = spawnSync('git', ['-C', tree, 'show', `:${stage}:${file}`], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? String(res.stdout) : null;
}

function resolveJson(tree, file) {
  const ours = stageRaw(tree, 2, file);
  const theirs = stageRaw(tree, 3, file);
  const base = stageRaw(tree, 1, file);
  if (ours === null || theirs === null) return null;
  let parsed;
  try {
    parsed = [base === null ? absent : JSON.parse(base), JSON.parse(ours), JSON.parse(theirs)];
  } catch {
    return null;
  }
  const eol = ours.includes('\r\n') ? '\r\n' : '\n';
  const indent = (ours.match(/\n([ \t]+)"/) || [null, '  '])[1];
  const render = (value) => `${JSON.stringify(value, null, indent).replace(/\n/g, eol)}${/\r?\n$/.test(ours) ? eol : ''}`;
  // Only a file this serialisation reproduces byte for byte: anything else would come back
  // reformatted, a diff nobody asked for.
  if (render(parsed[1]) !== ours) return null;
  try {
    return render(mergeJson3(...parsed));
  } catch {
    return null;
  }
}

// `git merge-file -p --diff3` of three texts: the merged lines, each conflict as a block
// { ours, base, theirs } in place. null when git could not merge at all.
function diff3(ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restack-merge-'));
  try {
    const names = ['ours', 'base', 'theirs'].map((n, i) => {
      const p = path.join(dir, n);
      fs.writeFileSync(p, [ours, base, theirs][i] || '');
      return p;
    });
    const res = spawnSync('git', ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...names], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (res.status === null || res.status < 0) return null;
    const lines = String(res.stdout).split(/(?<=\n)/).filter((l) => l !== '');
    const items = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('<<<<<<< ')) { items.push(lines[i]); continue; }
      const block = { ours: [], base: [], theirs: [] };
      let part = 'ours';
      for (i += 1; i < lines.length && !lines[i].startsWith('>>>>>>> '); i += 1) {
        if (lines[i].startsWith('||||||| ')) part = 'base';
        else if (lines[i].startsWith('=======')) part = 'theirs';
        else block[part].push(lines[i]);
      }
      items.push(block);
    }
    return items;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every conflict is two insertions at one spot (an empty base): keep ours, then the lines of
// theirs ours does not already hold. null when a conflict changed a line of the base.
function mergeInsertions(ours, base, theirs) {
  const items = diff3(ours, base, theirs);
  if (items === null) return null;
  const out = [];
  for (const item of items) {
    if (typeof item === 'string') { out.push(item); continue; }
    if (item.base.length > 0) return null;
    const held = new Set(item.ours.map((l) => l.replace(/\r?\n$/, '')));
    out.push(...item.ours, ...item.theirs.filter((l) => !held.has(l.replace(/\r?\n$/, ''))));
  }
  return out.join('');
}

function resolveInsertions(tree, file) {
  const [ours, base, theirs] = [2, 1, 3].map((s) => stageRaw(tree, s, file));
  if (ours === null || theirs === null) return null;
  return mergeInsertions(ours, base || '', theirs);
}

// --- Conflicts in an import block --------------------------------------------------------------
//
// On 2026-11-18 five parts of one stack each stopped on the import block of the same store file:
// the parent had dropped some names from `import { … } from '…'`, the child had added
// others. Five landing agents (55-75k tokens and 4-7 minutes each) all resolved it the same way.
// That way is merged here, per module specifier: the base's names, minus the ones a side removed,
// plus the ones a side added - `type` modifiers and aliases kept, an import left with no name
// dropped, the order of the parent (ours, in a rebase) kept and the child's additions placed after
// the name or statement they follow there. Only where every conflicting hunk holds import lines
// alone (or is an insertion with an empty base, as above); a name both sides changed differently,
// a comment one side changed, a statement this cannot read - anything else stays a conflict. The
// gate after the move proves the merge, as for the merges above.

const codeFile = /\.(?:[cm]?[jt]sx?)$/i;
// `import` opening a statement - never `import(` or `import.meta`.
const importStart = /^\s*import(?=[\s{*'"])/;
const blankOrComment = /^\s*(?:\/\/.*|\/\*.*\*\/\s*)?\r?\n?$/;
const statementEnd = /(?:\bfrom\s*(['"])[^'"\n]+\1|^\s*import\s*(['"])[^'"\n]+\2)\s*;?\s*$/;
const placeholderLine = '/* doh-restack: the merged import block */\n';

// One import statement: `key` names it (its module, and `type ` for `import type`), `entries` maps
// each binding to its text (the default import under '\0default'). A namespace or side-effect import
// is `atomic`: kept or dropped whole.
function parseImport(lines) {
  const raw = lines.join('');
  const text = raw.replace(/\s+/g, ' ').trim();
  const side = text.match(/^import\s*(['"])([^'"]+)\1\s*;?$/);
  if (side) return { key: `side ${side[2]}`, atomic: true, lines };
  const m = text.match(/^import\s+(type\s+)?(.+?)\s*from\s*(['"])([^'"]+)\3\s*;?$/);
  if (!m) return null;
  const [, typeWord, clause, quote, spec] = m;
  if (/^(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+$/.test(clause)) return { key: `atomic ${text}`, atomic: true, lines };
  const parts = clause.match(/^(?:([\w$]+)\s*(?:,\s*)?)?(?:\{(.*)\})?$/);
  if (!parts || (!parts[1] && parts[2] === undefined)) return null;
  const entries = new Map();
  if (parts[1]) entries.set('\0default', parts[1]);
  for (const piece of (parts[2] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const n = piece.match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (!n) return null;
    entries.set(n[3] || n[2], `${n[1] ? 'type ' : ''}${n[2]}${n[3] ? ` as ${n[3]}` : ''}`);
  }
  const multiLine = lines.length > 1;
  const inner = multiLine ? lines.slice(1, -1).filter((l) => l.trim()) : [];
  return {
    key: `${typeWord ? 'type ' : ''}${spec}`, atomic: false, lines, entries, typeOnly: Boolean(typeWord), spec, quote,
    semicolon: /;\s*$/.test(raw), eol: /\r\n$/.test(raw) ? '\r\n' : '\n', multiLine,
    indent: multiLine ? ((inner[0] || '').match(/^\s*/)[0] || '  ') : '',
    trailingComma: multiLine ? /,\s*$/.test(inner[inner.length - 1] || '') : /,\s*\}/.test(text),
    spaced: !/\{\S/.test(text),
  };
}

// A file's import block: from its first import statement to its last one, with only blank lines
// and comments between them; `prefix` before it, `suffix` after. A file without an import gets an
// empty block where its code starts. null when a statement in the block cannot be read.
function importBlock(text) {
  const lines = String(text || '').split(/(?<=\n)/).filter((l) => l !== '');
  let first = lines.findIndex((l) => importStart.test(l));
  if (first === -1) {
    first = lines.findIndex((l) => !blankOrComment.test(l));
    if (first === -1) first = lines.length;
    return { prefix: lines.slice(0, first), tokens: [], suffix: lines.slice(first) };
  }
  const tokens = [];
  let j = first;
  let kept = 0;
  while (j < lines.length) {
    if (importStart.test(lines[j])) {
      let k = j;
      let joined = lines[j];
      while (!statementEnd.test(joined) && k + 1 < lines.length && k - j < 200) joined += lines[++k];
      if (!statementEnd.test(joined)) return null;
      const statement = parseImport(lines.slice(j, k + 1));
      if (!statement) return null;
      tokens.push(statement);
      kept = tokens.length;
      j = k + 1;
    } else if (blankOrComment.test(lines[j])) {
      tokens.push({ other: lines[j] });
      j += 1;
    } else break;
  }
  // Blank lines and comments after the last statement belong to the code below it.
  const tail = tokens.splice(kept).map((t) => t.other);
  return { prefix: lines.slice(0, first), tokens, suffix: [...tail, ...lines.slice(j)] };
}

// Three-way merge of ordered maps: a key one side added or changed wins, one side's removal
// holds. Throws when both sides changed one key differently. Order: ours, with theirs' new keys
// placed after the key they follow in theirs.
function orderKeys(base, ours, theirs) {
  const baseKeys = [...base];
  const keys = [...ours];
  const theirKeys = [...theirs];
  // Ours' own additions at that spot come first: both sides' new names read in the order they landed.
  const oursOnly = (key) => !theirKeys.includes(key) && !baseKeys.includes(key);
  theirKeys.forEach((key, i) => {
    if (keys.includes(key)) return;
    let prev = -1;
    for (let j = i - 1; j >= 0 && prev === -1; j -= 1) prev = keys.indexOf(theirKeys[j]);
    while (prev + 1 < keys.length && oursOnly(keys[prev + 1])) prev += 1;
    keys.splice(prev + 1, 0, key);
  });
  for (const key of baseKeys) if (!keys.includes(key)) keys.push(key);
  return keys;
}

function merge3Map(base, ours, theirs) {
  const out = new Map();
  for (const key of orderKeys(base.keys(), ours.keys(), theirs.keys())) {
    const [b, o, t] = [base.get(key), ours.get(key), theirs.get(key)];
    const value = o === t ? o : b === o ? t : b === t ? o : (() => { throw new Error(`both sides changed ${key}`); })();
    if (value !== undefined) out.set(key, value);
  }
  return out;
}

function renderImport(template, entries) {
  const named = [...entries].filter(([k]) => k !== '\0default').map(([, v]) => v);
  const head = `import ${template.typeOnly ? 'type ' : ''}`;
  const tail = `from ${template.quote}${template.spec}${template.quote}${template.semicolon ? ';' : ''}${template.eol}`;
  const def = entries.get('\0default');
  if (named.length === 0) return [`${head}${def} ${tail}`];
  const lead = def ? `${def}, ` : '';
  if (template.multiLine) {
    const body = named.map((n, i) => `${template.indent}${n}${i < named.length - 1 || template.trailingComma ? ',' : ''}${template.eol}`);
    return [`${head}${lead}{${template.eol}`, ...body, `} ${tail}`];
  }
  const s = template.spaced ? ' ' : '';
  return [`${head}${lead}{${s}${named.join(', ')}${template.trailingComma ? ',' : ''}${s}} ${tail}`];
}

const sameEntries = (a, b) => Boolean(b) && !b.atomic && a.size === b.entries.size && [...a].every(([k, v], i) => [...b.entries][i][0] === k && [...b.entries][i][1] === v);
const commentsOf = (block) => block.tokens.filter((t) => t.other !== undefined && t.other.trim()).map((t) => t.other.trim()).join('\n');

// The merged text of a code file whose conflicts sit in its import block, or null.
function mergeImports(ours, base, theirs) {
  const blocks = [ours, base || '', theirs].map(importBlock);
  if (blocks.some((b) => b === null)) return null;
  const [bo, bb, bt] = blocks;
  if (bo.tokens.length + bt.tokens.length === 0) return null;
  // Every conflict of the plain merge is import lines alone, or an insertion with an empty base.
  const inBlock = blocks.map((b) => new Set(b.tokens.flatMap((t) => (t.lines || [t.other]).map((l) => l.trim())).filter(Boolean)));
  const conflicts = (diff3(ours, base || '', theirs) || []).filter((item) => typeof item !== 'string');
  const importOnly = (side, i) => side.every((l) => !l.trim() || inBlock[i].has(l.trim()));
  if (!conflicts.every((c) => c.base.length === 0 || (importOnly(c.ours, 0) && importOnly(c.base, 1) && importOnly(c.theirs, 2)))) return null;
  if (commentsOf(bt) !== commentsOf(bb) && commentsOf(bt) !== commentsOf(bo)) return null;
  const index = (block) => {
    const map = new Map();
    for (const t of block.tokens.filter((x) => x.key)) {
      if (map.has(t.key)) return null;
      map.set(t.key, t);
    }
    return map;
  };
  const [so, sb, st] = [bo, bb, bt].map(index);
  if (!so || !sb || !st) return null;
  const asEntries = (s) => (s ? (s.atomic ? new Map([['\0whole', 'present']]) : s.entries) : new Map());
  // A statement one side dropped is still merged name by name: the other side may have added one.
  const order = orderKeys(sb.keys(), so.keys(), st.keys());
  const merged = new Map();
  try {
    for (const key of order) {
      const [o, b, t] = [so.get(key), sb.get(key), st.get(key)];
      const entries = merge3Map(asEntries(b), asEntries(o), asEntries(t));
      if (entries.size === 0) continue;
      const template = o || t;
      merged.set(key, template.atomic ? template.lines
        : sameEntries(entries, o) ? o.lines : sameEntries(entries, t) ? t.lines : renderImport(template, entries));
    }
  } catch {
    return null;
  }
  // Ours is the template: its blank lines and comments stay where they are, each statement is
  // replaced by its merge, and a statement only theirs has comes after the one it follows there.
  const out = [];
  let at = 0;
  let blank = bo.prefix.length === 0 || !bo.prefix[bo.prefix.length - 1].trim();
  const emit = (lines) => {
    for (const l of lines) {
      const isBlank = !l.trim();
      if (isBlank && blank) continue;
      out.push(l);
      blank = isBlank;
    }
  };
  const emitUpTo = (key) => {
    const end = key === null ? order.length - 1 : order.indexOf(key);
    for (; at <= end; at += 1) emit(merged.get(order[at]) || []);
  };
  for (const token of bo.tokens) {
    if (token.key) emitUpTo(token.key);
    else emit([token.other]);
  }
  emitUpTo(null);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Everything around the block merges as git merges it (insertions with an empty base as above),
  // with the block held out of it by one line all three versions share.
  const rest = mergeInsertions(...[bo, bb, bt].map((b) => [...b.prefix, placeholderLine, ...b.suffix].join('')));
  if (rest === null || rest.split(placeholderLine).length !== 2) return null;
  return rest.replace(placeholderLine, out.join(''));
}

function resolveImports(tree, file) {
  const [ours, base, theirs] = [2, 1, 3].map((s) => stageRaw(tree, s, file));
  if (ours === null || theirs === null) return null;
  return mergeImports(ours, base, theirs);
}

// Resolves `file` in the rebase in progress when it is one of the shapes above; answers how.
function autoResolve(tree, file) {
  const lower = file.toLowerCase();
  let how = null;
  let text = null;
  if (lower.endsWith('.json')) [how, text] = ['json-keys', resolveJson(tree, file)];
  if (text === null && codeFile.test(lower)) [how, text] = ['imports', resolveImports(tree, file)];
  if (text === null && !lower.endsWith('.json')) [how, text] = ['both-insertions', resolveInsertions(tree, file)];
  if (text === null) return null;
  fs.writeFileSync(path.join(tree, file), text);
  if (!git(tree, ['add', '--', file]).ok) return null;
  return how;
}

// --- Pushes that fail for a moment -----------------------------------------------------------
//
// part-5's push of 2026-11-05 died with "fatal error in commit_refs_rules" and went through on
// the next try. A rejection (stale lease, non-fast-forward) is an answer and is never retried.
const transientPush = /commit_refs_rules|fatal error in|RPC failed|HTTP 5\d\d|\b50[234]\b|early EOF|unexpected disconnect|remote end hung up|Connection (?:reset|timed out|refused)|Could not resolve host|Operation timed out|timed out|TLS|SSL_ERROR|internal server error/i;
const rejectedPush = /\[rejected\]|stale info|non-fast-forward|\(fetch first\)|protected branch|permission|denied|403/i;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pushWithRetry(tree, args, { delays = [3000, 8000], wait = sleepMs, run = git } = {}) {
  let attempts = 0;
  let last = null;
  for (const delay of [0, ...delays]) {
    if (delay) wait(delay);
    attempts += 1;
    last = run(tree, args);
    if (last.ok) return { ...last, attempts };
    const text = `${last.err}\n${last.out}`;
    if (rejectedPush.test(text) || !transientPush.test(text)) break;
  }
  return { ...last, attempts };
}

const gateSummary = (gate) => ({
  gate: gate.gate,
  steps: (gate.steps || []).map((s) => ({ label: s.label, status: s.status, reason: s.reason || '', errorsPath: s.errorsPath || null, logPath: s.logPath || null })),
  errors: gate.errors || [],
});

// The bottom of a stack whose parent pull request was squash-merged into the base still carries
// that parent's commits, and nothing in the base's history names them: the merge-base is the base
// as it stood before. `rebase --onto <base> <merge-base>` then replays the parent's commits on top
// of their own squash, and every file both touched conflicts - on 2026-11-10 DPXN-11967-part-2
// stopped at 29 conflicting files, and a conflict agent spent 5 minutes finding that the squash of
// part-1 held exactly part-1's last commit. Where the part's own commits begin, newest match wins:
//   merged-pr - the head of a pull request merged into the base (GitHub), when it is on the part;
//   patch-id  - a commit whose whole change since the fork point is one first-parent commit of the
//               base since then (`git patch-id --stable`: line numbers do not count, so another
//               pull request landed before the squash does not hide it).
const squashScanLimit = 300;

function patchIdOf(dir, diffArgs) {
  const diff = spawnSync('git', ['-C', dir, ...diffArgs], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (diff.status !== 0 || !diff.stdout) return new Map();
  const ids = spawnSync('git', ['-C', dir, 'patch-id', '--stable'], { input: diff.stdout, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const out = new Map();
  for (const line of String(ids.stdout || '').split(/\r?\n/)) {
    const [id, sha] = line.trim().split(/\s+/);
    if (id && sha && !out.has(id)) out.set(id, sha);
  }
  return out;
}

const diffFlags = ['--no-color', '--no-ext-diff', '--no-renames', '--full-index'];

function squashedBoundary(dir, upstream, head, forkPoint, mergedHeads = []) {
  const own = git(dir, ['rev-list', '--first-parent', `--max-count=${squashScanLimit}`, `${forkPoint}..${head}`]).out.split(/\r?\n/).filter(Boolean);
  if (own.length === 0) return null;
  const at = (i, via, into = null) => ({ boundary: own[i], commits: own.length - i, via, into });
  const heads = new Set((mergedHeads || []).map((s) => String(s).toLowerCase()));
  const byHead = own.findIndex((sha) => heads.has(sha.toLowerCase()));
  if (byHead !== -1) return at(byHead, 'merged-pr');
  const landed = patchIdOf(dir, ['log', '-p', '--first-parent', '--diff-merges=first-parent', `--max-count=${squashScanLimit}`, ...diffFlags, `${forkPoint}..${upstream}`]);
  if (landed.size === 0) return null;
  for (let i = 0; i < own.length; i += 1) {
    const [id] = [...patchIdOf(dir, ['diff', ...diffFlags, forkPoint, own[i]]).keys()];
    if (id && landed.has(id)) return at(i, 'patch-id', landed.get(id));
  }
  return null;
}

// The values of restack-agent.md a landing knows (`briefVars`, for render-agent-prompt.cjs --vars).
// render-agent-prompt.test.cjs reads these names as part of fixPr's documented contract.
// MODE: `conflict` (the move stopped at a conflict) or `adapt` (the move went through and the gate
// is red: this part's code has to follow what the parts below it changed).
function briefVarsOf({ tree = '', branch = '', parent = '', oldTip = '', lease = '', files = [], checksDir = '', push = 'yes', mode = 'conflict', parentChanges = 'none', parentDiff = 'none', parentDiffFull = 'none' } = {}) {
  return {
    ROOT: tree, BRANCH: branch, PARENT: parent, OLD_TIP: oldTip, LEASE: lease || '', FILES: files.length > 0 ? files.join(', ') : 'none',
    CHECKS_DIR: checksDir ? path.resolve(checksDir) : '', SKILL_DIR: path.join(__dirname, '..'), PUSH: push === 'no' ? 'no' : 'yes',
    MODE: mode, PARENT_CHANGES: parentChanges || 'none', PARENT_DIFF: parentDiff || 'none', PARENT_DIFF_FULL: parentDiffFull || 'none',
  };
}

// The parent's landed change for the agent's brief: the conflict agents of 2026-11-16 each ran
// three or four `git diff`/`git show` calls to see it. Cut to what this landing is about - the
// conflicting files, or (adapting) the files and names the red step's errors point at - plus the
// files whose changed lines hold a name of the parts below that this part still uses. On
// 2026-11-18 the whole parent went in, and the agent read 10-14 KB of it for a conflict in one
// import block. All of it stays in `parent-diff-full.patch`, named in the brief.
const parentDiffCap = 256 * 1024;
const capped = (text) => (text.length > parentDiffCap ? `${text.slice(0, parentDiffCap)}\n… (cut at ${parentDiffCap} bytes)\n` : text);

// `diff --git a/<path> b/<path>` sections of a diff, each with the path it changes.
function diffSections(diff) {
  return String(diff).split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git ')).map((text) => {
    const m = text.match(/^diff --git a\/(.*?) b\/(.*)$/m);
    return { path: m ? m[2] : '', text };
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const holdsName = (text, names) => names.some((n) => new RegExp(`(^|[^\\w$])${escapeRe(n)}($|[^\\w$])`).test(text));
const samePath = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

// What a red step's errors point at: the paths they name and the names they quote
// (`Cannot find name 'X'`, `has no exported member 'X'`). Read from each failed step's excerpt.
const notNames = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'null', 'undefined', 'object', 'this', 'true', 'false']);

function errorFocus(tree, steps) {
  const files = new Set();
  const names = new Set();
  const root = path.resolve(tree).replace(/\\/g, '/').toLowerCase();
  for (const step of (steps || []).filter((s) => s.status === 'failed' && s.errorsPath)) {
    let text = '';
    try {
      text = fs.readFileSync(step.errorsPath, 'utf8').slice(0, 512 * 1024);
    } catch {
      continue;
    }
    // Any `name.ext`: only a path the parent's diff changes is kept from it.
    for (const m of text.matchAll(/((?:[A-Za-z]:)?[\w@+.\-/\\]*[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,5})(?=[:(\s'",]|$)/gm)) {
      let p = m[1].replace(/\\/g, '/');
      if (p.toLowerCase().startsWith(`${root}/`)) p = p.slice(root.length + 1);
      files.add(p.replace(/^\.\//, ''));
    }
    for (const m of text.matchAll(/'([A-Za-z_$][\w$]*)'/g)) if (!notNames.has(m[1])) names.add(m[1]);
  }
  return { files: [...files], names: [...names].slice(0, 40) };
}

// Writes the full diff and the cut one; answers both paths (`none` for an empty one).
function writeParentDiff(tree, from, to, focus, dir) {
  if (!from || !to) return { parentDiff: 'none', parentDiffFull: 'none' };
  const res = spawnSync('git', ['-C', tree, 'diff', from, to], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const diff = res.status === 0 ? String(res.stdout || '') : '';
  if (!diff.trim()) return { parentDiff: 'none', parentDiffFull: 'none' };
  const full = path.join(dir, 'parent-diff-full.patch');
  fs.writeFileSync(full, capped(diff), 'utf8');
  const changedLines = (text) => text.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).join('\n');
  const picked = diffSections(diff).filter((s) => focus.files.some((f) => samePath(s.path, f)) || (focus.names.length > 0 && holdsName(changedLines(s.text), focus.names)));
  const cut = path.join(dir, 'parent-diff.patch');
  if (picked.length === 0) {
    fs.rmSync(cut, { force: true });
    return { parentDiff: 'none', parentDiffFull: full };
  }
  fs.writeFileSync(cut, capped(picked.map((s) => s.text).join('')), 'utf8');
  return { parentDiff: cut, parentDiffFull: full };
}

// The entries of the parts below whose name this part's files still hold now - an entry its own
// fix already took out of those files is no longer this landing's business.
function stillUsed(tree, items) {
  return (items || []).filter((item) => {
    const files = [...new Set((item.uses || []).map((u) => String(u).replace(/:\d+$/, '')))];
    return files.some((f) => {
      try {
        return holdsName(fs.readFileSync(path.join(tree, f), 'utf8'), [String(item.symbol)]);
      } catch {
        return false;
      }
    });
  });
}

// --- A missing git identity --------------------------------------------------------------------
//
// On 2026-11-18 user.name and user.email were gone from the global git config. The rebase stopped
// at its first pick, land answered `conflict` with no conflicting file, and a landing agent spent
// 4 minutes and about 55k tokens finding "Committer identity unknown". It is an error, named.
const identityProblem = /Committer identity unknown|Author identity unknown|Please tell me who you are|unable to auto-detect email address|no email was given and auto-detection is disabled|empty ident name/i;

function identityMessage(dir, gitText) {
  const missing = ['user.name', 'user.email'].filter((k) => !git(dir, ['config', '--get', k]).ok);
  const what = missing.length === 0 ? 'user.name or user.email is' : `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'}`;
  const said = String(gitText || '').split(/\r?\n/).find((l) => /^fatal:/.test(l.trim())) || firstLine(gitText);
  return `No git identity: ${what} not set, so git cannot write the moved commits${said ? ` (git: ${said.trim()})` : ''}. Set it - git config --global user.name "<name>" and git config --global user.email "<email>" - and run again. Nothing was moved.`;
}

// null when git can write a commit in `dir`; the error otherwise. `git var` asks the way a commit does.
function checkIdentity(dir) {
  const res = git(dir, ['var', 'GIT_COMMITTER_IDENT']);
  return !res.ok && identityProblem.test(res.err) ? identityMessage(dir, res.err) : null;
}

function land(options, { runGate = defaultGate } = {}) {
  const tree = path.resolve(options.worktree);
  const { branch, parent } = options;
  const result = {
    action: 'land', branch, parent, status: 'error', rebased: false, pushed: false, commit: null,
    oldParentTip: null, newParentTip: null, conflictFiles: [], autoResolved: [], gate: null, warnings: [], errors: [],
  };
  // Merged without a person only where the gate then proves it (or a caller says so outright).
  const mayResolve = options.autoResolve === 'yes' || (options.autoResolve !== 'no' && options.gate !== 'no');
  const fail = (message) => {
    result.errors.push(message);
    return result;
  };
  // What the agent's brief needs and this landing knows, for render-agent-prompt.cjs --vars: the
  // orchestrator adds only the pull request and its language.
  const writeBrief = (mode, { oldTip, lease, files, steps = [] }) => {
    if (!options.checksDir) return;
    const dir = path.resolve(options.checksDir);
    const varsFile = path.join(dir, 'restack-agent-vars.json');
    try {
      fs.mkdirSync(dir, { recursive: true });
      // An explicit --parent-changes text goes in as given; the run file's entries only where this
      // part still uses them.
      const impact = options.parentImpact ? stillUsed(tree, options.parentImpact) : null;
      const parentChanges = impact ? formatImpact(impact) : options.parentChanges || 'none';
      const fromErrors = mode === 'adapt' ? errorFocus(tree, steps) : { files: [], names: [] };
      const focus = { files: [...files, ...fromErrors.files], names: [...new Set([...(impact || []).map((i) => i.symbol), ...fromErrors.names])] };
      const diffs = writeParentDiff(tree, oldTip, result.newParentTip, focus, dir);
      fs.writeFileSync(varsFile, `${JSON.stringify(briefVarsOf({
        tree, branch, parent, oldTip, lease, files, checksDir: options.checksDir, push: options.push, mode, parentChanges, ...diffs,
      }), null, 1)}\n`, 'utf8');
      result.briefVars = varsFile;
      result.mode = mode;
    } catch (err) {
      result.warnings.push(`Could not write ${varsFile}: ${(err && err.message) || err}`);
    }
  };
  if (!git(tree, ['rev-parse', '--git-dir']).ok) return fail(`Not a git worktree: ${tree}`);
  // A tracked file the install touched (husky's line endings, 2026-11-03) is no reason to leave a
  // part behind: the rebase stashes it and puts it back, and only commits are pushed.
  if (git(tree, ['status', '--porcelain', '--untracked-files=no']).out) result.warnings.push(`${tree} holds uncommitted changes; they stay uncommitted (rebase --autostash).`);

  // Where the branch stood on origin when the run began: the lease. The remote-tracking ref of
  // the worktree is that too, as long as nothing fetched the branch since the worktree was made.
  const lease = options.remoteTipAtStart || git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  // The reason travels with the warning: on 2026-11-18 it was a credential store git could not
  // use from this process, and the bare "could not fetch" hid that until the push failed.
  const fetched = git(tree, ['fetch', '--quiet', 'origin', parent], { GIT_TERMINAL_PROMPT: '0' });
  if (!fetched.ok) result.warnings.push(`Could not fetch origin/${parent} (${firstLine(fetched.err) || 'no reason given'}); moving onto the ref the repository already has - preflight.cjs names the fix.`);
  const upstream = `origin/${parent}`;
  const now = git(tree, ['rev-parse', '--verify', '--quiet', upstream]);
  if (!now.ok) return fail(`${upstream} does not exist.`);
  result.newParentTip = now.out;
  const before = git(tree, ['rev-parse', 'HEAD']).out;
  // An old tip the part was not built on moves the wrong commits, or none: on 2026-11-18 a
  // cascade given a wrong --from-old-tip answered `landed` with the part where it was.
  if (options.parentTipAtStart) {
    const given = options.parentTipAtStart;
    const tip = git(tree, ['rev-parse', '--verify', '--quiet', `${given}^{commit}`]);
    if (!tip.ok) return fail(`The old tip of ${parent} given, ${given}, is no commit of this repository: nothing was moved. Give the commit of ${parent} that ${branch} was built on.`);
    if (!git(tree, ['merge-base', '--is-ancestor', tip.out, 'HEAD']).ok) {
      return fail(`The old tip of ${parent} given, ${given.slice(0, 12)}, is not an ancestor of ${branch} (${before.slice(0, 12)}): ${branch} was not built on it, so a move off it would replay the wrong commits. Nothing was moved. Give the commit of ${parent} that ${branch} sits on - \`git merge-base origin/${parent} origin/${branch}\` names one when ${parent} has not been rewritten since.`);
    }
  }

  if (!git(tree, ['merge-base', '--is-ancestor', upstream, 'HEAD']).ok) {
    // A move writes commits: without an identity git stops at the first pick (see checkIdentity).
    const noIdentity = checkIdentity(tree);
    if (noIdentity) return fail(noIdentity);
    let forkPoint = options.parentTipAtStart || git(tree, ['merge-base', '--fork-point', upstream, 'HEAD']).out || git(tree, ['merge-base', upstream, 'HEAD']).out;
    if (!forkPoint) return fail(`No old tip of ${parent} to move ${branch} off: give --parent-tip-at-start.`);
    // An old tip the caller named is where the part's own commits begin; one guessed from the
    // merge-base may sit under a parent that was squash-merged since.
    if (!options.parentTipAtStart || (options.mergedHeads || []).length > 0) {
      const squashed = squashedBoundary(tree, upstream, 'HEAD', forkPoint, options.mergedHeads);
      if (squashed) {
        forkPoint = squashed.boundary;
        result.squashed = squashed;
        const into = squashed.into ? ` as ${squashed.into.slice(0, 9)}` : '';
        result.warnings.push(`${squashed.commits} commit(s) up to ${squashed.boundary.slice(0, 9)} are already in ${parent}${into} (${squashed.via}, a squash merge): only the commits after it moved.`);
      }
    }
    result.oldParentTip = forkPoint;
    // rerere: a conflict resolved once (by hand, or by the conflict agent of an earlier run) is
    // resolved the same way the next time this part moves.
    const rebase = git(tree, ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true', 'rebase', '--autostash', '--onto', upstream, forkPoint], { GIT_EDITOR: 'true' });
    if (!rebase.ok) {
      let last = rebase;
      let done = false;
      const goOn = () => {
        last = git(tree, ['-c', 'rerere.enabled=true', 'rebase', '--continue'], { GIT_EDITOR: 'true' });
        done = last.ok;
        return done;
      };
      for (let round = 0; round < 50; round += 1) {
        // Another --continue would only fail the same way.
        if (identityProblem.test(`${last.err}\n${last.out}`)) break;
        const unmerged = git(tree, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
        if (unmerged.length > 0 && mayResolve) {
          const settled = unmerged.map((file) => ({ file, how: autoResolve(tree, file) }));
          if (settled.every((s) => s.how)) {
            result.autoResolved.push(...settled);
            if (goOn()) break;
            continue;
          }
        }
        if (unmerged.length > 0 || !inRebase(tree)) {
          result.conflictFiles = unmerged;
          break;
        }
        // Every conflict of this commit was resolved from rerere's record: go on.
        if (goOn()) break;
      }
      const why = `${last.err}\n${last.out}`;
      const stuck = inRebase(tree);
      if (stuck) git(tree, ['rebase', '--abort']);
      if (identityProblem.test(why)) {
        result.autoResolved = [];
        return fail(identityMessage(tree, why));
      }
      if (stuck && result.conflictFiles.length > 0) {
        result.status = 'conflict';
        writeBrief('conflict', { oldTip: forkPoint, lease, files: result.conflictFiles });
        return result;
      }
      // A stop with no conflicting file is no conflict an agent can resolve: git's own reason.
      if (stuck || (!done && git(tree, ['rev-parse', 'HEAD']).out === before)) {
        result.autoResolved = [];
        return fail(`git rebase stopped with no conflicting file: ${firstLine(why.split(/\r?\n/).find((l) => /^(fatal|error):/.test(l.trim())) || why) || 'no reason given'}. Nothing was moved.`);
      }
    }
    result.rebased = true;
  }

  const checksDir = options.checksDir ? path.resolve(options.checksDir) : path.join(tree, '..', `${path.basename(tree)}-restack-checks`);
  // The full gate runs when the move changed the code under the part. A move that left the tree
  // byte for byte as it was (the parent's commits rewritten, not changed) proves nothing new:
  // on 2026-11-06 part-5 sat through a full gate after a move from 0e53405 onto 0e53405.
  let fullGate = false;
  const pending = (options.pendingSteps || []).filter(Boolean);
  if (result.rebased && options.gate !== 'no') {
    if (git(tree, ['diff', '--quiet', before, 'HEAD']).ok) {
      result.gate = { gate: 'skipped', steps: [], errors: [], reason: 'the move left the tree as it was' };
    } else {
      fullGate = true;
    }
  }
  // Steps the fixing agent left to the landing (a held part's build): they run here once, on
  // the code that is pushed, when the full gate does not.
  if (fullGate || (pending.length > 0 && options.gate !== 'no')) {
    const gate = runGate({ worktree: tree, checksDir, parent, only: fullGate ? [] : pending });
    result.gate = gateSummary(gate);
    if (!['green', 'skipped', ...(fullGate ? [] : ['partial'])].includes(gate.gate) || (gate.steps || []).some((s) => s.status === 'failed')) {
      // `--keep`, not `--hard`: an uncommitted file the move did not touch stays as it was.
      if (!git(tree, ['reset', '--keep', before]).ok) result.warnings.push(`Could not take ${branch} back to ${before}; it holds the moved commits.`);
      result.status = 'gate-red';
      // The gate's red steps are this part's code meeting what landed below it: the conflict agent
      // adapts it (MODE adapt) instead of the run ending here with a question for the user.
      writeBrief('adapt', { oldTip: result.oldParentTip || options.parentTipAtStart || '', lease, files: [], steps: gate.steps || [] });
      return result;
    }
  }

  result.commit = git(tree, ['rev-parse', 'HEAD']).out;
  const remote = git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  // Nothing moved and origin already has it: a no-op, said as one - never `landed` with a
  // skipped gate, which reads as a move that happened.
  if (result.commit === before && (remote || lease) === result.commit) {
    result.status = 'noop';
    result.rebased = false;
    if (result.gate && result.gate.gate === 'skipped') result.gate = null;
    result.reason = `${branch} already sits on origin/${parent} (${result.newParentTip.slice(0, 12)}) and origin has ${result.commit.slice(0, 12)}: nothing to move or push.`;
    return result;
  }
  if (options.push === 'no') {
    result.status = 'landed';
    return result;
  }
  // A rewritten branch replaces the remote one only where it still stands where the run began.
  // HEAD, not the local branch name: a branch the user has checked out is worked on a branch of
  // the run's own (worktree.cjs), and pushed to the pull request's branch all the same.
  const pushArgs = result.rebased
    ? (lease ? ['push', `--force-with-lease=${branch}:${lease}`, 'origin', `HEAD:refs/heads/${branch}`] : null)
    : ['push', 'origin', `HEAD:refs/heads/${branch}`];
  if (!pushArgs) return fail(`No remote tip to pin the lease to for ${branch}; push it yourself once checked.`);
  const pushed = pushWithRetry(tree, pushArgs, options.pushRetry);
  if (pushed.attempts > 1) result.warnings.push(`The push took ${pushed.attempts} attempts.`);
  if (!pushed.ok) {
    result.status = 'push-rejected';
    result.errors.push(firstLine(pushed.err.split(/\r?\n/).find((l) => /rejected|stale|error/i.test(l)) || pushed.err));
    return result;
  }
  result.pushed = true;
  result.status = 'landed';
  return result;
}

function inRebase(tree) {
  const dir = git(tree, ['rev-parse', '--absolute-git-dir']).out;
  return Boolean(dir) && (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply')));
}

// After a run: every part that does not sit on its parent, with the command that moves it.
function verify(options) {
  const project = path.resolve(options.project);
  const result = { action: 'verify', ok: [], broken: [], warnings: [], errors: [] };
  const branches = [...new Set(options.pairs.flatMap((p) => [p.parent, p.child]))];
  const fetched = git(project, ['fetch', '--quiet', 'origin', ...branches], { GIT_TERMINAL_PROMPT: '0' });
  if (!fetched.ok) result.warnings.push(`Could not fetch every branch (${firstLine(fetched.err) || 'no reason given'}); compared the refs the repository already has.`);
  for (const { parent, child, oldTip } of options.pairs) {
    const name = `${parent}>${child}`;
    if (git(project, ['merge-base', '--is-ancestor', `origin/${parent}`, `origin/${child}`]).ok) {
      result.ok.push(name);
      continue;
    }
    let from = oldTip || git(project, ['merge-base', `origin/${parent}`, `origin/${child}`]).out || '';
    if (!oldTip && from) {
      const squashed = squashedBoundary(project, `origin/${parent}`, `origin/${child}`, from, options.mergedHeads);
      if (squashed) {
        from = squashed.boundary;
        result.warnings.push(`${squashed.commits} commit(s) of ${child} up to ${from.slice(0, 9)} are already in ${parent} (${squashed.via}, a squash merge): the move replays only the commits after it.`);
      }
    }
    result.broken.push({ parent, child, command: `git rebase --onto origin/${parent} ${from || `<old ${parent} tip>`} ${child}` });
  }
  return result;
}

// The fixing agent's own push (fix-agent.md step 6), with the retry above: a plain push, or a
// lease pinned to `--lease` after a rebase.
function push(options, { pushRetry } = {}) {
  const tree = path.resolve(options.worktree);
  const args = options.lease
    ? ['push', `--force-with-lease=${options.branch}:${options.lease}`, 'origin', `HEAD:refs/heads/${options.branch}`]
    : ['push', 'origin', `HEAD:refs/heads/${options.branch}`];
  const res = pushWithRetry(tree, args, pushRetry);
  const line = firstLine(String(res.err || '').split(/\r?\n/).find((l) => /rejected|stale|error|fatal/i.test(l)) || res.err);
  return { action: 'push', branch: options.branch, pushed: res.ok, attempts: res.attempts, rejected: !res.ok && rejectedPush.test(res.err), warnings: [], errors: res.ok ? [] : [line || 'push failed'] };
}

// A change landed on one part AFTER the run - a follow-up the user asked for on part-1 - moves
// every part above it, bottom-up, the way Step 5 moves a held part: own commits only, the gate
// when the move brought new code, a lease on where each part stood. On 2026-11-05 one ellipsis
// added to part-1 cost four agents and 12.5M tokens to restack part-2..5; with the append
// conflicts merged above this needs none. Each part gets a worktree of its own for the move and
// loses it after; the first part that does not land stops the climb, and the ones above it wait.
function cascade(options, deps = {}) {
  const from = options.stack.indexOf(options.from);
  const result = climb({ ...options, startIndex: from + 1, startParentOldTip: options.fromOldTip || '', startParentOldTipGiven: Boolean(options.fromOldTip) }, deps);
  return { action: 'cascade', from: options.from, ...result };
}

// The compact form of a part's landing - what an orchestrator acts on, nothing it only reads past:
// the gate as its verdict and the red steps' excerpts, never every step's log path.
function compactPart(p) {
  const gate = p.gate || null;
  return {
    branch: p.branch, parent: p.parent || null, status: p.status, commit: p.commit || null, oldTip: p.oldTip || null,
    rebased: Boolean(p.rebased), pushed: Boolean(p.pushed), gate: gate ? gate.gate : null,
    redSteps: gate ? (gate.steps || []).filter((s) => s.status === 'failed').map((s) => ({ label: s.label, errorsPath: s.errorsPath || null })) : [],
    conflictFiles: p.conflictFiles || [], oldParentTip: p.oldParentTip || null,
    autoResolved: (p.autoResolved || []).map((r) => r.file || r), worktree: p.worktree || null,
    ...(p.squashed ? { squashed: p.squashed } : {}), ...(p.briefVars ? { briefVars: p.briefVars } : {}), ...(p.mode ? { mode: p.mode } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
    warnings: p.warnings || [], errors: p.errors || [],
  };
}

// Moves parts of a stack bottom-up from stack[startIndex], each onto where its parent stands now:
// a worktree per part (worktree.cjs, which also takes a branch the user has checked out), land,
// the worktree taken down. The first part that does not land stops the climb and keeps its
// worktree for the conflict agent; the parts above it wait. Each part carries `oldTip` - where
// it stood before - which is what the part above moves off when the climb resumes there.
function climb(options, deps = {}) {
  const worktree = deps.worktree || require('./worktree.cjs');
  const landPart = deps.land || land;
  const project = path.resolve(options.project);
  const { stack, startIndex } = options;
  const result = { parts: [], waiting: [], warnings: [], errors: [] };
  const stopBefore = (message) => {
    result.errors.push(message);
    result.waiting = stack.slice(startIndex);
    return result;
  };
  // Checked once, before any worktree: every move of the climb writes commits.
  const noIdentity = (deps.identity || (deps.tips ? () => null : checkIdentity))(project);
  if (noIdentity) return stopBefore(noIdentity);
  const refs = [...stack, ...(options.base ? [options.base] : [])];
  if (!deps.tips) git(project, ['fetch', '--quiet', 'origin', ...refs]);
  const tipOf = (b) => (deps.tips ? deps.tips[b] || null : git(project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).out || null);
  const sitsOn = deps.isAncestor || (deps.tips ? () => true : (sha, b) => git(project, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${b}`]).ok);
  // Where every part stands now: its lease, and the old tip its own child moves off.
  const tips = new Map(stack.map((b) => [b, tipOf(b)]));
  const oldTip = new Map(tips);
  const startParent = startIndex === 0 ? options.base : stack[startIndex - 1];
  if (!startParent) {
    result.errors.push(`No base for ${stack[0]}: give --base.`);
    return result;
  }
  if (options.startParentOldTip) {
    // A tip the caller named (--from-old-tip, --parent-old-tip) the first part was not built on
    // would move it wrong, or not at all: refused before anything moves.
    if (options.startParentOldTipGiven && !sitsOn(options.startParentOldTip, stack[startIndex])) {
      return stopBefore(`${options.startParentOldTip} is not an ancestor of ${stack[startIndex]}: it is not where ${startParent} stood when ${stack[startIndex]} was built on it, so nothing was moved. Give the old tip of ${startParent} that ${stack[startIndex]} sits on (a part's \`oldTip\` in the JSON of the climb that moved ${startParent}).`);
    }
    oldTip.set(startParent, options.startParentOldTip);
  }
  for (let i = startIndex; i < stack.length; i += 1) {
    const branch = stack[i];
    const parent = i === 0 ? options.base : stack[i - 1];
    // A part that did not sit on its parent before the climb (a stack out of line) moves off the
    // last commit it shares with it: land refuses an old tip that is not an ancestor.
    let parentTip = i === 0 ? options.startParentOldTip || '' : oldTip.get(parent) || '';
    if (parentTip && !(i === startIndex && options.startParentOldTipGiven) && !sitsOn(parentTip, branch)) {
      const shared = deps.tips ? '' : git(project, ['merge-base', parentTip, `refs/remotes/origin/${branch}`]).out;
      result.warnings.push(`${branch} did not sit on ${parent} at ${parentTip.slice(0, 12)}; it moves off ${shared ? `${shared.slice(0, 12)}, the last commit it shares with it` : 'its fork point'}.`);
      parentTip = shared;
    }
    const added = worktree.add({ project, branch });
    if (!added.worktree || (added.errors && added.errors.length) || added.mainBroken) {
      if (added.mainBroken && added.worktree) worktree.remove({ project, branch });
      result.parts.push({ branch, parent, status: 'error', oldTip: tips.get(branch) || null, errors: added.mainBroken ? added.warnings || ['the main checkout has no complete node_modules'] : added.errors || ['no worktree'] });
      result.waiting = stack.slice(i + 1);
      return result;
    }
    let landed;
    try {
      landed = landPart({
        worktree: added.worktree, branch, parent,
        // The bottom moving onto its base: land finds the fork point itself (merge-base).
        parentTipAtStart: parentTip,
        remoteTipAtStart: tips.get(branch) || '',
        checksDir: options.checksDir ? path.join(options.checksDir, branch) : '', push: options.push || 'yes', gate: options.gate || 'yes',
        autoResolve: options.autoResolve || 'yes',
        // Only the bottom moves onto the base the merged pull requests went into.
        mergedHeads: i === 0 ? options.mergedHeads || [] : [],
      });
    } catch (err) {
      landed = { status: 'error', errors: [String((err && err.message) || err)] };
    }
    // A no-op leaves nothing to resolve: its worktree goes like a landed part's.
    const keep = !['landed', 'noop'].includes(landed.status);
    const removed = keep ? null : worktree.remove({ project, branch });
    result.parts.push({
      branch, parent, status: landed.status, commit: landed.commit || null, oldTip: tips.get(branch) || null, pushed: Boolean(landed.pushed), rebased: Boolean(landed.rebased),
      autoResolved: landed.autoResolved || [], conflictFiles: landed.conflictFiles || [], oldParentTip: landed.oldParentTip || null, gate: landed.gate || null,
      squashed: landed.squashed || null, mode: landed.mode || null, briefVars: landed.briefVars || null, reason: landed.reason || null,
      worktree: keep || (removed && !removed.removed) ? added.worktree : null, warnings: [...(added.warnings || []), ...(landed.warnings || []), ...((removed && removed.warnings) || [])], errors: landed.errors || [],
    });
    if (keep) {
      result.waiting = stack.slice(i + 1);
      return result;
    }
  }
  return result;
}

// The stack a branch belongs to, bottom-first, read from GitHub: down through the open pull
// requests its base is the head of, up through the open ones based on it. One branch named is
// enough for /doh:restack.
function discoverStack(project, branch, { findPr, childrenOf, mergedInto } = {}) {
  const github = require('../../codeReview/scripts/github.cjs');
  const pc = require('./pr-comments.cjs');
  const find = findPr || ((b) => github.findOpenPr(project, b).pr);
  const kids = childrenOf || ((b) => pc.openChildren(project, b));
  const merged = mergedInto || ((b) => github.mergedPrHeads(project, b).heads);
  const warnings = [];
  const below = [];
  const prs = {};
  const pr = find(branch);
  if (!pr) return { stack: [branch], base: null, prs, mergedHeads: [], warnings: [`${branch} has no open pull request; give the whole stack with --stack and its base with --base.`] };
  prs[branch] = { number: pr.number || null, url: pr.url || null };
  let base = pr.base;
  for (let guard = 0; base && guard < 20; guard += 1) {
    const under = find(base);
    if (!under || below.includes(base) || base === branch) break;
    prs[base] = { number: under.number || null, url: under.url || null };
    below.unshift(base);
    base = under.base;
  }
  const above = pc.stackAbove(branch, kids, warnings);
  for (const b of above) {
    const p = find(b);
    if (p) prs[b] = { number: p.number || null, url: p.url || null };
  }
  // The pull requests merged into the base: one squash-merged under the bottom shows here.
  const mergedHeads = base ? merged(base) || [] : [];
  return { stack: [...below, branch, ...above], base, prs, mergedHeads, warnings };
}

// The stack, its base and the pull requests, read once: an explicit --stack keeps its order, the
// base and the pull request numbers come from GitHub (the conflict agent's brief names them).
function resolveStack(project, options, deps) {
  const found = (deps.discover || discoverStack)(project, options.stack[0], deps);
  const stack = options.stack.length === 1 ? found.stack : options.stack;
  const base = options.base || (found.stack[0] === stack[0] ? found.base || '' : '');
  // Heads merged into another branch than the base the stack moves onto say nothing about it.
  const mergedHeads = base && base === found.base ? found.mergedHeads || [] : [];
  return { stack, base, prs: found.prs || {}, mergedHeads, warnings: found.warnings || [] };
}

// What /doh:restack would move, moving nothing: the stack, its base, and every pair that does not
// sit on its parent now (verify).
function plan(options, deps = {}) {
  const project = path.resolve(options.project);
  const pre = preflightOf(project, options, deps);
  const { stack, base, prs, mergedHeads, warnings } = resolveStack(project, options, deps);
  const pairs = [...(base ? [{ parent: base, child: stack[0], oldTip: null }] : []), ...stack.slice(1).map((child, i) => ({ parent: stack[i], child, oldTip: null }))];
  const checked = (deps.verify || verify)({ project, pairs, mergedHeads });
  return {
    action: 'plan', stack, base, prs, ok: checked.ok, broken: checked.broken, ...(pre ? { preflight: pre.summary } : {}),
    warnings: [...(pre ? pre.warnings : []), ...warnings, ...checked.warnings], errors: [...(pre ? pre.errors : []), ...checked.errors],
  };
}

// --preflight=yes: what the climb will need from this machine (preflight.cjs), checked before any
// part moves - origin reachable without a prompt (with --push=yes), a git identity for the rebase,
// a complete node_modules for the gate (with --gate=yes). The plan carries it for /doh:restack's
// Step 2; `stack` refuses to climb when it fails.
function preflightOf(project, options, deps) {
  if (options.preflight !== 'yes') return null;
  const run = deps.preflight || require('./preflight.cjs').preflight;
  const pre = run(project, { push: options.push !== 'no', commit: true, resolve: false, gate: options.gate !== 'no' });
  return { summary: { ok: pre.ok, checks: pre.checks }, errors: pre.errors, warnings: pre.warnings };
}

// /doh:restack: the whole stack, bottom-up. With --onto-base=yes (the default) the bottom moves
// onto its base first; every part above moves onto the part below it once that one has landed.
// --start resumes at a part (after a conflict agent landed the one below it: --parent-old-tip is
// where that one stood before - the stack's own JSON names it as that part's oldTip).
//
// At a conflict the climb renders the conflict agent's brief itself (`agentPrompt`): on 2026-11-10
// the orchestrator copied 29 conflicting paths and twelve values into `--set=` flags by hand. The
// list the orchestrator reads is capped (`conflictCount` keeps the number); the brief has it all.
// Every run leaves `restack-state.json` in the checks folder - the part it stopped at and where
// every part stood before - so `--resume=yes` takes the stopped part's worktree down and climbs on
// above it in one call, with no sha copied out of an earlier answer.
const agentTemplate = path.join(__dirname, '..', 'references', 'restack-agent.md');
const conflictListCap = 10;

function renderConflictBrief(project, part, { prs, checksDir, push, language }) {
  const rap = require('../../../scripts/render-agent-prompt.cjs');
  const slug = part.branch.replace(/[\\/]/g, '-');
  const pr = prs[part.branch] || {};
  // The parent's diffs land wrote next to its vars; a climb runs no fix agent, so no change below.
  let landed = {};
  try {
    landed = part.briefVars ? JSON.parse(fs.readFileSync(part.briefVars, 'utf8')) : {};
  } catch {
    landed = {};
  }
  const values = {
    ROOT: part.worktree || '', BRANCH: part.branch, PR_NUMBER: pr.number ? String(pr.number) : 'none', PR_URL: pr.url || 'none',
    PARENT: part.parent || '', OLD_TIP: part.oldParentTip || '', LEASE: part.oldTip || '', FILES: (part.conflictFiles || []).length ? part.conflictFiles.join(', ') : 'none',
    CHECKS_DIR: path.join(checksDir, part.branch), SKILL_DIR: path.join(__dirname, '..'), PUSH: push || 'yes', LANGUAGE: language || 'English',
    PARENT_CHANGES: 'none', MODE: part.mode || 'conflict', PARENT_DIFF: landed.PARENT_DIFF || 'none', PARENT_DIFF_FULL: landed.PARENT_DIFF_FULL || 'none',
  };
  const rendered = rap.renderFile({ template: agentTemplate, out: path.join(project, '.claude', 'doh', slug, `${slug}-restack-agent-prompt.md`), values });
  return { agentPrompt: rendered.errors.length ? null : rendered.out, agentPromptErrors: rendered.errors };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
}

function stackAction(options, deps = {}) {
  const project = path.resolve(options.project);
  const checksDir = options.checksDir ? path.resolve(options.checksDir) : path.join(project, '.claude', 'doh', 'restack-checks');
  const stateFile = path.join(checksDir, 'restack-state.json');
  const pre = options.resume === 'yes' ? null : preflightOf(project, options, deps);
  if (pre && !pre.summary.ok) return { action: 'stack', stack: options.stack, base: options.base || '', prs: {}, preflight: pre.summary, parts: [], waiting: [], warnings: pre.warnings, errors: pre.errors };
  const { stack, base, prs, mergedHeads, warnings } = resolveStack(project, options, deps);
  if (pre) warnings.unshift(...pre.warnings);
  const head = { action: 'stack', stack, base, prs };
  const stop = (message) => ({ ...head, parts: [], waiting: [], warnings, errors: [message] });
  let startIndex;
  let startParentOldTip = options.parentOldTip || '';
  let resumedAfter = null;
  if (options.resume === 'yes') {
    const state = readState(stateFile);
    if (!state || !state.stopped) return stop(`Nothing to resume: ${stateFile} names no part where a climb stopped.`);
    const at = stack.indexOf(state.stopped);
    if (at < 0) return stop(`${state.stopped}, where the last climb stopped, is not a part of ${stack.join(' <- ')}.`);
    const parent = at === 0 ? base : stack[at - 1];
    if (!deps.tips) git(project, ['fetch', '--quiet', 'origin', parent, state.stopped]);
    const sits = deps.sits || ((p, c) => git(project, ['merge-base', '--is-ancestor', `origin/${p}`, `origin/${c}`]).ok);
    if (!sits(parent, state.stopped)) return stop(`${state.stopped} does not sit on ${parent} yet: land it first (the conflict agent's push), then resume.`);
    const removed = (deps.worktree || require('./worktree.cjs')).remove({ project, branch: state.stopped });
    warnings.push(...((removed && removed.warnings) || []));
    if (removed && removed.removed === false) warnings.push(`The worktree of ${state.stopped} was not taken down: ${((removed.errors || [])[0]) || 'see worktree.cjs'}.`);
    resumedAfter = state.stopped;
    startIndex = at + 1;
    startParentOldTip = (state.oldTips || {})[state.stopped] || '';
    if (startIndex >= stack.length) {
      writeState(stateFile, { ...state, stopped: null, at: new Date().toISOString() });
      return { ...head, resumedAfter, parts: [], waiting: [], warnings, errors: [] };
    }
  } else {
    startIndex = options.start ? stack.indexOf(options.start) : options.ontoBase === 'no' ? 1 : 0;
    if (startIndex < 0) return stop(`${options.start} is not a part of ${stack.join(' <- ')}.`);
  }
  const result = climb({ ...options, project, stack, base, startIndex, startParentOldTip, startParentOldTipGiven: Boolean(options.parentOldTip) && options.resume !== 'yes', checksDir, mergedHeads }, deps);
  const parts = result.parts.map(compactPart);
  const last = parts[parts.length - 1];
  if (last && (last.status === 'conflict' || (last.status === 'gate-red' && last.mode === 'adapt'))) Object.assign(last, renderConflictBrief(project, last, { prs, checksDir, push: options.push, language: options.language }));
  for (const p of parts) {
    p.conflictCount = p.conflictFiles.length;
    p.conflictFiles = p.conflictFiles.slice(0, conflictListCap);
  }
  const previous = readState(stateFile);
  writeState(stateFile, {
    stack, base, stopped: last && !['landed', 'noop'].includes(last.status) ? last.branch : null,
    oldTips: { ...((previous && previous.oldTips) || {}), ...Object.fromEntries(result.parts.map((p) => [p.branch, p.oldTip])) },
    at: new Date().toISOString(),
  });
  return { ...head, ...(resumedAfter ? { resumedAfter } : {}), ...result, parts, warnings: [...warnings, ...result.warnings] };
}

function compactLand(result) {
  return { action: 'land', ...compactPart(result) };
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = args.action === 'verify' ? verify(args)
      : args.action === 'push' ? push(args)
        : args.action === 'cascade' ? cascade(args)
          : args.action === 'stack' ? stackAction(args)
            : args.action === 'plan' ? plan(args)
            : args.summary === 'yes' ? compactLand(land(args)) : land(args);
  } catch (err) {
    result = { status: 'error', errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = {
  parseArgs, parsePairs, land, verify, push, cascade, climb, stackAction, plan, discoverStack, compactPart, landOptionsFromRun, pairsFromRun, parentChangesOf, parentImpactOf,
  formatImpact, mergeJson3, mergeImports, autoResolve, pushWithRetry, squashedBoundary, briefVarsOf, checkIdentity, identityProblem, absent,
};

if (require.main === module) main();
