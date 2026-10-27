'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const sync = require('./sync-walker.cjs');

test('the shipped walker agent carries references/walk.md, as sync-walker.cjs writes it', () => {
  const { changed } = sync.syncWalker({ write: false });
  assert.strictEqual(changed, false, 'agents/codereview-walker.md is out of date: run node skills/codeReview/scripts/sync-walker.cjs');
  const agent = fs.readFileSync(sync.AGENT, 'utf8');
  assert.match(agent, /^---\r?\nname: codereview-walker\r?\n/, 'the frontmatter stays first');
  assert.ok(agent.includes('## Step 3 — Analyze') && agent.includes('## Step 4 — Report format'));
});

test('withWalk replaces the block, keeps the rest, and needs both markers', () => {
  const text = `head\n${sync.MARK_START}\nold\n${sync.MARK_END}\ntail\n`;
  assert.strictEqual(sync.withWalk(text, 'new\nrules\n'), `head\n${sync.MARK_START}\nnew\nrules\n${sync.MARK_END}\ntail\n`);
  assert.strictEqual(sync.withWalk('no markers', 'x'), null);
});
