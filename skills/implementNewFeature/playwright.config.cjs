const path = require('node:path');
const { defineConfig } = require('@playwright/test');

// E2E_TEST_DIR lets pipeline agents point the runner at the session's e2e/
// directory (<SESSION>/e2e) while keeping the toolchain inside the skill
// folder; tests are session-scoped so a run never executes another feature's suite.
const testDir = process.env.E2E_TEST_DIR || './tests';

module.exports = defineConfig({
  testDir,
  // A real app (login, seeding, a backend round trip) is slower than a static
  // page: at 15 s a healthy feature failed and got "fixed" as an application bug.
  timeout: 30000,
  expect: { timeout: 7000 },
  // Never retry. A test that only passes on the second attempt is a finding
  // ("unstable test"), not a green run — retries would hide exactly that.
  retries: 0,
  // Failure artifacts land next to the session's tests, so the agent reads the
  // captured page snapshot and screenshot instead of re-walking the flow live.
  outputDir: process.env.E2E_TEST_DIR
    ? path.join(testDir, '..', 'test-results')
    : './test-results',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
