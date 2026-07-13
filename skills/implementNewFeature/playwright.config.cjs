const { defineConfig } = require('@playwright/test');

// E2E_TEST_DIR lets pipeline agents point the runner at the session's e2e/
// directory (<SESSION>/e2e) while keeping the toolchain inside the skill
// folder; tests are session-scoped so a run never executes another feature's suite.
module.exports = defineConfig({
  testDir: process.env.E2E_TEST_DIR || './tests',
  timeout: 15000,
  use: { browserName: 'chromium' },
});
