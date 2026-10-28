'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { splitFixups, stageAll } = require('./split-fixups.cjs');

const run = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A base commit on main, then two parts committed the way step 4 commits them, on stacked branches.
function splitRepo(t, part2A) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(root, ['init', '-q', '-b', 'main']);
  run(root, ['config', 'user.email', 'test@test.local']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  run(root, ['config', 'core.autocrlf', 'false']);
  const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
  write('shared.txt', 'base 1\nbase 2\n');
  run(root, ['add', '-A']);
  run(root, ['commit', '-q', '-m', 'init']);
  run(root, ['checkout', '-q', '-b', 'feature/x-part-1']);
  write('a.txt', 'a1\na2\na3\n');
  write('shared.txt', 'base 1\nbase 2\npart 1\n');
  run(root, ['add', '-A']);
  run(root, ['commit', '-q', '-m', 'feat: x (part 1/2)']);
  run(root, ['checkout', '-q', '-b', 'feature/x-part-2']);
  write('b.txt', 'b1\nb2\n');
  if (part2A) write('a.txt', part2A);
  write('shared.txt', 'base 1\nbase 2\npart 1\npart 2\n');
  run(root, ['add', '-A']);
  run(root, ['commit', '-q', '-m', 'feat: x (part 2/2)']);
  return { root, write };
}

const show = (root, ref, file) => run(root, ['show', `${ref}:${file}`]);
const opts = root => ({ root, base: 'main', branch: 'feature/x', parts: 2 });

test('each staged fix lands in the part whose lines it touches, and every part branch follows', (t) => {
  const { root, write } = splitRepo(t);
  write('a.txt', 'a1\nA2 fixed\na3\n');                       // part 1's line
  write('b.txt', 'B1 fixed\nb2\n');                           // part 2's line
  write('shared.txt', 'base 1\nbase 2\npart 1 fixed\npart 2 fixed\n');  // one line of each
  write('c.txt', 'new\n');                                    // a file no part had: the last part
  run(root, ['add', '-A']);
  const out = splitFixups(opts(root));
  assert.match(out, /^FIXUPS_APPLIED /);
  assert.deepStrictEqual(JSON.parse(out.slice('FIXUPS_APPLIED '.length)), { 1: 2, 2: 3 });
  assert.strictEqual(run(root, ['status', '--porcelain']), '', 'nothing left staged');
  assert.deepStrictEqual(run(root, ['log', '--format=%s', 'main..HEAD']).trim().split('\n'),
    ['feat: x (part 2/2)', 'feat: x (part 1/2)'], 'the fixes are squashed into the parts');
  assert.strictEqual(show(root, 'feature/x-part-1', 'a.txt'), 'a1\nA2 fixed\na3\n');
  assert.strictEqual(show(root, 'feature/x-part-1', 'shared.txt'), 'base 1\nbase 2\npart 1 fixed\n');
  assert.throws(() => show(root, 'feature/x-part-1', 'c.txt'));
  assert.strictEqual(show(root, 'feature/x-part-2', 'b.txt'), 'B1 fixed\nb2\n');
  assert.strictEqual(show(root, 'feature/x-part-2', 'shared.txt'), 'base 1\nbase 2\npart 1 fixed\npart 2 fixed\n');
  assert.strictEqual(show(root, 'feature/x-part-2', 'c.txt'), 'new\n');
  assert.strictEqual(run(root, ['rev-parse', 'feature/x-part-1']).trim(),
    run(root, ['rev-parse', 'feature/x-part-2^']).trim(), 'part 2 still starts from part 1');
});

test('an inserted line belongs to the part of the line above it', (t) => {
  const { root, write } = splitRepo(t);
  write('a.txt', 'a1\na2\ninserted\na3\n');
  run(root, ['add', '-A']);
  assert.strictEqual(splitFixups(opts(root)), 'FIXUPS_APPLIED {"1":1}');
  assert.strictEqual(show(root, 'feature/x-part-1', 'a.txt'), 'a1\na2\ninserted\na3\n');
});

test('nothing staged changes nothing', (t) => {
  const { root } = splitRepo(t);
  const head = run(root, ['rev-parse', 'HEAD']);
  assert.strictEqual(splitFixups(opts(root)), 'NOTHING_STAGED');
  assert.strictEqual(run(root, ['rev-parse', 'HEAD']), head);
});

test('a missing part commit keeps the fixes staged and says why', (t) => {
  const { root, write } = splitRepo(t);
  write('a.txt', 'a1\nA2\na3\n');
  run(root, ['add', '-A']);
  const head = run(root, ['rev-parse', 'HEAD']);
  assert.match(splitFixups({ ...opts(root), parts: 3 }), /^FIXUPS_KEPT no branch feature\/x-part-3/);
  assert.strictEqual(run(root, ['rev-parse', 'HEAD']), head);
  assert.strictEqual(run(root, ['diff', '--cached', '--name-only']).trim(), 'a.txt');
});

test('a fix finds its line in an earlier part even when a later part moved it', (t) => {
  const { root, write } = splitRepo(t, 'top 1\ntop 2\na1\na2\na3\n');
  write('a.txt', 'top 1\ntop 2 fixed\na1\nA2 fixed\na3\n');
  run(root, ['add', '-A']);
  assert.strictEqual(splitFixups(opts(root)), 'FIXUPS_APPLIED {"1":1,"2":1}');
  assert.strictEqual(show(root, 'feature/x-part-1', 'a.txt'), 'a1\nA2 fixed\na3\n');
  assert.strictEqual(show(root, 'feature/x-part-2', 'a.txt'), 'top 1\ntop 2 fixed\na1\nA2 fixed\na3\n');
});

test('stage-all hands a staged review the whole feature, and the split puts its fixes back in the parts', (t) => {
  const { root, write } = splitRepo(t);
  assert.strictEqual(stageAll(opts(root)), 'STAGED_ALL 3');
  assert.deepStrictEqual(run(root, ['diff', '--cached', '--name-only']).trim().split('\n'),
    ['a.txt', 'b.txt', 'shared.txt'], 'what `doh:codeReview staged` sees');
  assert.strictEqual(run(root, ['rev-parse', 'feature/x-part-2^']).trim(),
    run(root, ['rev-parse', 'feature/x-part-1']).trim(), 'no branch moved');
  assert.strictEqual(stageAll(opts(root)), 'STAGED_ALL 3', 'a second call changes nothing');
  write('a.txt', 'a1\nA2 fixed\na3\n');
  write('b.txt', 'b1\nB2 fixed\n');
  assert.strictEqual(splitFixups(opts(root)), 'FIXUPS_APPLIED {"1":1,"2":1}');
  assert.strictEqual(run(root, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/feature/x-part-2');
  assert.strictEqual(run(root, ['status', '--porcelain']), '');
  assert.deepStrictEqual(run(root, ['log', '--format=%s', 'main..HEAD']).trim().split('\n'),
    ['feat: x (part 2/2)', 'feat: x (part 1/2)'], 'amended, no commit of its own');
  assert.strictEqual(show(root, 'feature/x-part-1', 'a.txt'), 'a1\nA2 fixed\na3\n');
  assert.throws(() => show(root, 'feature/x-part-1', 'b.txt'), 'part 2s file stays out of part 1');
  assert.strictEqual(show(root, 'feature/x-part-2', 'b.txt'), 'b1\nB2 fixed\n');
});

test('a review that fixes nothing leaves the parts as they were', (t) => {
  const { root } = splitRepo(t);
  const tip = run(root, ['rev-parse', 'feature/x-part-2']);
  stageAll(opts(root));
  assert.strictEqual(splitFixups(opts(root)), 'NOTHING_STAGED');
  assert.strictEqual(run(root, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/feature/x-part-2');
  assert.strictEqual(run(root, ['rev-parse', 'HEAD']), tip);
});
