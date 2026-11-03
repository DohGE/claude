#!/usr/bin/env node
'use strict';

// Maintainer command: copies the walk's rules into the marked blocks of the codeReview agents,
// whose bodies are the system prompts of the run's sub-agents:
// - agents/codereview-walker.md, every window walker: the whole of references/walk.md. Until 0.26
//   each walker Read 70 kB of SKILL.md as its first tool call - a cache write per walker, ~1.1M
//   tokens on a 63-window run; one system prompt for all of them is written to the cache once and
//   read by every later walker.
// - agents/codereview-cross.md, the cross-file pass of each target: references/cross-file.md, the
//   gates of walk.md and its Step 4. Until 0.27 the pass ran as a walker, re-reading the 70 kB walk
//   it never makes in every turn - 48 turns of a five-target run (2026-10-30).
//
// Usage: node sync-walker.cjs           rewrites every block that differs
//        node sync-walker.cjs --check   exit 1 when a block is out of date (a test runs it)

const fs = require('node:fs');
const path = require('node:path');

const skillRoot = path.resolve(__dirname, '..');
const pluginRoot = path.resolve(skillRoot, '..', '..');
const SOURCE = path.join(skillRoot, 'references', 'walk.md');
const CROSS_SOURCE = path.join(skillRoot, 'references', 'cross-file.md');
const AGENT = path.join(pluginRoot, 'agents', 'codereview-walker.md');
const CROSS_AGENT = path.join(pluginRoot, 'agents', 'codereview-cross.md');
const MARK_START = '<!-- walk:start (generated from skills/codeReview/references/walk.md) -->';
const MARK_END = '<!-- walk:end -->';

// The part of `text` from the line `from` matches up to the line before the one `to` matches.
function section(text, from, to) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => from.test(line));
  const end = lines.findIndex((line, i) => i > start && to.test(line));
  if (start === -1 || end === -1) throw new Error(`no section ${from} .. ${to}`);
  return lines.slice(start, end).join('\n');
}

const read = (file) => fs.readFileSync(file, 'utf8');
// Each block: its markers and where its text comes from.
const blocks = {
  walk: { start: MARK_START, end: MARK_END, text: () => read(SOURCE) },
  cross: {
    start: '<!-- cross:start (generated from skills/codeReview/references/cross-file.md) -->',
    end: '<!-- cross:end -->',
    text: () => read(CROSS_SOURCE),
  },
  gates: {
    start: '<!-- gates:start (generated from the gates of skills/codeReview/references/walk.md, Step 3) -->',
    end: '<!-- gates:end -->',
    text: () => section(read(SOURCE), /^\*\*Scope gate/, /^\*\*Coverage\.\*\*/),
  },
  format: {
    start: '<!-- format:start (generated from Step 4 of skills/codeReview/references/walk.md) -->',
    end: '<!-- format:end -->',
    text: () => section(read(SOURCE), /^## Step 4 /, /^## Skip rationalizations/),
  },
};
const agents = [
  { file: AGENT, blocks: ['walk'] },
  { file: CROSS_AGENT, blocks: ['cross', 'gates', 'format'] },
];

// The agent text with one block holding `body`; null when its markers are missing.
function withBlock(agentText, start, end, body) {
  const at = agentText.indexOf(start);
  const stop = agentText.indexOf(end);
  if (at === -1 || stop === -1 || stop < at) return null;
  const eol = agentText.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return agentText.slice(0, at) + [start, ...lines, end].join(eol) + agentText.slice(stop + end.length);
}

// The walker's text with its block holding `walk`; null when the markers are missing.
function withWalk(agentText, walk) {
  return withBlock(agentText, MARK_START, MARK_END, walk);
}

function syncAgent({ file, names }, write) {
  const text = fs.readFileSync(file, 'utf8');
  let next = text;
  for (const name of names) {
    const block = blocks[name];
    next = withBlock(next, block.start, block.end, block.text());
    if (next === null) throw new Error(`${file}: no ${name} block - put ${block.start} and ${block.end} on their own lines.`);
  }
  const changed = next.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
  if (changed && write) fs.writeFileSync(file, next);
  return changed;
}

function syncWalker({ source = SOURCE, agent = AGENT, write = true } = {}) {
  const text = fs.readFileSync(agent, 'utf8');
  const next = withWalk(text, fs.readFileSync(source, 'utf8'));
  if (next === null) throw new Error(`${agent}: no walk block - put ${MARK_START} and ${MARK_END} on their own lines.`);
  const changed = next.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
  if (changed && write) fs.writeFileSync(agent, next);
  return { changed };
}

// Every agent's blocks: the files that differed (and were rewritten, unless `write` is false).
function syncAgents({ write = true } = {}) {
  return { changed: agents.filter((agent) => syncAgent({ file: agent.file, names: agent.blocks }, write)).map((agent) => agent.file) };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  try {
    const { changed } = syncAgents({ write: !check });
    if (check && changed.length > 0) {
      process.stderr.write(`${changed.join(', ')} out of date with the references: run node ${__filename}\n`);
      process.exit(1);
    }
    process.stdout.write(changed.length > 0 ? `updated ${changed.join(', ')}\n` : 'agents are up to date\n');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { MARK_START, MARK_END, withWalk, withBlock, section, syncWalker, syncAgents, SOURCE, CROSS_SOURCE, AGENT, CROSS_AGENT, blocks };
