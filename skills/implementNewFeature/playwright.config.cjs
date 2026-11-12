const path = require('node:path');
const { defineConfig } = require('@playwright/test');

// E2E_TEST_DIR lets pipeline agents point the runner at the session's e2e/
// directory (<SESSION>/e2e) while keeping the toolchain inside the skill
// folder; tests are session-scoped so a run never executes another feature's suite.
const testDir = process.env.E2E_TEST_DIR || './tests';
const sessionRun = !!process.env.E2E_TEST_DIR;

// A session suite has two kinds of spec file, told apart by name. `<name>.parallel.spec.cjs` is
// HERMETIC: every response its assertions depend on is routed or mocked (`page.route`, the
// DOH-MOCK module), so nothing another test writes can reach it and its files run side by side.
// Every other spec may sign in, seed and change data in the ONE store behind the ONE dev server,
// so those run one at a time, in one worker - parallel, they would have tests navigate and write
// over each other, and the rule below turns exactly that interference into a reported "unstable
// test". Measured on a 99-test suite run serially: 6-7 minutes a pass, about 40 minutes of one
// task's validation and final review spent waiting for runs.
const parallelSpec = /\.parallel\.spec\.[cm]?[jt]s$/;
const sessionWorkers = Math.max(1, Number(process.env.E2E_WORKERS) || 3);

module.exports = defineConfig({
  testDir,
  // A real app (login, seeding, a backend round trip) is slower than a static
  // page: at 15 s a healthy feature failed and got "fixed" as an application bug.
  timeout: 30000,
  expect: { timeout: 7000 },
  // Never retry. A test that only passes on the second attempt is a finding
  // ("unstable test"), not a green run — retries would hide exactly that.
  retries: 0,
  // The skill's own tests each start an isolated server, so they keep the runner's default.
  // A session suite gets E2E_WORKERS (3 by default) in all; its `serial` project takes one.
  workers: sessionRun ? sessionWorkers : undefined,
  projects: sessionRun
    ? [
      { name: 'serial', testIgnore: parallelSpec, workers: 1 },
      { name: 'parallel', testMatch: parallelSpec, fullyParallel: false },
    ]
    : undefined,
  // A session suite stops at its tenth failure. A backend or mock server that went down fails
  // every test the same way at the login, each after the full timeout: 41 of them once took
  // twenty minutes to say what the first three already had. Ten still shows every real failure
  // of a focused feature in one run. E2E_MAX_FAILURES=0 lifts the limit.
  maxFailures: sessionRun
    ? (process.env.E2E_MAX_FAILURES !== undefined ? Number(process.env.E2E_MAX_FAILURES) : 10)
    : undefined,
  // Failure artifacts land next to the session's tests, so the agent reads the
  // captured page snapshot and screenshot instead of re-walking the flow live.
  // E2E_OUTPUT_DIR gives a run a folder of its own: the runner empties this folder when it
  // starts, so two spec authors running side by side would delete each other's artifacts.
  outputDir: sessionRun
    ? (process.env.E2E_OUTPUT_DIR || path.join(testDir, '..', 'test-results'))
    : './test-results',
  // The console keeps the reporter checks.cjs cuts its failure excerpt from; the JSON beside it
  // is what checklist.cjs ticks the checklist from - every test by title and outcome, so a tick
  // is the run's own record and never an agent's reading of it. E2E_REPORT_FILE moves it: a
  // partial run (one spec, an author's own) must not overwrite the report of the full suite.
  reporter: sessionRun
    ? [[process.env.CI ? 'dot' : 'list'],
      ['json', { outputFile: process.env.E2E_REPORT_FILE || path.join(testDir, '..', 'e2e-report.json') }]]
    : undefined,
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
