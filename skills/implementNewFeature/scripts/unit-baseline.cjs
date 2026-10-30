#!/usr/bin/env node
'use strict';

// The project's unit specs that already fail on a task's base commit, recorded once for the whole
// run. A large suite takes twenty minutes and more, and the same pre-existing failures - a
// time-zone spec, say - were found, investigated and argued about by step 4, by validation and
// by the final review of every task, each time from scratch. The first agent that shows a failure
// is not the task's - its spec and the code it covers are untouched by the task's diff, and it
// fails the same way without the task's changes - records it here; every later step, and every
// task on the same base, reads the list and treats those failures as known.
//
// Usage: node unit-baseline.cjs record --run-dir=<run session dir> --base=<commit> --spec=<path>[,<path>…] --reason=<text> [--task=<id>]
//        node unit-baseline.cjs list   --run-dir=<run session dir> --base=<commit>
// Prints `RECORDED <n>`, or one `PREEXISTING <spec> - <reason>` line per known failure, or `NONE`.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'unit-baseline.json';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['record', 'list'].includes(command)) throw new Error('usage: node unit-baseline.cjs record|list --run-dir=<dir> --base=<commit> [--spec=<path>,…] [--reason=<text>] [--task=<id>]');
  const args = { command, runDir: '', base: '', specs: [], reason: '', task: '' };
  for (const arg of rest) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'run-dir') args.runDir = m[2];
    else if (m[1] === 'base') args.base = m[2].trim();
    else if (m[1] === 'spec') args.specs = m[2].split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
    else if (m[1] === 'reason') args.reason = m[2].trim();
    else if (m[1] === 'task') args.task = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.runDir) throw new Error('--run-dir is required');
  if (!args.base) throw new Error('--base=<commit> is required: a baseline belongs to one base commit');
  if (command === 'record' && (!args.specs.length || !args.reason)) throw new Error('record needs --spec and --reason');
  return args;
}

const read = (runDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, FILE), 'utf8'));
  } catch {
    return {};
  }
};

function record({ runDir, base, specs, reason, task }) {
  const all = read(runDir);
  const known = all[base] || [];
  for (const spec of specs) {
    if (!known.some((k) => k.spec === spec)) known.push({ spec, reason, task: task || null, recordedAt: new Date().toISOString() });
  }
  all[base] = known;
  fs.mkdirSync(runDir, { recursive: true });
  const tmp = path.join(runDir, `${FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, path.join(runDir, FILE));
  return [`RECORDED ${known.length}`];
}

function list({ runDir, base }) {
  const known = read(runDir)[base] || [];
  return known.length ? known.map((k) => `PREEXISTING ${k.spec} - ${k.reason}`) : ['NONE'];
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(`${(args.command === 'record' ? record(args) : list(args)).join('\n')}\n`);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, record, list };
