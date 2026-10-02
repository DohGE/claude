'use strict';

// The project's build: loads every module of src/ and writes its public API to dist/api.json.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = {};
for (const name of fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.cjs')).sort()) {
  api[name] = Object.keys(require(path.join(root, 'src', name))).sort();
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'api.json'), `${JSON.stringify(api, null, 2)}\n`);
console.log(`build: ${Object.keys(api).length} modules`);
