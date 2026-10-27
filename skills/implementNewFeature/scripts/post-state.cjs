#!/usr/bin/env node
'use strict';

// Several POST /api/state bodies in ONE tool call, in order. A step transition is often three
// bodies - complete one step, start the next, log on a third - and each curl is a turn of the
// orchestrator: the whole conversation re-read to send forty bytes. Node also sends the body as
// UTF-8 whatever shell it was typed in, which curl from PowerShell does not (SKILL.md, Encoding).
//
// Usage: node post-state.cjs --port <n> '<json body>' ['<json body>' ...]
//        node post-state.cjs --port <n> --file <bodies.json>     (a JSON array of bodies)
// Prints one line per body - `OK` or `ERROR <status> <message>` - and stops at the first error:
// a later body usually assumes the earlier one landed. Exit 1 when any failed.

const fs = require('node:fs');
const http = require('node:http');

function parseArgs(argv) {
  const args = { port: 0, bodies: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--file') {
      const list = JSON.parse(fs.readFileSync(argv[++i], 'utf8').replace(/^﻿/, ''));
      if (!Array.isArray(list)) throw new Error('--file must hold a JSON array of bodies');
      args.bodies.push(...list);
    } else args.bodies.push(JSON.parse(arg));
  }
  if (!args.port) throw new Error('usage: node post-state.cjs --port <n> <json body>... | --file <bodies.json>');
  if (!args.bodies.length) throw new Error('no body given');
  for (const body of args.bodies) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('every body is a JSON object');
    if (!body.taskId) throw new Error(`a body without "taskId": ${JSON.stringify(body)}`);
  }
  return args;
}

function postOne(port, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let message = text;
        try { message = JSON.parse(text).error || text; } catch {}
        resolve(res.statusCode === 200 ? 'OK' : `ERROR ${res.statusCode} ${message}`);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve(`ERROR 0 server unreachable (${err.message})`));
    req.end(data);
  });
}

async function postAll({ port, bodies }, write = (line) => process.stdout.write(`${line}\n`)) {
  for (const body of bodies) {
    const line = await postOne(port, body);
    write(line);
    if (line !== 'OK') return 1;
  }
  return 0;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  postAll(args).then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, postAll };
