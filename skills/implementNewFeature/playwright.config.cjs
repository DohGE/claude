const { defineConfig } = require('@playwright/test');

// E2E_TEST_DIR lets pipeline agents point the runner at the target project's
// e2e/ directory while keeping the toolchain inside the skill folder.
module.exports = defineConfig({
  testDir: process.env.E2E_TEST_DIR || './tests',
  timeout: 15000,
  use: { browserName: 'chromium' },
});
