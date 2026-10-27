#!/usr/bin/env node
'use strict';

// Waits for report parts to land on disk, for at most a few minutes, and says which of the
// two happened. The conversation that dispatched window walkers (SKILL.md Step 3, Windows)
// waits here instead of ending its turn: a sub-agent of the pipeline that ends its turn while
// its walker runs wakes the orchestrator above it with a "waiting on background work" notice -
// a whole-context turn for nothing - and a turn that sits idle past the prompt cache's lifetime
// pays for its context again when it resumes. A slice is kept under the cache's five minutes.
//
// Usage: node wait-part.cjs --path=<part file> [--path=<part file> ...] [--seconds=230] [--nonempty]
// Prints one line per path, a FIXED IDENTIFIER: `PART_READY <path>` or `PART_PENDING <path>`.
// With several paths - the last parts of the windows walked side by side - it returns as soon
// as one of them is ready, so the next window can take that walker's place.
// The implementNewFeature agents wait the same way for any file a background command writes at
// its end - a `checks.cjs` result redirected to a file - and `--nonempty` then waits for its first
// byte, because a shell redirect creates the file the moment the command starts.

const fs = require('node:fs');

const pollMs = 2000;
const maxSeconds = 280;

function parseArgs(argv) {
  const args = { paths: [], seconds: 230, nonempty: false };
  for (const arg of argv) {
    if (arg === '--nonempty') { args.nonempty = true; continue; }
    const m = arg.match(/^--(path|seconds)=(.*)$/);
    if (!m) throw new Error(`Unknown argument ${arg} (expected --path=<part file> [--path=...] [--seconds=<n>])`);
    if (m[1] === 'path') args.paths.push(m[2]);
    else if (m[1] === 'seconds') args.seconds = Math.min(Math.max(Number(m[2]) || 0, 0), maxSeconds);
  }
  if (args.paths.length === 0 || args.paths.some((p) => !p)) throw new Error('--path=<part file> is required');
  // The single-path callers read `path`.
  args.path = args.paths[0];
  return args;
}

const hasBytes = (file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};

// `path` (one file) or `paths` (several); resolves to the lines to print, joined by newlines.
function waitPart({ path: file, paths, seconds, nonempty = false }, { exists = nonempty ? hasBytes : fs.existsSync, now = Date.now, sleep } = {}) {
  const files = paths && paths.length ? paths : [file];
  const until = now() + seconds * 1000;
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const lines = () => files.map((f) => `${exists(f) ? 'PART_READY' : 'PART_PENDING'} ${f}`).join('\n');
  return (async () => {
    for (;;) {
      if (files.some((f) => exists(f)) || now() >= until) return lines();
      await pause(Math.min(pollMs, Math.max(until - now(), 0)));
    }
  })();
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  waitPart(args).then((line) => process.stdout.write(`${line}\n`));
}

module.exports = { parseArgs, waitPart, maxSeconds };
