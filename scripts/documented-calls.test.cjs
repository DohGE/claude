'use strict';

// Every `node .../<script>.cjs --flag=…` the plugin's own documentation tells a
// reader - or an orchestrator - to run has to resolve: the script must exist, and
// every flag on the line must be one its parseArgs accepts.
//
// This is the one drift a reader cannot catch by reading. Each of these scripts
// REFUSES an unknown flag rather than ignoring it (they say so, one by one, and
// for good reason: a dropped --project reviews the wrong tree, a dropped --root
// installs into the user's own checkout), so a documented call carrying a flag
// that was renamed does not degrade - it exits 1 in the middle of a pipeline step.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

// The flag names a script's parseArgs actually reads, in both shapes the plugin
// uses: `--name=value` (matched as `m[1] === 'name'`) and the bare `--name`.
function flagsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const flags = new Set();
  for (const m of src.matchAll(/m\[1\] === '([a-z-]+)'/g)) flags.add(m[1]);
  for (const m of src.matchAll(/arg === '--([a-z-]+)'/g)) flags.add(m[1]);
  return flags;
}

test('both plugin manifests name every shipped skill', () => {
  // The marketplace entry is what somebody reads before installing, and it had gone
  // a whole skill out of date: fixPr shipped, plugin.json was updated, the listing
  // was not. Nothing else compares the two, and nobody re-reads a description.
  const skills = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(skills.length > 0, 'the plugin ships at least one skill');
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', rel), 'utf8'));
  const described = [
    ['plugin.json', read('plugin.json').description],
    ['marketplace.json', read('marketplace.json').plugins[0].description],
  ];
  for (const [where, text] of described) {
    assert.deepStrictEqual(skills.filter((s) => !text.includes(s)), [],
      'skills missing from the ' + where + ' description');
  }
});

test('every documented script call names a real script and real flags', () => {
  const scripts = new Map();
  for (const file of walk(ROOT, (n) => n.endsWith('.cjs') && !n.endsWith('.test.cjs'))) {
    // Basenames are unique across the plugin; a duplicate would make the lookup
    // below ambiguous, which is itself worth failing on.
    assert.ok(!scripts.has(path.basename(file)),
      `two scripts share the name ${path.basename(file)}; the docs could not name either unambiguously`);
    scripts.set(path.basename(file), file);
  }

  const problems = [];
  for (const doc of walk(ROOT, (n) => n.endsWith('.md'))) {
    // test-environment/ holds fixture prose, not this plugin's documentation.
    if (doc.includes(`${path.sep}test-environment${path.sep}`)) continue;
    const rel = path.relative(ROOT, doc).split(path.sep).join('/');
    const text = fs.readFileSync(doc, 'utf8');
    // A call's flags run to the end of its own command - `&&`, `||`, `;` or a spaced `|`
    // ends it - so a second call chained on the same line is matched, and checked, on its own.
    for (const call of text.matchAll(/node "?([^"\s]*scripts\/[a-z-]+\.cjs)"?((?:(?!&&|\|\||;|\s\|\s)[^\n`])*)/gi)) {
      const base = path.basename(call[1]);
      const script = scripts.get(base);
      if (!script) {
        problems.push(`${rel}: no such script ${base}`);
        continue;
      }
      const flags = flagsOf(script);
      for (const flag of call[2].matchAll(/--([a-z-]+)/g)) {
        if (!flags.has(flag[1])) problems.push(`${rel}: ${base} does not take --${flag[1]}`);
      }
    }
  }
  assert.deepStrictEqual(problems, []);
});
