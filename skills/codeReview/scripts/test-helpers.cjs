'use strict';

// Scaffolding shared by the script test suites, so temp-directory handling is
// defined and fixed in one place.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup (Windows may hold read-only git objects)
    }
  });
  return dir;
}

module.exports = { tempDir };
