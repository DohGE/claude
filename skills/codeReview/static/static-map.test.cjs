'use strict';
// node --test static/static-map.test.cjs
// Checks the map against the contract (references/static.md "The map"). The esquery parse test
// needs a project with ESLint installed: set DOH_STATIC_TEST_PROJECT to its root, else it skips.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const rulebook = require('../scripts/rulebook.cjs');
const { checks } = require('../scripts/static-builtin.cjs');
const plugin = require('./eslint-plugin-doh.cjs');

const mapPath = path.join(__dirname, 'static-map.json');
const instructionsDir = path.join(__dirname, '..', 'instructions');
const raw = fs.readFileSync(mapPath, 'utf8');
const map = JSON.parse(raw);
const entriesOf = (value) => (Array.isArray(value) ? value : value.entries);
const allEntries = () => Object.entries(map.items).flatMap(([address, value]) => entriesOf(value).map((entry) => ({ address, entry })));

test('the map parses and has the contract shape', () => {
  assert.strictEqual(map.version, 1);
  assert.ok(map.items && typeof map.items === 'object' && !Array.isArray(map.items));
  for (const [address, value] of Object.entries(map.items)) {
    assert.match(address, /^[a-z0-9-]+#\d+$/, address);
    if (!Array.isArray(value)) {
      assert.deepStrictEqual(Object.keys(value).sort(), ['entries', 'partial'], address);
      assert.strictEqual(typeof value.partial, 'boolean', address);
    }
    assert.ok(entriesOf(value).length > 0, `${address} has no entries`);
  }
});

test('loadRulebook takes the map with no static warning', () => {
  const rules = rulebook.loadRulebook([instructionsDir]);
  const warnings = rules.warnings.filter((w) => /static/i.test(w));
  assert.deepStrictEqual(warnings, []);
});

test('an item with a points entry, or with no decides entry, is partial', () => {
  for (const [address, value] of Object.entries(map.items)) {
    const entries = entriesOf(value);
    const partial = !Array.isArray(value) && value.partial;
    if (entries.some((e) => e.level === 'points')) assert.ok(partial, `${address} has points entries but is not partial`);
    assert.ok(entries.some((e) => e.level === 'decides') || partial, `${address} decides nothing but is not partial`);
  }
});

test('no address is written twice (array and object form, or twice in one form)', () => {
  const seen = new Map();
  for (const m of raw.matchAll(/^ {4}"([^"]+#\d+)": ([[{])/gm)) {
    assert.ok(!seen.has(m[1]), `${m[1]} appears twice (${seen.get(m[1])} and ${m[2]})`);
    seen.set(m[1], m[2]);
  }
  assert.strictEqual(seen.size, Object.keys(map.items).length);
});

test('every builtin check exists in static-builtin.cjs', () => {
  for (const { address, entry } of allEntries()) {
    if (entry.engine === 'builtin') assert.strictEqual(typeof checks[entry.check], 'function', `${address}: ${entry.check}`);
  }
});

test('every doh/ rule exists in the plugin, with the messageIds it names', () => {
  for (const { address, entry } of allEntries()) {
    if (!entry.rule || !entry.rule.startsWith('doh/')) continue;
    const rule = plugin.rules[entry.rule.slice(4)];
    assert.ok(rule, `${address}: ${entry.rule}`);
    for (const id of entry.messageIds || []) assert.ok(rule.meta.messages[id], `${address}: ${entry.rule} has no messageId ${id}`);
  }
});

// Brackets, parentheses and quotes balance outside regex literals and strings.
function balanced(selector) {
  const stack = [];
  const pairs = { ')': '(', ']': '[' };
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' || c === "'") {
      const end = selector.indexOf(c, i + 1);
      if (end < 0) return false;
      i = end;
    } else if (c === '/' && /[=!]\s*$/.test(selector.slice(0, i))) {
      let j = i + 1;
      while (j < selector.length && selector[j] !== '/') j += selector[j] === '\\' ? 2 : 1;
      if (j >= selector.length) return false;
      i = j;
    } else if (c === '(' || c === '[') stack.push(c);
    else if (c === ')' || c === ']') { if (stack.pop() !== pairs[c]) return false; }
  }
  return stack.length === 0;
}

test('every esquery selector has balanced brackets, quotes and regex literals', () => {
  for (const { address, entry } of allEntries()) {
    if (entry.selector) assert.ok(balanced(entry.selector), `${address}: ${entry.selector}`);
  }
});

test('every esquery selector parses with the ESLint esquery of a real project', (t) => {
  const root = process.env.DOH_STATIC_TEST_PROJECT;
  if (!root) return t.skip('DOH_STATIC_TEST_PROJECT not set');
  let esquery;
  try {
    const req = createRequire(path.join(root, 'package.json'));
    esquery = createRequire(req.resolve('eslint'))('esquery');
  } catch (err) {
    return t.skip(`esquery not resolvable from ${root}: ${err.message}`);
  }
  for (const { address, entry } of allEntries()) {
    if (entry.selector) assert.doesNotThrow(() => esquery.parse(entry.selector), `${address}: ${entry.selector}`);
  }
});
