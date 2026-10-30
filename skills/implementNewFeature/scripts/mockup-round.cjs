#!/usr/bin/env node
'use strict';

// Puts one mockup round on the stepper (references/steps/3-mockups.md): the screens of the
// manifest, the round's summary, the screenshots, and the progress - in one call. The orchestrator
// used to copy every screen of the agent's JSON into a POST body by hand, round after round (46
// states on one run, seven rounds), and to take the screenshots and word the notes itself; now
// nothing of the round passes through its context but this script's few lines.
//
// A round whose screens load a file they do not inline - a stylesheet, a font - is held back
// instead: the preview would show it unstyled, as four rounds of one run did before anyone saw
// why. The orchestrator sends it back to the mockup agent, and posts it anyway only when the
// agent cannot inline it (`--allow-external`).
//
// The summary is the one the agent wrote to generated-mockups/round.md for this round.
//
// Usage: node mockup-round.cjs --task-dir=<SESSION>/tasks/<id> --port=<n> --task=<id> --round=<n>
//          [--artifact-url=<url>] [--artifact-note=<text>] [--allow-external]
// Prints (FIXED IDENTIFIERS): `ROUND_POSTED <screens>`, `ROUND_HELD <n> <file or url>…` or
// `ROUND_FAILED <reason>`, then the screenshot script's own line.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MOCKUP_STEP = 3;

function parseArgs(argv) {
  const args = { taskDir: '', port: 0, task: '', round: 0, artifactUrl: '', artifactNote: '', allowExternal: false };
  for (const arg of argv) {
    if (arg === '--allow-external') { args.allowExternal = true; continue; }
    const m = arg.match(/^--([a-z-]+)=([\s\S]+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'round') args.round = Number(m[2]);
    else if (m[1] === 'artifact-url') args.artifactUrl = m[2];
    else if (m[1] === 'artifact-note') args.artifactNote = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.taskDir) throw new Error('--task-dir is required');
  if (!(args.port > 0)) throw new Error('--port is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task is required');
  if (!(args.round >= 1)) throw new Error('--round=<n> (from 1) is required');
  return args;
}

function takeScreenshots(taskDir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'screenshot-mockups.cjs'), taskDir], { encoding: 'utf8' });
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  const shot = lines.find((l) => /^SCREENSHOTS(_FAILED)? /.test(l))
    || `SCREENSHOTS_FAILED ${String(r.stderr || 'the screenshot script printed nothing').split('\n')[0]}`;
  const external = lines.find((l) => l.startsWith('EXTERNAL_REFS ')) || '';
  return { shot, external };
}

function post(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.end(data);
  });
}

async function postRound(options, seams = {}) {
  const dir = path.join(options.taskDir, 'generated-mockups');
  let screens;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    screens = (manifest && Array.isArray(manifest.screens) ? manifest.screens : [])
      .filter((s) => s && s.id && s.file).map(({ id, view, title, file }) => ({ id, view, title, file }));
  } catch (err) {
    return [`ROUND_FAILED no readable generated-mockups/manifest.json (${err.code || err.message})`];
  }
  if (!screens.length) return ['ROUND_FAILED the manifest lists no screens'];
  let summary = '';
  try {
    summary = fs.readFileSync(path.join(dir, 'round.md'), 'utf8').trim();
  } catch {
    summary = '';
  }
  if (!summary) summary = `Mockups, round ${options.round}.`;

  const { shot, external } = (seams.screenshots || takeScreenshots)(options.taskDir);
  if (external && !options.allowExternal) {
    return [`ROUND_HELD ${external.slice('EXTERNAL_REFS '.length)}`, shot];
  }
  const notes = [];
  if (shot.startsWith('SCREENSHOTS_FAILED')) notes.push(`Screenshots could not be taken: ${shot.slice('SCREENSHOTS_FAILED '.length)}`);
  if (external) notes.push(`Some screens load files they do not inline, so parts of them may show unstyled: ${external.split(' ').slice(2).join(', ')}`);
  if (options.artifactUrl) notes.push(`Claude artifact updated: ${options.artifactUrl}`);
  if (options.artifactNote) notes.push(options.artifactNote);
  const body = {
    taskId: options.task, step: MOCKUP_STEP, progress: Math.min(90, 20 + 10 * options.round),
    currentOperation: 'Waiting for your review',
    mockupReview: { text: summary, screens },
    mockupChat: { role: 'agent', text: [summary, ...notes].join('\n') },
  };
  if (options.artifactUrl) body.mockupArtifact = options.artifactUrl;
  const res = await (seams.post || post)(options.port, body);
  if (res.status !== 200) return [`ROUND_FAILED the stepper answered ${res.status}: ${String(res.text).slice(0, 300)}`, shot];
  return [`ROUND_POSTED ${screens.length}`, shot, ...(external ? [external] : [])];
}

if (require.main === module) {
  (async () => {
    let lines;
    try {
      lines = await postRound(parseArgs(process.argv.slice(2)));
    } catch (err) {
      lines = [`ROUND_FAILED ${(err && err.message) || err}`];
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = /^ROUND_POSTED/.test(lines[0]) ? 0 : 1;
  })();
}

module.exports = { parseArgs, postRound };
