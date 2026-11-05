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
// Prints one JSON object. land: `status` is landed | conflict | gate-red | push-rejected | error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checksScript = path.join(__dirname, 'checks.cjs');

function parseArgs(argv) {
  const args = {
    action: 'land', push: 'yes', gate: 'yes', autoResolve: 'yes', parentTipAtStart: '', remoteTipAtStart: '', checksDir: '', pairs: [],
    lease: '', stack: [], from: '', fromOldTip: '',
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
    else unknown.push(arg);
  }
  // This script rewrites and pushes a branch: a mistyped flag stops it.
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --worktree, --branch, --parent, --parent-tip-at-start, --remote-tip-at-start, --checks-dir, --push, --gate, --auto-resolve, --project, --pairs, --lease, --stack, --from, --from-old-tip).`);
  if (!['land', 'verify', 'push', 'cascade'].includes(args.action)) throw new Error(`Unknown --action=${args.action} (expected land|verify|push|cascade).`);
  if (![args.push, args.gate, args.autoResolve].every((v) => ['yes', 'no'].includes(v))) throw new Error('--push, --gate and --auto-resolve take yes or no.');
  if (args.action === 'land' && (!args.worktree || !args.branch || !args.parent)) throw new Error('land needs --worktree, --branch and --parent.');
  if (args.action === 'verify' && (!args.project || args.pairs.length === 0)) throw new Error('verify needs --project and --pairs.');
  if (args.action === 'push' && (!args.worktree || !args.branch)) throw new Error('push needs --worktree and --branch.');
  if (args.action === 'cascade' && (!args.project || args.stack.length < 2 || !args.stack.includes(args.from))) throw new Error('cascade needs --project, --stack with two parts or more, and --from naming one of them.');
  return args;
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
function defaultGate({ worktree, checksDir, parent }) {
  const res = spawnSync(process.execPath, [checksScript, `--root=${worktree}`, `--out-dir=${checksDir}`, `--changed-since=origin/${parent}`], {
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

// Every conflict of `merge-file --diff3` is two insertions at one spot (an empty base): keep
// ours, then the lines of theirs ours does not already hold.
function resolveInsertions(tree, file) {
  const stages = [2, 1, 3].map((s) => stageRaw(tree, s, file));
  if (stages[0] === null || stages[2] === null) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restack-merge-'));
  try {
    const names = ['ours', 'base', 'theirs'].map((n, i) => {
      const p = path.join(dir, n);
      fs.writeFileSync(p, stages[i] === null ? '' : stages[i]);
      return p;
    });
    const res = spawnSync('git', ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...names], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (res.status === null || res.status < 0) return null;
    const lines = String(res.stdout).split(/(?<=\n)/);
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('<<<<<<< ')) { out.push(lines[i]); continue; }
      const block = { ours: [], base: [], theirs: [] };
      let part = 'ours';
      for (i += 1; i < lines.length && !lines[i].startsWith('>>>>>>> '); i += 1) {
        if (lines[i].startsWith('||||||| ')) part = 'base';
        else if (lines[i].startsWith('=======')) part = 'theirs';
        else block[part].push(lines[i]);
      }
      if (block.base.length > 0) return null;
      const held = new Set(block.ours.map((l) => l.replace(/\r?\n$/, '')));
      out.push(...block.ours, ...block.theirs.filter((l) => !held.has(l.replace(/\r?\n$/, ''))));
    }
    return out.join('');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Resolves `file` in the rebase in progress when it is one of the two shapes above; answers how.
function autoResolve(tree, file) {
  const text = file.toLowerCase().endsWith('.json') ? resolveJson(tree, file) : resolveInsertions(tree, file);
  if (text === null) return null;
  fs.writeFileSync(path.join(tree, file), text);
  if (!git(tree, ['add', '--', file]).ok) return null;
  return file.toLowerCase().endsWith('.json') ? 'json-keys' : 'both-insertions';
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
  if (!git(tree, ['rev-parse', '--git-dir']).ok) return fail(`Not a git worktree: ${tree}`);
  // A tracked file the install touched (husky's line endings, 2026-11-03) is no reason to leave a
  // part behind: the rebase stashes it and puts it back, and only commits are pushed.
  if (git(tree, ['status', '--porcelain', '--untracked-files=no']).out) result.warnings.push(`${tree} holds uncommitted changes; they stay uncommitted (rebase --autostash).`);

  // Where the branch stood on origin when the run began: the lease. The remote-tracking ref of
  // the worktree is that too, as long as nothing fetched the branch since the worktree was made.
  const lease = options.remoteTipAtStart || git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  if (!git(tree, ['fetch', '--quiet', 'origin', parent]).ok) result.warnings.push(`Could not fetch origin/${parent}; moving onto the ref the repository already has.`);
  const upstream = `origin/${parent}`;
  const now = git(tree, ['rev-parse', '--verify', '--quiet', upstream]);
  if (!now.ok) return fail(`${upstream} does not exist.`);
  result.newParentTip = now.out;
  const before = git(tree, ['rev-parse', 'HEAD']).out;

  if (!git(tree, ['merge-base', '--is-ancestor', upstream, 'HEAD']).ok) {
    const forkPoint = options.parentTipAtStart || git(tree, ['merge-base', '--fork-point', upstream, 'HEAD']).out || git(tree, ['merge-base', upstream, 'HEAD']).out;
    if (!forkPoint) return fail(`No old tip of ${parent} to move ${branch} off: give --parent-tip-at-start.`);
    result.oldParentTip = forkPoint;
    // rerere: a conflict resolved once (by hand, or by the conflict agent of an earlier run) is
    // resolved the same way the next time this part moves.
    const rebase = git(tree, ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true', 'rebase', '--autostash', '--onto', upstream, forkPoint], { GIT_EDITOR: 'true' });
    if (!rebase.ok) {
      for (let round = 0; round < 50; round += 1) {
        const unmerged = git(tree, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
        if (unmerged.length > 0 && mayResolve) {
          const settled = unmerged.map((file) => ({ file, how: autoResolve(tree, file) }));
          if (settled.every((s) => s.how)) {
            result.autoResolved.push(...settled);
            if (git(tree, ['-c', 'rerere.enabled=true', 'rebase', '--continue'], { GIT_EDITOR: 'true' }).ok) break;
            continue;
          }
        }
        if (unmerged.length > 0 || !inRebase(tree)) {
          result.conflictFiles = unmerged;
          break;
        }
        // Every conflict of this commit was resolved from rerere's record: go on.
        if (git(tree, ['-c', 'rerere.enabled=true', 'rebase', '--continue'], { GIT_EDITOR: 'true' }).ok) break;
      }
      if (inRebase(tree)) {
        git(tree, ['rebase', '--abort']);
        result.status = 'conflict';
        return result;
      }
    }
    result.rebased = true;
  }

  if (result.rebased && options.gate !== 'no') {
    const checksDir = options.checksDir ? path.resolve(options.checksDir) : path.join(tree, '..', `${path.basename(tree)}-restack-checks`);
    const gate = runGate({ worktree: tree, checksDir, parent });
    result.gate = gateSummary(gate);
    if (gate.gate !== 'green' && gate.gate !== 'skipped') {
      // `--keep`, not `--hard`: an uncommitted file the move did not touch stays as it was.
      if (!git(tree, ['reset', '--keep', before]).ok) result.warnings.push(`Could not take ${branch} back to ${before}; it holds the moved commits.`);
      result.status = 'gate-red';
      return result;
    }
  }

  result.commit = git(tree, ['rev-parse', 'HEAD']).out;
  if (options.push === 'no') {
    result.status = 'landed';
    return result;
  }
  const remote = git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  if (!result.rebased && remote === result.commit) {
    result.warnings.push('Nothing to push: the branch is where origin has it.');
    result.status = 'landed';
    return result;
  }
  // A rewritten branch replaces the remote one only where it still stands where the run began.
  const pushArgs = result.rebased
    ? (lease ? ['push', `--force-with-lease=${branch}:${lease}`, 'origin', branch] : null)
    : ['push', 'origin', branch];
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
  if (!git(project, ['fetch', '--quiet', 'origin', ...branches]).ok) result.warnings.push('Could not fetch every branch; compared the refs the repository already has.');
  for (const { parent, child, oldTip } of options.pairs) {
    const name = `${parent}>${child}`;
    if (git(project, ['merge-base', '--is-ancestor', `origin/${parent}`, `origin/${child}`]).ok) {
      result.ok.push(name);
      continue;
    }
    const from = oldTip || git(project, ['merge-base', `origin/${parent}`, `origin/${child}`]).out || `<old ${parent} tip>`;
    result.broken.push({ parent, child, command: `git rebase --onto origin/${parent} ${from} ${child}` });
  }
  return result;
}

// The fixing agent's own push (fix-agent.md step 6), with the retry above: a plain push, or a
// lease pinned to `--lease` after a rebase.
function push(options, { pushRetry } = {}) {
  const tree = path.resolve(options.worktree);
  const args = options.lease
    ? ['push', `--force-with-lease=${options.branch}:${options.lease}`, 'origin', options.branch]
    : ['push', 'origin', options.branch];
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
  const worktree = deps.worktree || require('./worktree.cjs');
  const landPart = deps.land || land;
  const project = path.resolve(options.project);
  const stack = options.stack;
  const from = stack.indexOf(options.from);
  const result = { action: 'cascade', from: options.from, parts: [], waiting: [], warnings: [], errors: [] };
  git(project, ['fetch', '--quiet', 'origin', ...stack]);
  // Where every part above stands now: its lease, and the old tip its own child moves off.
  const tips = new Map(stack.map((b) => [b, git(project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).out || null]));
  const oldTip = new Map(tips);
  oldTip.set(options.from, options.fromOldTip || null);
  for (let i = from + 1; i < stack.length; i += 1) {
    const branch = stack[i];
    const parent = stack[i - 1];
    const added = worktree.add({ project, branch });
    if (!added.worktree || (added.errors && added.errors.length) || added.mainBroken) {
      if (added.mainBroken && added.worktree) worktree.remove({ project, branch });
      result.parts.push({ branch, status: 'error', errors: added.mainBroken ? added.warnings || ['the main checkout has no complete node_modules'] : added.errors || ['no worktree'] });
      result.waiting = stack.slice(i + 1);
      return result;
    }
    let landed;
    try {
      landed = landPart({
        worktree: added.worktree, branch, parent, parentTipAtStart: oldTip.get(parent) || '', remoteTipAtStart: tips.get(branch) || '',
        checksDir: options.checksDir ? path.join(options.checksDir, branch) : '', push: options.push || 'yes', gate: options.gate || 'yes',
        autoResolve: options.autoResolve || 'yes',
      });
    } catch (err) {
      landed = { status: 'error', errors: [String((err && err.message) || err)] };
    }
    const keep = landed.status !== 'landed';
    const removed = keep ? null : worktree.remove({ project, branch });
    result.parts.push({
      branch, parent, status: landed.status, commit: landed.commit || null, pushed: Boolean(landed.pushed), rebased: Boolean(landed.rebased),
      autoResolved: landed.autoResolved || [], conflictFiles: landed.conflictFiles || [], gate: landed.gate || null,
      worktree: keep || (removed && !removed.removed) ? added.worktree : null, errors: landed.errors || [],
    });
    if (keep) {
      result.waiting = stack.slice(i + 1);
      return result;
    }
  }
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = args.action === 'verify' ? verify(args)
      : args.action === 'push' ? push(args)
        : args.action === 'cascade' ? cascade(args)
          : land(args);
  } catch (err) {
    result = { status: 'error', errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, parsePairs, land, verify, push, cascade, mergeJson3, autoResolve, pushWithRetry, absent };

if (require.main === module) main();
