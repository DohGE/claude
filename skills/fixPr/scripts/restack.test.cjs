'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const restack = require('./restack.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir, file, text, message) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// origin (bare), the user's checkout, and a stack main <- part-1 <- part-2 pushed to origin.
// part-2's fixing agent held its CR commit in a worktree of its own: `tips` is where every
// branch stood when the run started.
function stack(t) {
  const base = fs.realpathSync(tempDir(t, 'fpc-restack-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  commit(work, 'base.txt', 'base\n', 'base');
  fs.writeFileSync(path.join(work, 'shared.txt'), 'one\ntwo\nthree\n');
  git(work, 'add', 'shared.txt');
  git(work, 'commit', '-q', '-m', 'shared');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'part-1');
  const a1 = commit(work, 'one.txt', 'part one\n', 'part 1');
  git(work, 'push', '-q', 'origin', 'part-1');
  git(work, 'switch', '-q', '-c', 'part-2');
  const b1 = commit(work, 'two.txt', 'part two\n', 'part 2');
  git(work, 'push', '-q', 'origin', 'part-2');
  git(work, 'switch', '-q', 'main');
  const tree = path.join(base, 'tree-part-2');
  git(work, 'worktree', 'add', '-q', tree, 'part-2');
  const b2 = commit(tree, 'two.txt', 'part two, fixed\n', 'CR');
  return { work, tree, tips: { a1, b1, b2 } };
}

const land = (s, over = {}) => restack.land({
  worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'no', push: 'yes', ...over,
});

test('land moves a held part onto its rewritten parent, replays only its own commits and pushes with a lease', (t) => {
  const s = stack(t);
  // part-1's agent rebased part-1 onto a newer main and pushed its CR commit: every sha of it changed.
  git(s.work, 'switch', '-q', 'main');
  commit(s.work, 'main.txt', 'newer main\n', 'main moved');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'rebase', '-q', 'main');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', '--force', 'origin', 'part-1');
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', true, true]);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-list', '--count', 'origin/part-1..origin/part-2'), '2', 'part 2 and its CR, nothing of the old part 1');
  assert.strictEqual(git(s.work, 'merge-base', '--is-ancestor', 'origin/part-1', 'origin/part-2') === '', true);
  assert.strictEqual(result.commit, git(s.work, 'rev-parse', 'origin/part-2'));
});

test('land pushes a held part as it is when its parent did not move', (t) => {
  const s = stack(t);
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', false, true]);
  assert.strictEqual(git(s.work, 'ls-remote', 'origin', 'refs/heads/part-2').split('\t')[0], s.tips.b2);
});

test('land carries a tracked file the install touched through the move, uncommitted', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'base.txt'), 'base, touched\n');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', true, true]);
  assert.strictEqual(fs.readFileSync(path.join(s.tree, 'base.txt'), 'utf8').replace(/\r\n/g, '\n'), 'base, touched\n', 'autocrlf may write it back with CRLF');
  assert.match(result.warnings.join(' '), /stay uncommitted/);
});

test('land stops at a conflict with the files named and the held commit untouched', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\nTWO from part 2\nthree\n');
  git(s.tree, 'commit', '-q', '-am', 'part 2 edits shared');
  const held = git(s.tree, 'rev-parse', 'HEAD');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\nTWO from part 1\nthree\n');
  git(s.work, 'commit', '-q', '-am', 'part 1 edits shared');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.strictEqual(result.status, 'conflict');
  assert.deepStrictEqual(result.conflictFiles, ['shared.txt']);
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), held);
  assert.ok(!fs.existsSync(path.join(git(s.tree, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), 'no rebase left in progress');
  assert.strictEqual(result.pushed, false);
});

test('land never overwrites a push somebody made while the run worked', (t) => {
  const s = stack(t);
  git(s.work, 'fetch', '-q', 'origin', 'part-2');
  git(s.work, 'switch', '-q', '-c', 'colleague', 'origin/part-2');
  commit(s.work, 'other.txt', 'a colleague\n', 'colleague');
  git(s.work, 'push', '-q', 'origin', 'colleague:part-2');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.strictEqual(result.status, 'push-rejected');
  assert.strictEqual(result.pushed, false);
});

test('a red gate after the move takes the part back to its held commit', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes', checksDir: path.join(s.tree, '..', 'checks') },
    { runGate: () => ({ gate: 'red', steps: [{ label: 'unit tests', status: 'failed', errorsPath: '/x/test.errors.log' }] }) },
  );
  assert.strictEqual(result.status, 'gate-red');
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), s.tips.b2);
  assert.strictEqual(result.pushed, false);
});

// 2026-11-16: the orchestrator wrote each conflict agent's PARENT_CHANGES by hand, up to 2.3k
// characters gathered from four parts below - and part-5 needed what part-1 and part-3 changed.
test('a run file gives a part the changes of every landed part below it that it still uses', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-impact-'));
  const report = (name, stackImpact) => {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(`${file}.result.json`, JSON.stringify({ type: 'result', stackImpact }));
    return file;
  };
  const run = {
    targets: [
      { branch: 'p1', reportPath: report('p1', [{ symbol: 'a', change: 'removed', usedIn: ['p3:x.ts:1', 'p2:y.ts:2'] }]), stack: { parent: null } },
      { branch: 'p2', reportPath: report('p2', [{ symbol: 'b', change: 'renamed to c', usedIn: ['p3:z.ts:3'] }]), stack: { parent: 'p1' } },
      { branch: 'p3', reportPath: path.join(dir, 'p3.md'), stack: { parent: 'p2' } },
    ],
  };
  assert.strictEqual(restack.parentChangesOf(run, 'p3'), 'a: removed (x.ts:1); b: renamed to c (z.ts:3)');
  assert.strictEqual(restack.parentChangesOf(run, 'p2'), 'a: removed (y.ts:2)');
  assert.strictEqual(restack.parentChangesOf(run, 'p1'), 'none');
});

test('a part\'s changes below name each path once, and take a use written as origin/<branch>', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-impact-'));
  const file = path.join(dir, 'p1.md');
  fs.writeFileSync(`${file}.result.json`, JSON.stringify({ stackImpact: [{ symbol: 'a', change: 'removed', usedIn: ['origin/p2:src/x.ts:1', 'p2:src/x.ts:7', 'p2:src/y.ts:2', 'p3:src/z.ts:3'] }] }));
  const run = { targets: [{ branch: 'p1', reportPath: file, stack: { parent: null } }, { branch: 'p2', reportPath: path.join(dir, 'p2.md'), stack: { parent: 'p1' } }] };
  assert.deepStrictEqual(restack.parentImpactOf(run, 'p2'), [{ symbol: 'a', change: 'removed', uses: ['src/x.ts:1', 'src/x.ts:7', 'src/y.ts:2'] }]);
  assert.strictEqual(restack.parentChangesOf(run, 'p2'), 'a: removed (src/x.ts:1, 7; src/y.ts:2)');
});

test('a conflict brief carries the mode, the changes below and the parent\'s landed diff of the conflicting files', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\nTWO from part 2\nthree\n');
  git(s.tree, 'commit', '-q', '-am', 'part 2 edits shared');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\nTWO from part 1\nthree\n');
  git(s.work, 'commit', '-q', '-am', 'part 1 edits shared');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const checksDir = path.join(s.tree, '..', 'checks-conflict');
  const result = land(s, { checksDir, parentChanges: 'x: removed (two.txt:1)' });
  assert.strictEqual(result.status, 'conflict');
  const vars = JSON.parse(fs.readFileSync(result.briefVars, 'utf8'));
  assert.strictEqual(vars.MODE, 'conflict');
  assert.strictEqual(vars.PARENT_CHANGES, 'x: removed (two.txt:1)');
  assert.match(fs.readFileSync(vars.PARENT_DIFF, 'utf8'), /\+TWO from part 1/);
});

// 2026-11-18: the whole landed parent went into every brief (10-14 KB) for a conflict in one
// import block. The cut diff holds the conflicting files and the files that change a name this
// part still uses; the full one stays a file away.
test('a conflict brief\'s diff covers the conflicting files and the names this part still uses, the full diff a file away', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\nTWO from part 2\nthree\n');
  fs.writeFileSync(path.join(s.tree, 'uses.ts'), 'export const y = oldName();\n');
  git(s.tree, 'add', 'uses.ts');
  git(s.tree, 'commit', '-q', '-am', 'part 2 edits shared and uses oldName');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\nTWO from part 1\nthree\n');
  fs.writeFileSync(path.join(s.work, 'api.ts'), 'export function newName() {}\n// was oldName\n');
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(s.work, `noise${i}.ts`), `export const noise${i} = ${'1'.repeat(400)};\n`);
  git(s.work, 'add', '-A');
  git(s.work, 'commit', '-q', '-m', 'part 1 renames oldName and adds noise');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const parentImpact = [
    { symbol: 'oldName', change: 'renamed to newName', uses: ['uses.ts:1'] },
    { symbol: 'gone', change: 'removed', uses: ['two.txt:1'] },
  ];
  const result = land(s, { checksDir: path.join(s.tree, '..', 'checks-cut'), parentImpact });
  assert.strictEqual(result.status, 'conflict');
  const vars = JSON.parse(fs.readFileSync(result.briefVars, 'utf8'));
  assert.strictEqual(vars.PARENT_CHANGES, 'oldName: renamed to newName (uses.ts:1)', 'an entry this part no longer uses is left out');
  const cut = fs.readFileSync(vars.PARENT_DIFF, 'utf8');
  assert.deepStrictEqual([...cut.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ['api.ts', 'shared.txt']);
  const full = fs.readFileSync(vars.PARENT_DIFF_FULL, 'utf8');
  assert.strictEqual([...full.matchAll(/^diff --git /gm)].length, 8);
  assert.ok(cut.length * 3 < full.length, `${cut.length} of ${full.length} bytes`);
});

// A rename below that breaks this part without a textual conflict used to end the landing as an
// error for the user; it is the conflict agent's work, in its adapting mode.
test('a red gate after a clean move writes the brief of an adapting agent, its diff cut to what the errors name', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  commit(s.work, 'other.txt', 'unrelated\n', 'CR 1b');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const errorsPath = path.join(s.tree, '..', 'typecheck.errors.log');
  fs.writeFileSync(errorsPath, `${path.join(s.tree, 'one.txt').replace(/\//g, '\\')}(1,1): error TS2304: Cannot find name 'partOne'.\n`);
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes', checksDir: path.join(s.tree, '..', 'checks-adapt'), parentChanges: 'none' },
    { runGate: () => ({ gate: 'red', steps: [{ label: 'typecheck', status: 'failed', errorsPath }] }) },
  );
  assert.strictEqual(result.status, 'gate-red');
  assert.strictEqual(result.mode, 'adapt');
  const vars = JSON.parse(fs.readFileSync(result.briefVars, 'utf8'));
  assert.deepStrictEqual([vars.MODE, vars.FILES, vars.OLD_TIP], ['adapt', 'none', s.tips.a1]);
  const cut = fs.readFileSync(vars.PARENT_DIFF, 'utf8');
  assert.match(cut, /part one, fixed/);
  assert.doesNotMatch(cut, /unrelated/);
  assert.match(fs.readFileSync(vars.PARENT_DIFF_FULL, 'utf8'), /unrelated/);
  assert.strictEqual(restack.compactPart(result).mode, 'adapt');
});

test('mergeJson3 keeps what both sides added, in place, and refuses a key both changed', () => {
  const { mergeJson3, absent } = restack;
  const base = { actions: { load: 'Load', unload: 'Unload' } };
  const ours = { actions: { load: 'Load', loadInto: 'Load into…', unload: 'Unload' } };
  const theirs = { actions: { load: 'Load', unload: 'Unload', readLabel: 'Read label' } };
  assert.deepStrictEqual(JSON.stringify(mergeJson3(base, ours, theirs)), JSON.stringify({ actions: { load: 'Load', loadInto: 'Load into…', unload: 'Unload', readLabel: 'Read label' } }));
  assert.deepStrictEqual(mergeJson3(absent, { a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepStrictEqual(mergeJson3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }), { a: 1 }, 'a key one side deleted and the other left alone goes');
  assert.throws(() => mergeJson3({ a: 1 }, { a: 2 }, { a: 3 }), /both sides changed \.a/);
});

test('land merges the conflicts of two parts that only appended - JSON keys and enum lines - and the gate proves it', (t) => {
  const s = stack(t);
  const enumOf = (...lines) => ['export enum Tip {', "  delete = 'actions.delete',", ...lines, '}', ''].join('\n');
  const jsonOf = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
  // Both files exist on main before the stack forks; part-1 and part-2 each add their own entry.
  git(s.work, 'switch', '-q', 'main');
  commit(s.work, 'tip.enum.ts', enumOf(), 'enum');
  commit(s.work, 'en.json', jsonOf({ actions: { load: 'Load' } }), 'i18n');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'merge', '-q', '--no-edit', 'main');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const forkTip = git(s.work, 'rev-parse', 'HEAD');
  git(s.tree, 'merge', '-q', '--no-edit', 'origin/part-1');
  fs.writeFileSync(path.join(s.tree, 'tip.enum.ts'), enumOf("  readLabel = 'actions.readLabel',"));
  fs.writeFileSync(path.join(s.tree, 'en.json'), jsonOf({ actions: { load: 'Load', readLabel: 'Read label' } }));
  git(s.tree, 'commit', '-q', '-am', 'part 2 adds read label');
  // part-1 lands its CR with the ellipsis action at the same spots.
  fs.writeFileSync(path.join(s.work, 'tip.enum.ts'), enumOf("  loadInto = 'actions.loadInto',"));
  fs.writeFileSync(path.join(s.work, 'en.json'), jsonOf({ actions: { load: 'Load', loadInto: 'Load into…' } }));
  git(s.work, 'commit', '-q', '-am', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  let gateRan = false;
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: forkTip, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no', checksDir: path.join(s.tree, '..', 'checks') },
    { runGate: () => { gateRan = true; return { gate: 'green', steps: [] }; } },
  );
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual(result.autoResolved.map((r) => [r.file, r.how]).sort(), [['en.json', 'json-keys'], ['tip.enum.ts', 'both-insertions']]);
  assert.ok(gateRan, 'the gate proves an automatic merge');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.tree, 'en.json'), 'utf8')), { actions: { load: 'Load', loadInto: 'Load into…', readLabel: 'Read label' } });
  assert.match(fs.readFileSync(path.join(s.tree, 'tip.enum.ts'), 'utf8').replace(/\r\n/g, '\n'), /loadInto = 'actions\.loadInto',\n {2}readLabel = 'actions\.readLabel',\n\}/);
});

test('land never merges a conflict by itself when no gate follows the move', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\ntwo\nthree\npart 2 line\n');
  git(s.tree, 'commit', '-q', '-am', 'part 2 appends');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\ntwo\nthree\npart 1 line\n');
  git(s.work, 'commit', '-q', '-am', 'part 1 appends');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s, { gate: 'no' });
  assert.strictEqual(result.status, 'conflict');
  assert.deepStrictEqual(result.autoResolved, []);
});

test('pushWithRetry tries a transient failure again and never a rejection', () => {
  const answers = [
    { ok: false, err: 'remote: fatal error in commit_refs_rules', out: '' },
    { ok: true, err: '', out: '' },
  ];
  const waits = [];
  const ok = restack.pushWithRetry('/t', ['push'], { run: () => answers.shift(), wait: (ms) => waits.push(ms) });
  assert.deepStrictEqual([ok.ok, ok.attempts, waits.length], [true, 2, 1]);
  let calls = 0;
  const rejected = restack.pushWithRetry('/t', ['push'], { run: () => { calls += 1; return { ok: false, err: ' ! [rejected] part-2 -> part-2 (stale info)', out: '' }; }, wait: () => {} });
  assert.deepStrictEqual([rejected.ok, calls], [false, 1]);
});

test('cascade moves every part above the changed one, bottom-up, and stops at the first that does not land', () => {
  const calls = [];
  const fakeWorktree = {
    add: ({ branch }) => { calls.push(['add', branch]); return { worktree: `/w/${branch}`, errors: [] }; },
    remove: ({ branch }) => { calls.push(['remove', branch]); return { removed: true }; },
  };
  const fakeLand = (o) => {
    calls.push(['land', o.branch, o.parent]);
    return o.branch === 'p4' ? { status: 'conflict', conflictFiles: ['a.ts'] } : { status: 'landed', commit: `c-${o.branch}`, pushed: true, rebased: true, autoResolved: [] };
  };
  const result = restack.cascade({ project: process.cwd(), stack: ['p1', 'p2', 'p3', 'p4', 'p5'], from: 'p1', push: 'yes', gate: 'yes' }, { worktree: fakeWorktree, land: fakeLand });
  assert.deepStrictEqual(calls, [['add', 'p2'], ['land', 'p2', 'p1'], ['remove', 'p2'], ['add', 'p3'], ['land', 'p3', 'p2'], ['remove', 'p3'], ['add', 'p4'], ['land', 'p4', 'p3']]);
  assert.deepStrictEqual(result.parts.map((p) => [p.branch, p.status]), [['p2', 'landed'], ['p3', 'landed'], ['p4', 'conflict']]);
  assert.strictEqual(result.parts[2].worktree, '/w/p4', 'a part that did not land keeps its worktree for the conflict agent');
  assert.deepStrictEqual(result.waiting, ['p5']);
  assert.throws(() => restack.parseArgs(['--action=cascade', '--project=/p', '--stack=a;b', '--from=c']), /--from naming one of them/);
});

test('verify names every part that does not sit on its parent, with the command that moves it', (t) => {
  const s = stack(t);
  git(s.tree, 'push', '-q', 'origin', 'part-2');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = restack.verify({ project: s.work, pairs: [{ parent: 'part-1', child: 'part-2', oldTip: s.tips.a1 }, { parent: 'main', child: 'part-1' }] });
  assert.deepStrictEqual(result.ok, ['main>part-1']);
  assert.strictEqual(result.broken.length, 1);
  assert.strictEqual(result.broken[0].command, `git rebase --onto origin/part-1 ${s.tips.a1} part-2`);
  assert.deepStrictEqual(restack.parsePairs('part-1>part-2@abcd, main>part-1'), [{ parent: 'part-1', child: 'part-2', oldTip: 'abcd' }, { parent: 'main', child: 'part-1', oldTip: null }]);
});

test('land pushes from a branch of the run\'s own to the pull request\'s branch', (t) => {
  const s = stack(t);
  const own = path.join(s.tree, '..', 'tree-own');
  git(s.work, 'worktree', 'add', '-q', own, '-b', 'doh-fixpr/part-1', 'origin/part-1');
  const fixed = commit(own, 'one.txt', 'part one, fixed\n', 'CR 1');
  const result = restack.land({ worktree: own, branch: 'part-1', parent: 'main', remoteTipAtStart: s.tips.a1, gate: 'no', push: 'yes' });
  assert.deepStrictEqual([result.status, result.pushed], ['landed', true]);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-parse', 'origin/part-1'), fixed);
});

test('land skips the gate when the move leaves the tree as it was', (t) => {
  const s = stack(t);
  // part-1 rewritten without a change of content: only its message.
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'commit', '-q', '--amend', '-m', 'part 1, reworded');
  git(s.work, 'push', '-q', '--force', 'origin', 'part-1');
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no' },
    { runGate: () => { throw new Error('no gate expected'); } },
  );
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.strictEqual(result.rebased, true);
  assert.strictEqual(result.gate.gate, 'skipped');
});

test('land runs the steps the fixing agent left to it, and a red one stops the push', (t) => {
  const s = stack(t);
  const asked = [];
  const green = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no', pendingSteps: ['build'] },
    { runGate: ({ only }) => { asked.push(only); return { gate: 'partial', steps: [{ label: 'build', status: 'passed' }] }; } },
  );
  assert.deepStrictEqual(asked, [['build']]);
  assert.strictEqual(green.status, 'landed');
  const red = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes', pendingSteps: ['build'] },
    { runGate: () => ({ gate: 'red', steps: [{ label: 'build', status: 'failed', errorsPath: '/x/build.errors.log' }] }) },
  );
  assert.strictEqual(red.status, 'gate-red');
  assert.strictEqual(red.pushed, false);
});

test('a run file gives land its part and verify its pairs', (t) => {
  const run = {
    project: '/p',
    targets: [
      { branch: 'p1', worktree: '/w/p1', remoteTipAtStart: 'a', checksDir: '/c/p1', stack: { parent: null, children: ['p2'], parentTipAtStart: null } },
      { branch: 'p2', worktree: '/w/p2', remoteTipAtStart: 'b', checksDir: '/c/p2', stack: { parent: 'p1', children: [], parentTipAtStart: 'a', above: ['p3', 'p4'] } },
    ],
  };
  assert.deepStrictEqual(restack.landOptionsFromRun(run, 'p2'), { worktree: '/w/p2', branch: 'p2', parent: 'p1', parentTipAtStart: 'a', remoteTipAtStart: 'b', checksDir: path.join('/c/p2', 'restack'), parentImpact: [] });
  assert.deepStrictEqual(restack.pairsFromRun(run), [
    { parent: 'p1', child: 'p2', oldTip: 'a' }, { parent: 'p2', child: 'p3', oldTip: 'b' }, { parent: 'p3', child: 'p4', oldTip: null },
  ]);
  const dir = fs.realpathSync(tempDir(t, 'fpc-run-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const args = restack.parseArgs(['--action=land', `--run=${file}`, '--branch=p2', '--worktree=/elsewhere']);
  assert.deepStrictEqual([args.worktree, args.parent, args.remoteTipAtStart], ['/elsewhere', 'p1', 'b'], 'a flag given explicitly wins');
  assert.strictEqual(restack.parseArgs(['--action=verify', `--run=${file}`]).pairs.length, 3);
});

test('stack moves the bottom onto its base, then every part onto the one below, and resumes above a conflict', (t) => {
  // The brief and the state file of a stop are written under the project: never this repository.
  const project = fs.realpathSync(tempDir(t, 'fpc-stack-'));
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: (o) => {
      calls.push([o.branch, o.parent, o.parentTipAtStart, o.remoteTipAtStart]);
      return o.branch === 'p2' ? { status: 'conflict', conflictFiles: ['a.ts'], oldParentTip: 't1' } : { status: 'landed', commit: `n-${o.branch}`, pushed: true, rebased: true };
    },
  };
  const first = restack.stackAction({ project, stack: ['p2'], push: 'yes', gate: 'yes', ontoBase: 'yes' }, deps);
  assert.deepStrictEqual(first.stack, ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(calls, [['p1', 'base', '', 't1'], ['p2', 'p1', 't1', 't2']]);
  assert.deepStrictEqual(first.parts.map((p) => [p.branch, p.status, p.oldTip]), [['p1', 'landed', 't1'], ['p2', 'conflict', 't2']]);
  assert.strictEqual(first.parts[1].worktree, '/w/p2');
  assert.deepStrictEqual(first.waiting, ['p3']);
  calls.length = 0;
  deps.land = (o) => { calls.push([o.branch, o.parent, o.parentTipAtStart]); return { status: 'landed', commit: 'x', pushed: true, rebased: true }; };
  const resumed = restack.stackAction({ project, stack: ['p1', 'p2', 'p3'], base: 'base', start: 'p3', parentOldTip: 't2', push: 'yes', gate: 'yes', ontoBase: 'yes' }, deps);
  assert.deepStrictEqual(calls, [['p3', 'p2', 't2']]);
  assert.deepStrictEqual(resumed.parts.map((p) => p.status), ['landed']);
  assert.ok(Object.keys(resumed.parts[0]).every((k) => !['steps'].includes(k)), 'compact parts');
});

test('discoverStack walks down the bases and up the open pull requests', () => {
  const prs = { p1: { base: 'master' }, p2: { base: 'p1' }, p3: { base: 'p2' } };
  const found = restack.discoverStack('/p', 'p2', {
    findPr: (b) => prs[b] || null, childrenOf: (b) => ({ p2: ['p3'] }[b] || []), mergedInto: (b) => (b === 'master' ? ['h0'] : []),
  });
  assert.deepStrictEqual([found.stack, found.base, found.mergedHeads], [['p1', 'p2', 'p3'], 'master', ['h0']]);
});

// origin, main <- part-1 (two commits on one file) <- part-2; part-1 is then squash-merged into
// main after another pull request landed there, and GitHub retargets part-2 onto main. The bottom
// of the stack still carries part-1's own commits (2026-11-10: 29 conflicts on DPXN-11967-part-2).
function squashStack(t) {
  const base = fs.realpathSync(tempDir(t, 'fpc-squash-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  commit(work, 'base.txt', 'base\n', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'part-1');
  commit(work, 'one.txt', 'one\n', 'part 1');
  const a2 = commit(work, 'one.txt', 'one, reviewed\n', 'part 1 CR');
  git(work, 'push', '-q', 'origin', 'part-1');
  git(work, 'switch', '-q', '-c', 'part-2');
  const b1 = commit(work, 'two.txt', 'two\n', 'part 2');
  git(work, 'push', '-q', 'origin', 'part-2');
  git(work, 'switch', '-q', 'main');
  commit(work, 'other.txt', 'other\n', 'another pull request');
  git(work, 'merge', '--squash', '-q', 'part-1');
  git(work, 'commit', '-q', '-m', 'part 1 (#1)');
  git(work, 'push', '-q', 'origin', 'main');
  const tree = path.join(base, 'tree-part-2');
  git(work, 'worktree', 'add', '-q', tree, 'part-2');
  return { work, tree, tips: { a2, b1 } };
}

test('land moves a part off a parent squash-merged into its base: its own commits only, no conflict', (t) => {
  const s = squashStack(t);
  const result = restack.land({ worktree: s.tree, branch: 'part-2', parent: 'main', remoteTipAtStart: s.tips.b1, gate: 'no', push: 'yes' });
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual(result.conflictFiles, []);
  assert.deepStrictEqual(result.squashed, { boundary: s.tips.a2, commits: 2, via: 'patch-id', into: git(s.work, 'rev-parse', 'main') });
  assert.strictEqual(result.oldParentTip, s.tips.a2);
  assert.match(result.warnings.join(' '), /2 commit\(s\) .* already in main/);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-list', '--count', 'origin/main..origin/part-2'), '1');
  assert.strictEqual(git(s.work, 'show', 'origin/part-2:one.txt'), 'one, reviewed');
});

test('land takes the merged pull request\'s head when the squash was changed on its way in', (t) => {
  const s = squashStack(t);
  fs.writeFileSync(path.join(s.work, 'one.txt'), 'one, reviewed at merge\n');
  git(s.work, 'commit', '-q', '-a', '--amend', '--no-edit');
  git(s.work, 'push', '-q', '--force', 'origin', 'main');
  const result = restack.land({
    worktree: s.tree, branch: 'part-2', parent: 'main', remoteTipAtStart: s.tips.b1, gate: 'no', push: 'no',
    mergedHeads: ['0123456789012345678901234567890123456789', s.tips.a2],
  });
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual([result.squashed.boundary, result.squashed.via, result.squashed.commits], [s.tips.a2, 'merged-pr', 2]);
  assert.strictEqual(git(s.tree, 'show', 'HEAD:one.txt'), 'one, reviewed at merge');
});

test('verify sends a bottom off its squash-merged parent from that parent\'s last commit', (t) => {
  const s = squashStack(t);
  const result = restack.verify({ project: s.work, pairs: [{ parent: 'main', child: 'part-2', oldTip: null }] });
  assert.strictEqual(result.broken.length, 1);
  assert.strictEqual(result.broken[0].command, `git rebase --onto origin/main ${s.tips.a2} part-2`);
  assert.match(result.warnings.join(' '), /2 commit\(s\) of part-2 .*already in main/);
});

test('stack renders the conflict agent\'s brief itself and keeps the output short', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-brief-'));
  const files = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2' },
    discover: () => ({ stack: ['p1', 'p2'], base: 'base', prs: { p1: { number: 11, url: 'u11' } }, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: () => ({ status: 'conflict', conflictFiles: files, oldParentTip: 'm-old' }),
  };
  const out = restack.stackAction({ project: dir, stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks'), language: 'Polish' }, deps);
  const part = out.parts[0];
  assert.strictEqual(part.status, 'conflict');
  assert.strictEqual(part.conflictCount, 14);
  assert.strictEqual(part.conflictFiles.length, 10, 'the list the orchestrator reads is capped');
  assert.deepStrictEqual(part.agentPromptErrors, []);
  const brief = fs.readFileSync(part.agentPrompt, 'utf8');
  for (const piece of ['`p1`', '#11', 'u11', '/w/p1', 'm-old', 't1', 'src/f13.ts', 'Polish', path.join(dir, 'checks', 'p1')]) assert.ok(brief.includes(piece), piece);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief), 'no placeholder left');
  assert.strictEqual(part.agentPrompt, path.join(dir, '.claude', 'doh', 'p1', 'p1-restack-agent-prompt.md'));
});

test('stack renders the adapting agent\'s brief for a part whose gate is red after a clean move', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-brief-adapt-'));
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2' },
    discover: () => ({ stack: ['p1', 'p2'], base: 'base', prs: { p1: { number: 11, url: 'u11' } }, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: () => ({ status: 'gate-red', mode: 'adapt', oldParentTip: 'm-old', gate: { gate: 'red', steps: [{ label: 'typecheck', status: 'failed', errorsPath: '/e' }] } }),
  };
  const out = restack.stackAction({ project: dir, stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks'), language: 'Polish' }, deps);
  const part = out.parts[0];
  assert.strictEqual(part.status, 'gate-red');
  assert.deepStrictEqual(part.agentPromptErrors, []);
  assert.ok(fs.readFileSync(part.agentPrompt, 'utf8').includes('Mode: `adapt`'));
});

test('--resume=yes takes the stopped part\'s worktree down and climbs on above it from its old tip', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-resume-'));
  const removed = [];
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: ({ branch }) => { removed.push(branch); return { removed: true, warnings: [] }; } },
    land: (o) => {
      calls.push([o.branch, o.parentTipAtStart]);
      return o.branch === 'p2' && calls.length === 2 ? { status: 'conflict', conflictFiles: ['a.ts'], oldParentTip: 't1' } : { status: 'landed', commit: `n-${o.branch}`, pushed: true, rebased: true };
    },
    sits: () => true,
  };
  const options = { project: dir, stack: ['p1', 'p2', 'p3'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks') };
  const first = restack.stackAction(options, deps);
  assert.deepStrictEqual(first.waiting, ['p3']);
  removed.length = 0;
  calls.length = 0;
  const resumed = restack.stackAction({ ...options, resume: 'yes' }, deps);
  assert.deepStrictEqual(removed, ['p2', 'p3'], 'the stopped part\'s worktree, then the landed one\'s');
  assert.deepStrictEqual(calls, [['p3', 't2']]);
  assert.strictEqual(resumed.resumedAfter, 'p2');
  assert.deepStrictEqual(resumed.parts.map((p) => p.status), ['landed']);
  const again = restack.stackAction({ ...options, resume: 'yes' }, deps);
  assert.match(again.errors.join(' '), /nothing to resume/i);
});

test('--resume=yes refuses while the stopped part does not sit on its parent', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-resume-'));
  const checksDir = path.join(dir, 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.writeFileSync(path.join(checksDir, 'restack-state.json'), JSON.stringify({ stack: ['p1', 'p2'], base: 'base', stopped: 'p1', oldTips: { p1: 't1' } }));
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2' },
    discover: () => ({ stack: ['p1', 'p2'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: () => { throw new Error('no climb expected'); }, remove: () => { throw new Error('no removal expected'); } },
    sits: () => false,
  };
  const out = restack.stackAction({ project: dir, stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir, resume: 'yes' }, deps);
  assert.match(out.errors.join(' '), /p1 does not sit on base/);
});

test('parseArgs takes --resume and --language for the stack action only', () => {
  const args = restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=yes', '--language=Polish']);
  assert.deepStrictEqual([args.resume, args.language], ['yes', 'Polish']);
  assert.throws(() => restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=yes', '--start=b']), /--resume/);
  assert.throws(() => restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=maybe']), /yes or no/);
});

test('plan names the stack, its base and every pair that is off, moving nothing', () => {
  const deps = {
    discover: () => ({ stack: ['p1', 'p2'], base: 'main', prs: { p1: { number: 1, url: 'u1' } }, warnings: [] }),
    verify: ({ pairs }) => ({ ok: [`${pairs[0].parent}>${pairs[0].child}`], broken: [{ parent: 'p1', child: 'p2', command: 'x' }], warnings: [], errors: [] }),
  };
  const out = restack.plan({ project: process.cwd(), stack: ['p2'] }, deps);
  assert.deepStrictEqual([out.stack, out.base, out.ok, out.broken.length, out.prs.p1.number], [['p1', 'p2'], 'main', ['main>p1'], 1, 1]);
});

test('plan and stack check the environment first; land and cascade do not', () => {
  assert.strictEqual(restack.parseArgs(['--action=plan', '--project=/p', '--stack=a']).preflight, 'yes');
  assert.strictEqual(restack.parseArgs(['--action=stack', '--project=/p', '--stack=a', '--preflight=no']).preflight, 'no');
  assert.strictEqual(restack.parseArgs(['--action=cascade', '--project=/p', '--stack=a;b', '--from=a']).preflight, 'no');
  assert.throws(() => restack.parseArgs(['--action=plan', '--project=/p', '--stack=a', '--preflight=later']), /yes or no/);
});

test('plan carries the preflight, and its errors, beside the pairs', () => {
  const asked = [];
  const deps = {
    discover: () => ({ stack: ['p1', 'p2'], base: 'main', prs: {}, warnings: [] }),
    verify: () => ({ ok: ['main>p1', 'p1>p2'], broken: [], warnings: [], errors: [] }),
    preflight: (project, options) => {
      asked.push(options);
      return { ok: false, checks: { identity: { ok: false } }, errors: ['preflight identity: git has no user.email - fix'], warnings: [] };
    },
  };
  const out = restack.plan({ project: process.cwd(), stack: ['p2'], push: 'no', gate: 'yes', preflight: 'yes' }, deps);
  assert.deepStrictEqual(asked, [{ push: false, commit: true, resolve: false, gate: true }]);
  assert.strictEqual(out.preflight.ok, false);
  assert.deepStrictEqual(out.errors, ['preflight identity: git has no user.email - fix']);
  assert.deepStrictEqual(out.ok, ['main>p1', 'p1>p2'], 'the plan itself is still answered');
});

test('stack refuses to climb when the preflight fails', () => {
  // 2026-11-18: a missing git identity surfaced as a "conflict" with no conflicting file, after
  // the first parts had already moved.
  const deps = {
    discover: () => { throw new Error('nothing is read from GitHub after a failed preflight'); },
    worktree: { add: () => { throw new Error('no climb expected'); } },
    preflight: () => ({ ok: false, checks: {}, errors: ['preflight origin: E - F'], warnings: [] }),
  };
  const out = restack.stackAction({ project: process.cwd(), stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', preflight: 'yes' }, deps);
  assert.deepStrictEqual(out.errors, ['preflight origin: E - F']);
  assert.deepStrictEqual(out.parts, []);
  assert.strictEqual(out.preflight.ok, false);
});

// --- no-op moves and old tips -----------------------------------------------------------------

// 2026-11-18: a cascade given a wrong old tip answered `landed`, `gate: skipped`, with the part's
// commit unchanged - read as a move that happened.
test('land reports a part that already sits on its parent and on origin as a no-op, not as landed', (t) => {
  const s = stack(t);
  git(s.tree, 'reset', '-q', '--hard', s.tips.b1);
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes' },
    { runGate: () => { throw new Error('no gate expected'); } },
  );
  assert.deepStrictEqual([result.status, result.rebased, result.pushed, result.commit, result.gate], ['noop', false, false, s.tips.b1, null]);
  assert.match(result.reason, /already sits on origin\/part-1/);
  assert.strictEqual(restack.compactPart(result).status, 'noop');
});

test('land refuses an old parent tip the part was not built on, and one that is no commit', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'main');
  const elsewhere = commit(s.work, 'main.txt', 'newer main\n', 'main moved');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const wrong = land(s, { parentTipAtStart: elsewhere });
  assert.strictEqual(wrong.status, 'error');
  assert.match(wrong.errors[0], /is not an ancestor of part-2/);
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), s.tips.b2, 'nothing moved');
  const bogus = land(s, { parentTipAtStart: 'deadbeefdeadbeef' });
  assert.strictEqual(bogus.status, 'error');
  assert.match(bogus.errors[0], /is no commit of this repository/);
});

test('cascade and stack --start refuse an old tip the first part does not sit on, before any worktree', (t) => {
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    isAncestor: (sha, branch) => !(sha === 'wrong' && ['p2', 'p3'].includes(branch)),
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: ({ branch }) => { calls.push(branch); return { worktree: `/w/${branch}`, errors: [] }; }, remove: () => ({ removed: true }) },
    land: () => { throw new Error('no landing expected'); },
  };
  const out = restack.cascade({ project: process.cwd(), stack: ['p1', 'p2', 'p3'], from: 'p1', fromOldTip: 'wrong' }, deps);
  assert.match(out.errors.join(' '), /wrong is not an ancestor of p2/);
  assert.deepStrictEqual([out.parts, out.waiting, calls], [[], ['p2', 'p3'], []]);
  const project = fs.realpathSync(tempDir(t, 'fpc-start-'));
  const started = restack.stackAction({ project, stack: ['p1', 'p2', 'p3'], base: 'base', start: 'p3', parentOldTip: 'wrong', push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(project, 'checks') }, deps);
  assert.match(started.errors.join(' '), /wrong is not an ancestor of p3/);
  assert.deepStrictEqual(calls, []);
});

test('a climb takes a no-op part\'s worktree down and goes on, and a part off its parent moves off what it shares with it', () => {
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    // p3 was built on an older p2 than t2: land would refuse t2.
    isAncestor: (sha, branch) => !(sha === 't2' && branch === 'p3'),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: ({ branch }) => { calls.push(['remove', branch]); return { removed: true, warnings: [] }; } },
    land: (o) => { calls.push(['land', o.branch, o.parentTipAtStart]); return o.branch === 'p2' ? { status: 'noop', commit: 't2', reason: 'nothing to move' } : { status: 'landed', commit: `n-${o.branch}`, pushed: true, rebased: true }; },
  };
  const out = restack.cascade({ project: process.cwd(), stack: ['p1', 'p2', 'p3'], from: 'p1' }, deps);
  assert.deepStrictEqual(calls, [['land', 'p2', 't1'], ['remove', 'p2'], ['land', 'p3', ''], ['remove', 'p3']]);
  assert.deepStrictEqual(out.parts.map((p) => [p.branch, p.status, p.worktree]), [['p2', 'noop', null], ['p3', 'landed', null]]);
  assert.match(out.warnings.join(' '), /p3 did not sit on p2 at t2/);
});

test('stack records no stop at a no-op part', (t) => {
  const project = fs.realpathSync(tempDir(t, 'fpc-noop-'));
  const deps = {
    tips: { base: 'm0', p1: 't1' },
    discover: () => ({ stack: ['p1'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: () => ({ status: 'noop', commit: 't1', reason: 'nothing to move' }),
  };
  const checksDir = path.join(project, 'checks');
  const out = restack.stackAction({ project, stack: ['p1'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir }, deps);
  assert.deepStrictEqual(out.parts.map((p) => [p.status, p.reason, p.worktree]), [['noop', 'nothing to move', null]]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(checksDir, 'restack-state.json'), 'utf8')).stopped, null);
});

// --- a missing git identity -------------------------------------------------------------------

// 2026-11-18: user.name and user.email were gone; land said `conflict` with no file, and a landing
// agent spent 4 minutes finding "Committer identity unknown".
test('land without a git identity is an error that names user.name and user.email, never a conflict', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const emptyGlobal = path.join(s.tree, '..', 'empty.gitconfig');
  fs.writeFileSync(emptyGlobal, '');
  const names = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  for (const k of names.slice(2)) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1' });
  git(s.work, 'config', '--unset', 'user.name');
  git(s.work, 'config', '--unset', 'user.email');
  // No guess from the host name either: git refuses as it does on a machine without a domain.
  git(s.work, 'config', 'user.useConfigOnly', 'true');
  const result = land(s, { gate: 'yes', checksDir: path.join(s.tree, '..', 'checks-id') });
  assert.strictEqual(result.status, 'error', JSON.stringify(result));
  assert.match(result.errors[0], /No git identity: user\.name and user\.email are not set/);
  assert.deepStrictEqual(result.conflictFiles, []);
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), s.tips.b2);
  assert.match(restack.checkIdentity(s.tree), /git config --global user\.email/);
});

test('git\'s identity complaints are told from a conflict', () => {
  for (const text of ['Committer identity unknown\n\n*** Please tell me who you are.', "fatal: unable to auto-detect email address (got 'u@host.(none)')", 'fatal: no email was given and auto-detection is disabled']) {
    assert.ok(restack.identityProblem.test(text), text);
  }
  assert.ok(!restack.identityProblem.test('CONFLICT (content): Merge conflict in a.ts'));
});

test('a climb without a git identity stops before its first worktree', () => {
  const calls = [];
  const out = restack.cascade({ project: process.cwd(), stack: ['p1', 'p2'], from: 'p1' }, {
    identity: () => 'No git identity: user.email is not set',
    worktree: { add: ({ branch }) => { calls.push(branch); return { worktree: `/w/${branch}`, errors: [] }; }, remove: () => ({ removed: true }) },
    land: () => { throw new Error('no landing expected'); },
  });
  assert.deepStrictEqual([out.errors, out.waiting, calls], [['No git identity: user.email is not set'], ['p2'], []]);
});

// --- import blocks --------------------------------------------------------------------------

// mergeImports(ours, base, theirs): in a rebase "ours" is the landed parent, "theirs" the part's commit.
const js = (...lines) => `${lines.join('\n')}\n`;

test('mergeImports: the parent removes names and the part adds others to one multi-line import', () => {
  const base = js("import { Injectable } from '@angular/core';", 'import {', '  Alpha,', '  Beta,', '  Gamma,', "} from '../types';", '', 'export const x = 1;');
  const ours = base.replace('  Beta,\n', '');
  const theirs = base.replace('  Gamma,\n', '  Gamma,\n  Delta,\n').replace('x = 1', 'x = 2');
  assert.strictEqual(restack.mergeImports(ours, base, theirs), js("import { Injectable } from '@angular/core';", 'import {', '  Alpha,', '  Gamma,', '  Delta,', "} from '../types';", '', 'export const x = 2;'));
  // Both drop and add in the same spot: the base's names, minus both removals, plus both additions.
  const ours2 = base.replace('  Beta,\n  Gamma,\n', '  Epsilon,\n');
  const theirs2 = base.replace('  Gamma,\n', '  Zeta,\n');
  assert.strictEqual(restack.mergeImports(ours2, base, theirs2), js("import { Injectable } from '@angular/core';", 'import {', '  Alpha,', '  Epsilon,', '  Zeta,', "} from '../types';", '', 'export const x = 1;'));
});

test('mergeImports: a name or a module both sides add is imported once', () => {
  const base = js("import React, { useState } from 'react';", "import { A } from 'm';", '', 'A();');
  const ours = js("import React, { useState, useEffect } from 'react';", "import { A, B, C } from 'm';", "import { X } from 'x';", '', 'A();');
  const theirs = js("import React, { useState, useMemo } from 'react';", "import { A, B, D } from 'm';", "import { X, Y } from 'x';", '', 'A();');
  assert.strictEqual(restack.mergeImports(ours, base, theirs), js("import React, { useState, useEffect, useMemo } from 'react';", "import { A, B, C, D } from 'm';", "import { X, Y } from 'x';", '', 'A();'));
});

test('mergeImports: a module one side removed goes, unless the other side added a name to it', () => {
  const base = js("import { Old } from './old';", "import { Keep } from './keep';", '', 'Keep();');
  const ours = js("import { Keep } from './keep';", '', 'Keep();');
  assert.strictEqual(restack.mergeImports(ours, base, js("import { Old } from './old';", "import { Keep, Extra } from './keep';", '', 'Keep();')), js("import { Keep, Extra } from './keep';", '', 'Keep();'));
  assert.strictEqual(restack.mergeImports(ours, base, js("import { Old, More } from './old';", "import { Keep } from './keep';", '', 'Keep();')), js("import { More } from './old';", "import { Keep } from './keep';", '', 'Keep();'));
});

test('mergeImports keeps each side\'s formatting: indent, trailing comma, braces, quotes, semicolons, CRLF', () => {
  const base = ['import {', '    a,', '    b', '} from "./four"', 'import {c,d} from "./tight"', '', 'run()', ''].join('\r\n');
  const ours = base.replace('    a,\r\n', '').replace('{c,d}', '{c}');
  const theirs = base.replace('    b\r\n', '    b,\r\n    e\r\n').replace('{c,d}', '{c,d,f}');
  assert.strictEqual(restack.mergeImports(ours, base, theirs), ['import {', '    b,', '    e', '} from "./four"', 'import {c, f} from "./tight"', '', 'run()', ''].join('\r\n'));
});

test('mergeImports keeps type modifiers and aliases, and `import type` apart from the values of one module', () => {
  const base = js("import type { A, B } from './types';", "import { c, d as e } from './types';", '', 'e(c);');
  const ours = js("import type { A } from './types';", "import { c, d as e, type F } from './types';", '', 'e(c);');
  const theirs = js("import type { A, B, G } from './types';", "import { c as cc, d as e } from './types';", '', 'e(c);');
  assert.strictEqual(restack.mergeImports(ours, base, theirs), js("import type { A, G } from './types';", "import { c as cc, d as e, type F } from './types';", '', 'e(c);'));
});

test('mergeImports: side-effect imports are kept or dropped whole, in place', () => {
  const base = js("import 'zone.js';", "import './polyfills';", "import { A } from 'a';", '', 'A();');
  const ours = js("import 'zone.js';", "import { A } from 'a';", '', 'A();');
  const theirs = js("import 'zone.js';", "import './styles';", "import './polyfills';", "import { A, B } from 'a';", '', 'A();');
  assert.strictEqual(restack.mergeImports(ours, base, theirs), js("import 'zone.js';", "import './styles';", "import { A, B } from 'a';", '', 'A();'));
});

test('mergeImports leaves anything but imports to the agent', () => {
  // A conflict that holds a line of code next to the import.
  const base = js("import { A } from 'a';", 'const x = 1;');
  assert.strictEqual(restack.mergeImports(js("import { A, B } from 'a';", 'const x = 2;'), base, js("import { A, C } from 'a';", 'const x = 3;')), null);
  // One binding both sides changed differently.
  const b2 = js("import { A } from 'a';", '', 'A;');
  assert.strictEqual(restack.mergeImports(js("import { type A } from 'a';", '', 'A;'), b2, js("import { B as A } from 'a';", '', 'A;')), null);
  // A statement this does not read.
  assert.strictEqual(restack.mergeImports(js("import x = require('y');", "import { A, B } from 'a';"), js("import x = require('y');", "import { A } from 'a';"), js("import x = require('y');", "import { A, C } from 'a';")), null);
  // A comment in the block the part changed.
  assert.strictEqual(restack.mergeImports(js("import { A, B } from 'a';", '// one', "import { Z } from 'z';"), js("import { A } from 'a';", '// one', "import { Z } from 'z';"), js("import { A, C } from 'a';", '// two', "import { Z } from 'z';")), null);
});

test('land merges a conflict of two parts that only changed one import block, and the gate proves it', (t) => {
  const s = stack(t);
  const storeOf = (...names) => js("import { Injectable } from '@angular/core';", 'import {', ...names.map((n) => `  ${n},`), "} from './models';", '', 'export class Store {}');
  git(s.work, 'switch', '-q', 'main');
  commit(s.work, 'store.ts', storeOf('Alpha', 'Beta', 'Gamma'), 'store');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'merge', '-q', '--no-edit', 'main');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const forkTip = git(s.work, 'rev-parse', 'HEAD');
  git(s.tree, 'merge', '-q', '--no-edit', 'origin/part-1');
  fs.writeFileSync(path.join(s.tree, 'store.ts'), storeOf('Alpha', 'Beta', 'Gamma', 'Delta'));
  git(s.tree, 'commit', '-q', '-am', 'part 2 imports Delta');
  fs.writeFileSync(path.join(s.work, 'store.ts'), storeOf('Alpha', 'Beta'));
  git(s.work, 'commit', '-q', '-am', 'CR 1 drops Gamma');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  let gateRan = false;
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: forkTip, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no', checksDir: path.join(s.tree, '..', 'checks') },
    { runGate: () => { gateRan = true; return { gate: 'green', steps: [] }; } },
  );
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual(result.autoResolved.map((r) => [r.file, r.how]), [['store.ts', 'imports']]);
  assert.ok(gateRan, 'the gate proves an automatic merge');
  assert.strictEqual(fs.readFileSync(path.join(s.tree, 'store.ts'), 'utf8').replace(/\r\n/g, '\n'), storeOf('Alpha', 'Beta', 'Delta'));
});

// 2026-11-19: the main checkout's node_modules was gone by the end of a climb, and no step said
// when. Every part above would install instead of linking, so the climb stops, loudly, resumable.
test('a climb stops at the part whose remove lost the main checkout\'s node_modules, and --resume goes on above it', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-lost-modules-'));
  const lost = 'The main checkout\'s node_modules disappeared while removing /w/p1; run `npm ci` there (/p) before the next run.';
  const landed = [];
  let losing = true;
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', prs: {}, warnings: [] }),
    sits: () => true,
    worktree: {
      add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }),
      remove: ({ branch }) => {
        if (branch !== 'p1' || !losing) return { removed: true, warnings: [] };
        losing = false;
        return { removed: true, mainModulesLost: true, errors: [lost], warnings: [] };
      },
    },
    land: ({ branch }) => { landed.push(branch); return { status: 'landed', commit: `n-${branch}`, pushed: true }; },
  };
  const options = { project: dir, stack: ['p1', 'p2', 'p3'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks') };
  const out = restack.stackAction(options, deps);
  assert.deepStrictEqual(landed, ['p1']);
  assert.deepStrictEqual(out.errors, [lost]);
  assert.deepStrictEqual(out.waiting, ['p2', 'p3']);
  assert.deepStrictEqual(out.parts[0].errors, [lost]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'checks', 'restack-state.json'), 'utf8')).stopped, 'p1');
  const resumed = restack.stackAction({ ...options, resume: 'yes' }, deps);
  assert.deepStrictEqual(landed, ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(resumed.errors, []);
});

// --- Resuming a run whose orchestrator died (fixpr-resume.cjs) --------------------------------

// The bottom of a stack (`keep-base`) whose commit a stopped run never pushed: 2026-11-18's hand
// push skipped the check that it still merges into its base.
test('land --keep-base leaves a bottom that still merges on its base, and moves one that does not', (t) => {
  const s = stack(t);
  const tree1 = path.join(path.dirname(s.tree), 'tree-part-1');
  git(s.work, 'worktree', 'add', '-q', tree1, 'part-1');
  const cr = commit(tree1, 'one.txt', 'part one, fixed\n', 'CR 1');
  commit(s.work, 'main.txt', 'newer main\n', 'main moved');
  git(s.work, 'push', '-q', 'origin', 'main');
  const kept = restack.land({ worktree: tree1, branch: 'part-1', parent: 'main', remoteTipAtStart: s.tips.a1, gate: 'no', push: 'yes', keepBase: 'yes' });
  assert.deepStrictEqual([kept.status, kept.keptBase, kept.rebased, kept.pushed, kept.lease], ['landed', true, false, true, null]);
  assert.strictEqual(git(s.work, 'ls-remote', 'origin', 'refs/heads/part-1').split('\t')[0], cr);

  // main now changes the line part-1's next commit changes: it no longer merges, so it moves.
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\nTWO from main\nthree\n');
  git(s.work, 'commit', '-q', '-am', 'main edits shared');
  git(s.work, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(tree1, 'shared.txt'), 'one\nTWO from part 1\nthree\n');
  git(tree1, 'commit', '-q', '-am', 'CR 1b');
  const moved = restack.land({ worktree: tree1, branch: 'part-1', parent: 'main', remoteTipAtStart: cr, gate: 'no', push: 'yes', keepBase: 'yes', autoResolve: 'no' });
  assert.strictEqual(moved.keptBase, undefined);
  assert.strictEqual(moved.status, 'conflict');
});

test('land pushes with the lease a part an earlier landing moved but never pushed', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const first = land(s, { push: 'no' });
  assert.deepStrictEqual([first.status, first.rebased], ['landed', true]);
  // The run stopped here. The landing again moves nothing, and its plain push would be refused.
  const again = land(s);
  assert.deepStrictEqual([again.status, again.rebased, again.pushed, again.lease], ['landed', false, true, s.tips.b1]);
  assert.strictEqual(git(s.work, 'ls-remote', 'origin', 'refs/heads/part-2').split('\t')[0], first.commit);
});

test('push --run pushes a commit whose worktree is gone from the project, and keeps the answer in the run file', (t) => {
  const s = stack(t);
  git(s.work, 'worktree', 'remove', s.tree);
  const dir = fs.realpathSync(tempDir(t, 'fpc-run-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({ project: s.work, targets: [{ branch: 'part-2', worktree: s.tree, remoteTipAtStart: s.tips.b1, stack: { parent: 'part-1' } }] }));
  const res = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'restack.cjs'), '--action=push', `--run=${file}`, '--branch=part-2', `--commit=${s.tips.b2}`], { encoding: 'utf8' });
  const out = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  assert.deepStrictEqual([out.pushed, out.commit, out.errors], [true, s.tips.b2, []]);
  assert.strictEqual(git(s.work, 'ls-remote', 'origin', 'refs/heads/part-2').split('\t')[0], s.tips.b2);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).targets[0].pushResult;
  assert.deepStrictEqual([kept.pushed, kept.commit, kept.lease], [true, s.tips.b2, null]);
  assert.throws(() => restack.parseArgs(['--action=push', '--worktree=/w', '--branch=b', '--commit=not-a-sha']), /not a commit sha/);
});
