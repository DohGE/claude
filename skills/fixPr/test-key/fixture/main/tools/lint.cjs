'use strict';

// The project's lint: three rules over src/, one line per problem, exit 1 on any.

const fs = require('node:fs');
const path = require('node:path');

const withoutStrings = (line) => line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
const rules = [
  { id: 'no-var', test: (line) => /^\s*var\s/.test(line), text: 'declare with const or let, never var' },
  { id: 'eqeqeq', test: (line) => /[^=!<>]==[^=]|!=[^=]/.test(withoutStrings(line)), text: 'compare with === and !==' },
  { id: 'no-console', test: (line) => /\bconsole\.log\(/.test(line), text: 'no console.log in src/' },
];

const dir = path.join(__dirname, '..', 'src');
const problems = [];
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.cjs')).sort()) {
  fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).forEach((line, i) => {
    for (const rule of rules) if (rule.test(line)) problems.push(`src/${name}:${i + 1} ${rule.id}: ${rule.text}`);
  });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint: clean');
