'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const checks = require('./checks.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

// A project is just a package.json and a lockfile: nothing here ever installs
// or spawns a package manager. The subprocess seam below is what the command
// construction is proved against, so the suite stays offline and fast.
function makeProject(t, scripts, lockfile = 'package-lock.json') {
  const dir = fs.realpathSync(tempDir(t, 'fpc-checks-'));
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`);
  if (lockfile) fs.writeFileSync(path.join(dir, lockfile), '{}\n');
  return dir;
}

function outDirFor(t) {
  return path.join(fs.realpathSync(tempDir(t, 'fpc-logs-')), 'checks');
}

// Records every spawn and answers from a table keyed by step name. Anything the
// table does not mention passes with empty output.
function fakeRunner(byStep = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const step = options.step;
    const answer = byStep[step] || {};
    return {
      exitCode: answer.exitCode === undefined ? 0 : answer.exitCode,
      timedOut: Boolean(answer.timedOut),
      output: answer.output === undefined ? '' : answer.output,
    };
  };
  run.calls = calls;
  return run;
}

function stepNamed(result, step) {
  return result.steps.find((s) => s.step === step);
}

test('parseArgs takes the paths it needs and refuses anything it does not know', () => {
  const args = checks.parseArgs(['--root=/w/t', '--out-dir=/w/logs']);
  assert.strictEqual(args.root, '/w/t');
  assert.strictEqual(args.outDir, '/w/logs');
  assert.deepStrictEqual(args.only, []);
  assert.deepStrictEqual(checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=lint,build']).only, ['lint', 'build']);
  assert.strictEqual(checks.parseArgs(['--root=/a', '--out-dir=/b', '--timeout-ms=5000']).timeoutMs, 5000);
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--wach=false']), /Unknown argument/);
  assert.throws(() => checks.parseArgs(['--out-dir=/b']), /No root given/);
  assert.throws(() => checks.parseArgs(['--root=/a']), /No output directory given/);
  // An --only naming a step that does not exist is a typo that would otherwise
  // report a silently green gate, because nothing at all would run.
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=lnt']), /Unknown step/);
});

test('the gate runs lint, typecheck, test and build, in that order', (t) => {
  const root = makeProject(t, {
    build: 'tsc -b', test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit',
  });
  const run = fakeRunner();
  const result = checks.runChecks({ root, outDir: outDirFor(t), run });
  assert.deepStrictEqual(result.steps.map((s) => s.step), ['lint', 'typecheck', 'test', 'build']);
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint', 'typecheck', 'test', 'build']);
});

test('the labels are the fixed identifiers the commit message is built from', (t) => {
  const root = makeProject(t, { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'jest', build: 'vite build' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  assert.deepStrictEqual(result.steps.map((s) => s.label), ['lint', 'typecheck', 'unit tests', 'build']);
});

test('typecheck falls back to the type-check spelling', (t) => {
  const root = makeProject(t, { 'type-check': 'tsc --noEmit' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  const typecheck = stepNamed(result, 'typecheck');
  assert.strictEqual(typecheck.script, 'tsc --noEmit');
  assert.strictEqual(typecheck.status, 'passed');
  assert.match(typecheck.command, /type-check/);
});

test('a script the project does not have is skipped, never failed', (t) => {
  const root = makeProject(t, { lint: 'eslint .' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  assert.strictEqual(stepNamed(result, 'lint').status, 'passed');
  for (const step of ['typecheck', 'test', 'build']) {
    assert.strictEqual(stepNamed(result, step).status, 'skipped', step);
    assert.match(stepNamed(result, step).reason, /has no .* script/);
  }
  assert.strictEqual(result.gate, 'green');
});

test('a project with no package.json skips the whole gate rather than failing it', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-bare-'));
  const run = fakeRunner();
  const result = checks.runChecks({ root: dir, outDir: outDirFor(t), run });
  assert.strictEqual(result.gate, 'skipped');
  assert.ok(result.steps.every((s) => s.status === 'skipped'));
  assert.strictEqual(run.calls.length, 0);
  assert.ok(result.warnings.some((w) => /no package\.json/i.test(w)), result.warnings.join(' | '));
});

test('a shell run still delivers every argument to the child', () => {
  // The gate spawns through a shell on Windows because npm, pnpm and yarn are .cmd
  // shims. With a shell the command LINE is what gets parsed, so the args travel joined
  // into it rather than as a separate array - Node deprecates the two together
  // (DEP0190). What must not change is that the child still receives them: a dropped
  // `--run` leaves a test runner watching, which is a hang, not a pass.
  const opts = { cwd: process.cwd(), env: process.env, timeoutMs: 30000 };
  const bare = checks.defaultRun('node', ['--version'], { ...opts, shell: false });
  assert.strictEqual(bare.exitCode, 0, bare.output);
  assert.match(bare.output.trim(), /^v\d+\./, 'without a shell the args array is spawned');

  const shelled = checks.defaultRun('node', ['--version'], { ...opts, shell: true });
  assert.strictEqual(shelled.exitCode, 0, shelled.output);
  assert.match(shelled.output.trim(), /^v\d+\./, 'with a shell the finished line is');

  // Two arguments, the second only reachable if the first was passed through.
  const flagged = checks.defaultRun('node', ['-p', '6*7'], { ...opts, shell: true });
  assert.strictEqual(flagged.exitCode, 0, flagged.output);
  assert.match(flagged.output, /42/, 'the flag and its value both reached the child');
});

test('a --only pass answers partial, never green - it never looked at the rest', (t) => {
  // The scenario the fixing agent is actually in: the full gate came back red on two
  // steps, it repaired one, and it re-runs just that one. Reporting green there sends it
  // straight to commit-and-push by its own decision table, with the unit suite still red.
  const scripts = { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest', build: 'ng build' };
  const root = makeProject(t, scripts);
  const outDir = outDirFor(t);
  const red = checks.runChecks({ root, outDir, run: fakeRunner({ test: { exitCode: 1, output: '2 failing' }, build: { exitCode: 2, output: 'broke' } }) });
  assert.strictEqual(red.gate, 'red');

  const repaired = checks.runChecks({ root, outDir, only: ['build'], run: fakeRunner() });
  assert.strictEqual(repaired.gate, 'partial', 'nothing failed HERE is not the whole gate');
  assert.strictEqual(stepNamed(repaired, 'build').status, 'passed');
  assert.strictEqual(stepNamed(repaired, 'test').status, 'skipped');
  assert.strictEqual(checks.exitCodeFor(repaired), 0, 'nothing failed and the script ran, so it exits 0');

  // A --only pass whose step FAILS is still red: red outranks everything.
  const stillRed = checks.runChecks({ root, outDir, only: ['build'], run: fakeRunner({ build: { exitCode: 1, output: 'nope' } }) });
  assert.strictEqual(stillRed.gate, 'red');

  // --only naming every step IS a full pass, so it answers for the whole gate.
  const all = checks.runChecks({ root, outDir, only: ['lint', 'typecheck', 'test', 'build'], run: fakeRunner() });
  assert.strictEqual(all.gate, 'green', 'nothing was left unselected, so nothing is unanswered');
});

test('the gate is red when any step fails and green only when none does', (t) => {
  const scripts = { lint: 'eslint .', test: 'vitest' };
  const green = checks.runChecks({ root: makeProject(t, scripts), outDir: outDirFor(t), run: fakeRunner() });
  assert.strictEqual(green.gate, 'green');

  const red = checks.runChecks({
    root: makeProject(t, scripts),
    outDir: outDirFor(t),
    run: fakeRunner({ test: { exitCode: 1, output: '2 failing' } }),
  });
  assert.strictEqual(red.gate, 'red');
  assert.strictEqual(stepNamed(red, 'lint').status, 'passed');
  assert.strictEqual(stepNamed(red, 'test').status, 'failed');
  assert.strictEqual(stepNamed(red, 'test').exitCode, 1);
});

test('a red step does not stop the ones after it, so one pass sees every failure', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest', build: 'vite build' });
  const run = fakeRunner({ lint: { exitCode: 1 } });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run });
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint', 'test', 'build']);
  assert.strictEqual(stepNamed(result, 'build').status, 'passed');
});

test('a timeout is a failure, never a hang reported as a pass', (t) => {
  const root = makeProject(t, { test: 'vitest' });
  const result = checks.runChecks({
    root, outDir: outDirFor(t), run: fakeRunner({ test: { exitCode: null, timedOut: true } }),
  });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.status, 'failed');
  assert.strictEqual(step.timedOut, true);
  assert.match(step.reason, /timed out/i);
  assert.match(fs.readFileSync(step.errorsPath, 'utf8'), /^\(the command timed out after \d+ms/);
  assert.strictEqual(result.gate, 'red');
});

test('the test step carries the non-interactive flag its runner understands', (t) => {
  const cases = [
    ['vitest', ['--run']],
    ['vitest run --coverage', ['--run']],
    ['jest --coverage', ['--ci', '--watchAll=false']],
    ['ng test my-app', ['--watch=false']],
    ['karma start', ['--watch=false']],
    ['node --test', []],
  ];
  for (const [script, expected] of cases) {
    const run = fakeRunner();
    checks.runChecks({ root: makeProject(t, { test: script }), outDir: outDirFor(t), run });
    const call = run.calls.find((c) => c.options.step === 'test');
    const passed = call.args.slice(call.args.indexOf('--') + 1);
    assert.deepStrictEqual(expected.length ? passed : [], expected, script);
  }
});

test('only the test step gets watch flags; a lint script named like a runner does not', (t) => {
  const run = fakeRunner();
  checks.runChecks({ root: makeProject(t, { lint: 'vitest-eslint-plugin-check' }), outDir: outDirFor(t), run });
  const call = run.calls.find((c) => c.options.step === 'lint');
  assert.ok(!call.args.includes('--'), call.args.join(' '));
});

test('the command is built from the lockfile the project committed', (t) => {
  for (const [lockfile, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
    const run = fakeRunner();
    const result = checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }, lockfile), outDir: outDirFor(t), run });
    assert.strictEqual(result.packageManager, manager);
    assert.strictEqual(run.calls[0].command, manager);
    assert.deepStrictEqual(run.calls[0].args.slice(0, 2), ['run', 'lint']);
  }
  // No lockfile at all: npm is the fallback, because a script still has to be
  // runnable and refusing here would report a skipped gate for a working project.
  const run = fakeRunner();
  const result = checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }, null), outDir: outDirFor(t), run });
  assert.strictEqual(result.packageManager, 'npm');
  assert.strictEqual(run.calls[0].command, 'npm');
});

test('every command runs in the worktree, non-interactively and without colour', (t) => {
  const root = makeProject(t, { lint: 'eslint .' });
  const run = fakeRunner();
  checks.runChecks({ root, outDir: outDirFor(t), run });
  const { options } = run.calls[0];
  assert.strictEqual(options.cwd, root);
  assert.strictEqual(options.env.CI, '1');
  assert.strictEqual(options.env.FORCE_COLOR, '0');
  assert.ok(options.timeoutMs > 0);
});

test('--only re-runs one step and leaves the others alone', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest', build: 'vite build' });
  const outDir = outDirFor(t);
  checks.runChecks({ root, outDir, run: fakeRunner({ lint: { exitCode: 1, output: 'old lint output' } }) });

  const run = fakeRunner();
  const result = checks.runChecks({ root, outDir, only: ['lint'], run });
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint']);
  assert.strictEqual(stepNamed(result, 'lint').status, 'passed');
  assert.strictEqual(stepNamed(result, 'test').status, 'skipped');
  assert.match(stepNamed(result, 'test').reason, /--only/);
  // The logs of the steps this run did not touch survive, because they are still
  // the current output of those steps.
  assert.ok(fs.existsSync(path.join(outDir, 'build.log')));
});

test('a full run clears the logs of a previous one instead of leaving stale output behind', (t) => {
  const outDir = outDirFor(t);
  checks.runChecks({ root: makeProject(t, { build: 'vite build' }), outDir, run: fakeRunner({ build: { output: 'stale' } }) });
  assert.ok(fs.existsSync(path.join(outDir, 'build.log')));

  checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }), outDir, run: fakeRunner() });
  assert.ok(!fs.existsSync(path.join(outDir, 'build.log')));
  assert.ok(fs.existsSync(path.join(outDir, 'lint.log')));
});

test('each step writes its output to its own log, and the step points at it', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest' });
  const outDir = outDirFor(t);
  const result = checks.runChecks({
    root, outDir, run: fakeRunner({ test: { exitCode: 1, output: 'FAIL src/a.spec.ts' } }),
  });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.logPath, path.join(outDir, 'test.log'));
  assert.match(fs.readFileSync(step.logPath, 'utf8'), /FAIL src\/a\.spec\.ts/);
  assert.strictEqual(step.truncated, false);
  // A passing step keeps its log too - for the user, who may want to see it. The
  // agent gets nothing to read there: a pass is its exit code.
  assert.ok(fs.existsSync(stepNamed(result, 'lint').logPath));
  assert.strictEqual(stepNamed(result, 'lint').errorsPath, null);
});

test('parseArgs takes one step\'s own command line, and only with that step named', () => {
  const args = checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=test', '--command=npx vitest run src/a.spec.ts']);
  assert.strictEqual(args.command, 'npx vitest run src/a.spec.ts');
  assert.strictEqual(checks.parseArgs(['--root=/a', '--out-dir=/b']).command, null);
  // A line with no step would have no label, no log and no verdict of its own.
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--command=go test ./...']), /--only/);
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=test,build', '--command=go test ./...']), /--only/);
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=test', '--command= ']), /empty/);
});

test('the unit-test step prefers test:unit, because test may run the e2e suite as well', (t) => {
  const root = makeProject(t, { test: 'npm run test:unit && playwright test', 'test:unit': 'vitest' });
  const run = fakeRunner();
  const result = checks.runChecks({ root, outDir: outDirFor(t), run });
  assert.strictEqual(stepNamed(result, 'test').script, 'vitest');
  assert.deepStrictEqual(run.calls.find((c) => c.options.step === 'test').args, ['run', 'test:unit', '--', '--run']);
});

const jestOutput = [
  '> x@1.0.0 test',
  '> jest',
  '',
  'PASS src/ok.spec.ts',
  '  ✓ handles an error gracefully (3 ms)',
  'FAIL src/foo.spec.ts',
  '  ● Foo › adds',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 3',
  '    Received: 4',
  '',
  '      at Object.<anonymous> (src/foo.spec.ts:4:21)',
  '      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)',
  '',
  'Tests:       1 failed, 1 passed, 2 total',
  'npm error Lifecycle script `test` failed with error:',
  'npm error code 1',
].join('\n');

test('a failed step gets an excerpt of its failure lines alone, and the step points at it', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'jest' });
  const outDir = outDirFor(t);
  const result = checks.runChecks({ root, outDir, run: fakeRunner({ test: { exitCode: 1, output: jestOutput } }) });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.errorsPath, path.join(outDir, 'test.errors.log'));
  const excerpt = fs.readFileSync(step.errorsPath, 'utf8');
  for (const kept of ['FAIL src/foo.spec.ts', '● Foo › adds', 'Received: 4', 'src/foo.spec.ts:4:21', 'Tests:       1 failed']) {
    assert.ok(excerpt.includes(kept), `${kept} is missing from:\n${excerpt}`);
  }
  // A passing test, the package manager's epilogue and a frame inside a dependency
  // are output, not failure.
  for (const dropped of ['PASS', 'handles an error', 'npm error', 'jest-circus', '> jest']) {
    assert.ok(!excerpt.includes(dropped), `${dropped} leaked into:\n${excerpt}`);
  }
  assert.strictEqual(stepNamed(result, 'lint').errorsPath, null);
  assert.ok(!fs.existsSync(path.join(outDir, 'lint.errors.log')));
});

test('a step that turns green drops the excerpt a red pass left, while a step not re-run keeps its own', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest' });
  const outDir = outDirFor(t);
  checks.runChecks({
    root, outDir, run: fakeRunner({ lint: { exitCode: 1, output: 'x.js\n  1:1  error  bad  rule' }, test: { exitCode: 1, output: 'FAIL src/a.spec.ts' } }),
  });
  const result = checks.runChecks({ root, outDir, only: ['test'], run: fakeRunner() });
  assert.strictEqual(stepNamed(result, 'test').errorsPath, null);
  assert.ok(!fs.existsSync(path.join(outDir, 'test.errors.log')));
  // lint was not run again, so the excerpt of its last run is still the current one.
  assert.strictEqual(stepNamed(result, 'lint').errorsPath, path.join(outDir, 'lint.errors.log'));
});

test('a failed step that printed nothing says so rather than leaving an empty excerpt', (t) => {
  const root = makeProject(t, { build: 'vite build' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner({ build: { exitCode: 1, output: '' } }) });
  assert.match(fs.readFileSync(stepNamed(result, 'build').errorsPath, 'utf8'), /printed nothing/);
});

// Asserts what an excerpt keeps and what it drops, printing it when either fails.
function assertExcerpt(output, kept, dropped) {
  const excerpt = checks.extractErrors(output);
  for (const text of kept) assert.ok(excerpt.includes(text), `${text} is missing from:\n${excerpt}`);
  for (const text of dropped) assert.ok(!excerpt.includes(text), `${text} leaked into:\n${excerpt}`);
  return excerpt;
}

test('the ESLint excerpt keeps the errors under their file and leaves a warnings-only file out', () => {
  assertExcerpt([
    '',
    '/w/src/a.js',
    "  1:10  error    'foo' is defined but never used  no-unused-vars",
    '  2:5   warning  Unexpected console statement      no-console',
    '',
    '/w/src/b.js',
    '  4:1  warning  Unexpected console statement  no-console',
    '',
    '✖ 3 problems (1 error, 2 warnings)',
  ].join('\n'), ['/w/src/a.js', "'foo' is defined but never used", '✖ 3 problems'], ['/w/src/b.js', 'Unexpected console']);
});

test('a Jest verbose ✕ line is kept however far down its file it sits', () => {
  const suites = [];
  for (let n = 1; n <= 24; n += 1) suites.push(`  suite ${n}`, `    ✓ passes ${n} (1 ms)`);
  assertExcerpt([
    'FAIL src/b.test.js',
    ...suites,
    '  suite 25',
    '    ✕ waits between tries (5 ms)',
    '',
    'Tests:       1 failed, 24 passed, 25 total',
  ].join('\n'), ['suite 25', '✕ waits between tries', 'Tests:'], ['passes 3']);
});

test('ESLint failing on --max-warnings makes the warnings the errors', () => {
  assertExcerpt([
    '/w/src/a.js',
    '  2:5  warning  Unexpected console statement  no-console',
    '',
    '✖ 1 problem (0 errors, 1 warning)',
    '',
    'ESLint found too many warnings (maximum: 0).',
  ].join('\n'), ['/w/src/a.js', 'Unexpected console statement', 'too many warnings'], []);
});

test('the esbuild excerpt keeps the location and the code frame under an error', () => {
  assertExcerpt([
    'Application bundle generation failed. [1.234 seconds]',
    '',
    "✘ [ERROR] TS2322: Type 'string' is not assignable to type 'number'. [plugin angular-compiler]",
    '',
    '    src/app/foo.component.ts:10:4:',
    "      10 │     this.x = 'a';",
    '         ╵     ~~~~~~',
    '',
  ].join('\n'), ['✘ [ERROR] TS2322', 'src/app/foo.component.ts:10:4:', "this.x = 'a';"], []);
});

test('the Karma excerpt keeps the failure and its own frame, and one state of the progress counter', () => {
  const karma = [
    'Chrome Headless 120.0.0.0 (Windows 10): Executed 11 of 41 SUCCESS (0.4 secs / 0.3 secs)',
    'Chrome Headless 120.0.0.0 (Windows 10) FooComponent should create FAILED',
    "\tTypeError: Cannot read properties of undefined (reading 'x')",
    '\t    at UserContext.apply (src/app/foo.component.spec.ts:20:5)',
    '\t    at _ZoneDelegate.invoke (node_modules/zone.js/fesm2015/zone.js:368:26)',
    '\t    at <Jasmine>',
    'Chrome Headless 120.0.0.0 (Windows 10): Executed 12 of 41 (1 FAILED) (0.5 secs / 0.4 secs)',
    'Chrome Headless 120.0.0.0 (Windows 10): Executed 13 of 41 (1 FAILED) (0.5 secs / 0.4 secs)',
    'Chrome Headless 120.0.0.0 (Windows 10): Executed 41 of 41 (1 FAILED) (1.2 secs / 1.1 secs)',
    'TOTAL: 1 FAILED, 40 SUCCESS',
  ].join('\n');
  assertExcerpt(karma,
    ['should create FAILED', 'TypeError: Cannot read properties', 'foo.component.spec.ts:20:5', 'Executed 41 of 41', 'TOTAL: 1 FAILED'],
    ['zone.js', '<Jasmine>', 'Executed 11 of 41', 'Executed 12 of 41', 'Executed 13 of 41']);
});

test('the Vitest excerpt reaches the location printed a paragraph below the message', () => {
  assertExcerpt([
    ' ✓ src/ok.spec.ts (3 tests) 4ms',
    ' ❯ src/foo.spec.ts (2 tests | 1 failed) 6ms',
    '   ✓ Foo > handles an error 1ms',
    '   × Foo > adds 3ms',
    '     → expected 4 to be 3 // Object.is equality',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/foo.spec.ts > Foo > adds',
    'AssertionError: expected 4 to be 3 // Object.is equality',
    '',
    '- Expected',
    '+ Received',
    '',
    '- 3',
    '+ 4',
    '',
    ' ❯ src/foo.spec.ts:11:15',
    "      9|   it('adds', () => {",
    '     10|     const result = add(2, 2);',
    '     11|     expect(result).toBe(3);',
    '       |               ^',
    '     12|   });',
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
    '',
    ' Test Files  1 failed | 1 passed (2)',
    '      Tests  1 failed | 4 passed (5)',
  ].join('\n'),
  ['× Foo > adds', '→ expected 4 to be 3', 'AssertionError', '+ 4', 'src/foo.spec.ts:11:15', 'expect(result).toBe(3);', 'Tests  1 failed'],
  ['src/ok.spec.ts', 'handles an error']);
});

test('what the console printed is not a failure, even when it says error', () => {
  assertExcerpt([
    'PASS src/a.spec.ts',
    '  ● Console',
    '',
    '    console.error',
    '      Error: connection failed',
    '',
    '      at log (src/a.ts:3:11)',
    '',
    'FAIL src/b.spec.ts',
    '  ● Console',
    '',
    '    console.warn',
    '      deprecated: failed to parse',
    '',
    '  ● B › works',
    '',
    '    TypeError: x is not a function',
    '',
    '      at Object.<anonymous> (src/b.spec.ts:5:3)',
  ].join('\n'),
  ['FAIL src/b.spec.ts', '● B › works', 'TypeError: x is not a function', 'src/b.spec.ts:5:3'],
  ['connection failed', 'deprecated', 'console.', 'src/a.ts']);
});

test('the package manager\'s lines stay in when they are the only failure there is', () => {
  assertExcerpt([
    'npm error Missing script: "test:unit"',
    'npm error',
    'npm error To see a list of scripts, run:',
    'npm error   npm run',
  ].join('\n'), ['Missing script: "test:unit"'], []);
});

test('output with no failure line in it is read through its tail, where every runner summarises', () => {
  const excerpt = checks.extractErrors(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  assert.strictEqual(excerpt.split('\n').length, 40);
  assert.match(excerpt, /line 99$/);
  assert.doesNotMatch(excerpt, /line 59\b/);
});

test('a flood of errors is cut to the first ones and the count, and says so', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `src/f${i}.ts(1,1): error TS2304: Cannot find name 'x${i}'.`);
  const excerpt = checks.extractErrors([...lines, '', 'Found 1000 errors in 1000 files.'].join('\n')).split('\n');
  assert.strictEqual(excerpt.length, 200);
  assert.match(excerpt[0], /src\/f0\.ts/);
  assert.ok(excerpt.some((line) => /more lines cut here/.test(line)));
  assert.strictEqual(excerpt[excerpt.length - 1], 'Found 1000 errors in 1000 files.');
});

test('the excerpt is what a terminal would have shown: no colour codes, a redrawn line in its last state', () => {
  const excerpt = assertExcerpt(
    '\u001b[31mFAIL\u001b[39m src/a.spec.ts\nExecuted 1 of 3\rExecuted 2 of 3\rExecuted 3 of 3 (1 FAILED)\r\nTOTAL: 1 FAILED',
    ['FAIL src/a.spec.ts', 'Executed 3 of 3 (1 FAILED)', 'TOTAL: 1 FAILED'], ['\u001b', 'Executed 1 of 3', 'Executed 2 of 3']);
  assert.ok(!excerpt.includes('\r'));
});

test('--command runs the caller\'s line as the one step, even where there is no package.json', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-cmd-'));
  const outDir = outDirFor(t);
  const run = fakeRunner({ test: { exitCode: 1, output: '--- FAIL: TestAdd (0.00s)\n    math_test.go:9: expected 3, got 4\nFAIL' } });
  const result = checks.runChecks({ root: dir, outDir, only: ['test'], command: 'go test ./...', run });
  assert.strictEqual(run.calls.length, 1);
  assert.strictEqual(run.calls[0].command, 'go test ./...');
  assert.deepStrictEqual(run.calls[0].args, []);
  assert.strictEqual(run.calls[0].options.shell, true);
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.command, 'go test ./...');
  assert.strictEqual(step.status, 'failed');
  assert.match(fs.readFileSync(step.errorsPath, 'utf8'), /math_test\.go:9: expected 3, got 4/);
  assert.strictEqual(result.gate, 'red');
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.warnings, []);
});

test('a --command line still gets the flag that stops its runner watching, unless it carries one', (t) => {
  const root = makeProject(t, { test: 'ng test', 'test:jest': 'jest' });
  const cases = [
    ['npx ng test --include=src/app/foo.spec.ts', 'npx ng test --include=src/app/foo.spec.ts --watch=false'],
    ['npx vitest run src/a.spec.ts --run', 'npx vitest run src/a.spec.ts --run'],
    ['npx jest src/foo.spec.ts', 'npx jest src/foo.spec.ts --ci --watchAll=false'],
    ['npx ng test --watch=false', 'npx ng test --watch=false'],
    // A package.json script names its runner in the script, not in the line.
    ['npm test -- --include=src/app/foo.spec.ts', 'npm test -- --include=src/app/foo.spec.ts --watch=false'],
    ['npm run test:jest', 'npm run test:jest -- --ci --watchAll=false'],
    ['go test ./...', 'go test ./...'],
  ];
  for (const [line, expected] of cases) {
    const run = fakeRunner();
    checks.runChecks({ root, outDir: outDirFor(t), only: ['test'], command: line, run });
    assert.strictEqual(run.calls[0].command, expected, line);
  }
});

test('the CLI runs a --command line for real and hands back its failures alone', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-cli-cmd-'));
  const outDir = outDirFor(t);
  fs.writeFileSync(path.join(dir, 'suite.js'), [
    'console.log("PASS src/ok.spec.ts");',
    'console.log("FAIL src/foo.spec.ts");',
    'console.log("  \\u25cf Foo \\u203a adds");',
    'console.log("    Received: 4");',
    'process.exit(1);',
  ].join('\n'));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [
      path.join(__dirname, 'checks.cjs'), `--root=${dir}`, `--out-dir=${outDir}`, '--only=test', '--command=node suite.js',
    ], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assert.strictEqual(status, 1);
  const step = stepNamed(JSON.parse(stdout), 'test');
  assert.strictEqual(step.status, 'failed');
  assert.strictEqual(step.exitCode, 1);
  const excerpt = fs.readFileSync(step.errorsPath, 'utf8');
  assert.match(excerpt, /● Foo › adds/);
  assert.match(excerpt, /Received: 4/);
  assert.doesNotMatch(excerpt, /PASS/);
});

test('a huge log keeps its tail, where the failure summary is, and says it was cut', (t) => {
  const root = makeProject(t, { test: 'vitest' });
  const outDir = outDirFor(t);
  const output = `${'x'.repeat(400 * 1024)}\nTests: 3 failed\n`;
  const result = checks.runChecks({ root, outDir, run: fakeRunner({ test: { exitCode: 1, output } }) });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.truncated, true);
  const written = fs.readFileSync(step.logPath, 'utf8');
  assert.ok(written.length < output.length);
  assert.match(written, /Tests: 3 failed/);
  assert.match(written.split('\n')[0], /truncated/i);
});

test('exitCodeFor separates a red gate from a script that could not run at all', () => {
  assert.strictEqual(checks.exitCodeFor({ gate: 'green', errors: [] }), 0);
  assert.strictEqual(checks.exitCodeFor({ gate: 'skipped', errors: [] }), 0);
  assert.strictEqual(checks.exitCodeFor({ gate: 'red', errors: [] }), 1);
  assert.strictEqual(checks.exitCodeFor({ gate: 'skipped', errors: ['unreadable root'] }), 2);
});

test('an unreadable root is an error of the script, not a red gate', (t) => {
  const missing = path.join(fs.realpathSync(tempDir(t, 'fpc-gone-')), 'not-here');
  const result = checks.runChecks({ root: missing, outDir: outDirFor(t), run: fakeRunner() });
  assert.ok(result.errors.length > 0);
  assert.strictEqual(checks.exitCodeFor(result), 2);
});

test('a malformed package.json is an error, not a silently skipped gate', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-bad-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "scripts": { "lint": }\n');
  const result = checks.runChecks({ root: dir, outDir: outDirFor(t), run: fakeRunner() });
  assert.ok(result.errors.some((e) => /package\.json/.test(e)), result.errors.join(' | '));
  assert.strictEqual(checks.exitCodeFor(result), 2);
});

test('the CLI prints one JSON object and exits on the gate, not on the last command', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-cli-'));
  const outDir = outDirFor(t);
  const out = execFileSync(process.execPath, [
    path.join(__dirname, 'checks.cjs'), `--root=${dir}`, `--out-dir=${outDir}`,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.gate, 'skipped');
  assert.strictEqual(parsed.root, dir);

  // A bad argument must not look like a green gate to the agent reading $?.
  const bad = { status: 0 };
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'checks.cjs'), '--nope'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    bad.status = err.status;
    bad.stdout = String(err.stdout || '');
  }
  assert.strictEqual(bad.status, 2);
  assert.ok(JSON.parse(bad.stdout).errors.length > 0);
});

test('the real runner reports the exit code of the command it spawned', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-real-'));
  const outDir = outDirFor(t);
  fs.mkdirSync(outDir, { recursive: true });
  const ok = checks.defaultRun(process.execPath, ['-e', 'console.log("hello"); process.exit(0)'], {
    cwd: dir, env: process.env, timeoutMs: 30000, step: 'lint',
  });
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(ok.timedOut, false);
  assert.match(ok.output, /hello/);

  const bad = checks.defaultRun(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], {
    cwd: dir, env: process.env, timeoutMs: 30000, step: 'test',
  });
  assert.strictEqual(bad.exitCode, 3);
  assert.match(bad.output, /boom/);
});

test('reapTree refuses to act under a pid that is still alive', (t) => {
  // The reaper walks the parent chain from the pid spawnSync handed back, which by
  // then is dead. If something LIVE holds that pid, Windows has reused it and the
  // children under it belong to a stranger. An orphan left running is bad; killing
  // somebody else process is worse, so the answer there is to do nothing at all.
  // This guard is the whole safety of the feature, which is why it is tested first.
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true });
  t.after(() => child.kill());
  assert.deepStrictEqual(checks.reapTree(process.pid), [], 'a live pid is refused');
  assert.strictEqual(child.exitCode, null, 'and nothing under it was touched');
  assert.deepStrictEqual(checks.reapTree(0), [], 'a pid that cannot exist reaps nothing');
});

test('a timed-out command does not leave its runner running', { skip: process.platform !== 'win32' }, (t) => {
  // This suite spawns no package manager on purpose - offline and fast. This one test
  // spawns a real process anyway, because a reaper proved against a stub is worth
  // nothing: the whole defect was that spawnSync reports a kill it did not perform.
  // What it costs is about two seconds, and what it buys is the only evidence there is.
  const dir = fs.realpathSync(tempDir(t, 'fpc-reap-'));
  const marker = path.join(dir, 'alive.txt');
  fs.writeFileSync(path.join(dir, 'runner.js'),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));`
    + 'setTimeout(() => {}, 60000);');

  const outcome = checks.defaultRun(`node "${path.join(dir, 'runner.js')}"`, [],
    { cwd: dir, env: process.env, timeoutMs: 2000, shell: true });
  assert.ok(outcome.timedOut, 'the command was cut off by the timeout');

  const pid = Number(fs.readFileSync(marker, 'utf8').trim());
  assert.ok(Number.isFinite(pid), 'the runner reported its pid');
  assert.ok(outcome.orphans.includes(pid), `reaped ${JSON.stringify(outcome.orphans)}, runner was ${pid}`);

  // Get-Process exits non-zero when the id is gone, so the throw IS the answer here.
  let alive;
  try {
    alive = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`],
      { encoding: 'utf8' }).trim();
  } catch {
    alive = '';
  }
  assert.notStrictEqual(alive, String(pid), 'the runner is gone, not merely reported as gone');
});

