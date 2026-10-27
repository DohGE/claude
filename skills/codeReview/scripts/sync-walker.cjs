#!/usr/bin/env node
'use strict';

// Maintainer command: copies the walk's rules (skills/codeReview/references/walk.md) into the
// marked block of agents/codereview-walker.md, whose body is the system prompt of every window
// walker and of the cross-file agent. Until 0.26 each walker Read 70 kB of SKILL.md as its first
// tool call - a cache write per walker, ~1.1M tokens on a 63-window run; one system prompt for all
// of them is written to the cache once and read by every later walker.
//
// Usage: node sync-walker.cjs           rewrites the block when it differs
//        node sync-walker.cjs --check   exit 1 when the block is out of date (a test runs it)

const fs = require('node:fs');
const path = require('node:path');

const skillRoot = path.resolve(__dirname, '..');
const pluginRoot = path.resolve(skillRoot, '..', '..');
const SOURCE = path.join(skillRoot, 'references', 'walk.md');
const AGENT = path.join(pluginRoot, 'agents', 'codereview-walker.md');
const MARK_START = '<!-- walk:start (generated from skills/codeReview/references/walk.md) -->';
const MARK_END = '<!-- walk:end -->';

// The agent text with its block holding `walk`; null when the markers are missing.
function withWalk(agentText, walk) {
  const start = agentText.indexOf(MARK_START);
  const end = agentText.indexOf(MARK_END);
  if (start === -1 || end === -1 || end < start) return null;
  const eol = agentText.includes('\r\n') ? '\r\n' : '\n';
  const body = walk.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return agentText.slice(0, start) + [MARK_START, ...body, MARK_END].join(eol) + agentText.slice(end + MARK_END.length);
}

function syncWalker({ source = SOURCE, agent = AGENT, write = true } = {}) {
  const text = fs.readFileSync(agent, 'utf8');
  const next = withWalk(text, fs.readFileSync(source, 'utf8'));
  if (next === null) throw new Error(`${agent}: no walk block - put ${MARK_START} and ${MARK_END} on their own lines.`);
  const changed = next.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
  if (changed && write) fs.writeFileSync(agent, next);
  return { changed };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  try {
    const { changed } = syncWalker({ write: !check });
    if (check && changed) {
      process.stderr.write(`${AGENT} is out of date with ${SOURCE}: run node ${__filename}\n`);
      process.exit(1);
    }
    process.stdout.write(changed ? `updated ${AGENT}\n` : `${AGENT} is up to date\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { MARK_START, MARK_END, withWalk, syncWalker, SOURCE, AGENT };
