#!/usr/bin/env node
'use strict';

// The plugin's one SessionStart hook with the matcher "compact" (hooks/hooks.json).
//
// A compaction re-attaches only the head of a skill's SKILL.md, and a session resumed in a new
// process gets none of it back, so every skill whose run spans many turns says here where its
// run stands and how to pick it up again:
//   codeReview           skills/codeReview/scripts/review-hooks.cjs - the next batch, the drafts
//                        waiting, the walk card;
//   implementNewFeature  skills/implementNewFeature/scripts/pipeline-hooks.cjs - each task's
//                        step, the E2E slot, the waiter, the loop card.
// Each part decides alone whether the session drives a run of its skill; a session driving both
// gets both notes. A hook never breaks a session: every failure ends in exit 0 and no output.
//
// Usage: node compact-hook.cjs --event=compact   (the hook's JSON input on stdin)

const path = require('node:path');

const parts = [
  path.join(__dirname, '..', 'skills', 'codeReview', 'scripts', 'review-hooks.cjs'),
  path.join(__dirname, '..', 'skills', 'implementNewFeature', 'scripts', 'pipeline-hooks.cjs'),
];

function parseArgs(argv) {
  const args = { event: null };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && m[1] === 'event' && m[2] === 'compact' && !args.event) args.event = 'compact';
    else throw new Error(`Unknown argument: ${arg} (expected --event=compact).`);
  }
  if (!args.event) throw new Error('Missing --event=compact.');
  return args;
}

// `handlers` are the parts' onCompact functions; one that throws costs only its own note.
function onCompact(input, env = process.env, handlers = parts.map((file) => (...args) => require(file).onCompact(...args))) {
  const notes = [];
  for (const handler of handlers) {
    try {
      const out = handler(input, env);
      const text = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
      if (text) notes.push(text);
    } catch {}
  }
  return notes.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notes.join('\n\n') } } : null;
}

function readStdin(deadlineMs) {
  return new Promise((resolve) => {
    let text = '';
    const timer = setTimeout(() => resolve(text), deadlineMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(text); });
  });
}

async function main() {
  try {
    parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
  let out = null;
  try {
    out = onCompact(JSON.parse(await readStdin(3000)));
  } catch {
    out = null;
  }
  if (!out) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

module.exports = { parseArgs, onCompact, parts };

if (require.main === module) main();
