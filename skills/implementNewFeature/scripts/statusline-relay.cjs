#!/usr/bin/env node
'use strict';

// Claude Code's status line command, wrapped: `node statusline-relay.cjs <your command>`.
// Each update Claude Code sends goes on unchanged to the command named after this script -
// whatever that prints is the status line, as before - and is kept as the session's snapshot
// for the stepper's usage corner (usage.cjs). The status line is the one place the session's
// limits, model and effort reach outside Claude Code.
//
// It never becomes what breaks the status line: a snapshot that cannot be written is skipped,
// and the wrapped command gets the update even when this could not read it.

const { spawn } = require('node:child_process');
const { writeSnapshot } = require('./usage.cjs');

// One argument is a whole command line - `statusline-relay.cjs "ccstatusline --flag"`, the
// form a settings.json string makes easy to write. Several are joined, the ones with spaces or
// quotes in them quoted, so a path of `C:/Program Files/...` stays one argument.
function commandOf(args) {
  if (args.length === 1) return args[0];
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

function relay(input, args, { dir, stdout = 'inherit' } = {}) {
  try {
    writeSnapshot(JSON.parse(input.toString('utf8')), dir);
  } catch {}
  if (!args.length) return Promise.resolve(0);
  return new Promise((resolve) => {
    // Through the shell: `ccstatusline` is an npm shim, a `.cmd` on Windows, which only a
    // shell resolves.
    const child = spawn(commandOf(args), { shell: true, stdio: ['pipe', stdout, 'inherit'], windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code == null ? 1 : code));
    // A command that exits without reading its input must not take this one down with EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', async () => {
    process.exitCode = await relay(Buffer.concat(chunks), process.argv.slice(2));
  });
}

module.exports = { commandOf, relay };
