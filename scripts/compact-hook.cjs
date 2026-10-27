#!/usr/bin/env node
'use strict';

// The plugin's SessionStart hooks with the matchers "compact" and "resume", and its Stop hook
// (hooks/hooks.json).
//
// A compaction re-attaches only the head of a skill's SKILL.md, and a session resumed in a new
// process gets none of it back, so every skill whose run spans many turns says here where its
// run stands and how to pick it up again:
//   codeReview           skills/codeReview/scripts/review-hooks.cjs - the next batch, the drafts
//                        waiting, the walk card;
//   implementNewFeature  skills/implementNewFeature/scripts/pipeline-hooks.cjs - each task's
//                        step, the E2E slot, the waiter, the loop card, the step file to read.
// A resumed session gets the same notes, and implementNewFeature also starts its stepper server
// again when it died with the previous session (pipeline-hooks.cjs onResume). At the end of a turn
// (Stop) an orchestrator whose conversation grew large is told that /compact is safe
// (pipeline-hooks.cjs onStop).
// Each part decides alone whether the session drives a run of its skill; a session driving both
// gets both notes. A hook never breaks a session: every failure ends in exit 0 and no output.
//
// Usage: node compact-hook.cjs --event=compact|resume|stop   (the hook's JSON input on stdin)

const path = require('node:path');

const parts = [
  path.join(__dirname, '..', 'skills', 'codeReview', 'scripts', 'review-hooks.cjs'),
  path.join(__dirname, '..', 'skills', 'implementNewFeature', 'scripts', 'pipeline-hooks.cjs'),
];
const events = ['compact', 'resume', 'stop'];

function parseArgs(argv) {
  const args = { event: null };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && m[1] === 'event' && events.includes(m[2]) && !args.event) args.event = m[2];
    else throw new Error(`Unknown argument: ${arg} (expected --event=${events.join('|')}).`);
  }
  if (!args.event) throw new Error(`Missing --event=${events.join('|')}.`);
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

// A resumed session: codeReview's position note as after a compaction, implementNewFeature's own.
function onResume(input, env = process.env, handlers = [
  (...args) => require(parts[0]).onCompact(...args),
  (...args) => require(parts[1]).onResume(...args),
]) {
  return onCompact(input, env, handlers);
}

function onStop(input, env = process.env, handler = (...args) => require(parts[1]).onStop(...args)) {
  try {
    return handler(input, env) || null;
  } catch {
    return null;
  }
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
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
  let out = null;
  try {
    const input = JSON.parse(await readStdin(3000));
    out = args.event === 'stop' ? onStop(input) : args.event === 'resume' ? onResume(input) : onCompact(input);
  } catch {
    out = null;
  }
  if (!out) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

module.exports = { parseArgs, onCompact, onResume, onStop, parts };

if (require.main === module) main();
