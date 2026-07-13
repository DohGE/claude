#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const STEP_NAMES = ['Requirements', 'Feature Refinement', 'Implementation',
  'Validation & E2E', 'Code Review'];
const STATUSES = ['waiting', 'in_progress', 'completed', 'failed'];
const MAX_BODY = 25 * 1024 * 1024;
const MAX_LOG = 50;

function initialState() {
  return {
    steps: STEP_NAMES.map((name, i) => ({
      id: i + 1, name, status: 'waiting', progress: null,
      currentOperation: '', report: null, log: []
    })),
    activeStep: 1, question: null, reviewSummary: null, summary: null
  };
}

// Clients are LLM sub-agents; despite instructions some post through
// PowerShell, which re-encodes bodies to UTF-16 (Out-File default) or the
// Windows ANSI codepage (cp1250 on Polish systems), so sniff instead of
// assuming UTF-8.
function decodeBody(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    buf = buf.slice(3);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_e) {
    try {
      return new TextDecoder('windows-1250').decode(buf);
    } catch (_e2) {
      return buf.toString('latin1'); // small-ICU Node builds
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(decodeBody(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function createApp(sessionDir, opts = {}) {
  const stateFile = path.join(sessionDir, 'pipeline-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_e) {
    state = initialState();
  }

  function persist() {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  function applyUpdate(body) {
    if (body.step !== undefined) {
      const step = state.steps.find(s => s.id === body.step);
      if (!step) throw new Error(`unknown step ${body.step}`);
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new Error(`bad status ${body.status}`);
        step.status = body.status;
      }
      if (body.progress !== undefined) step.progress = body.progress;
      if (body.currentOperation !== undefined) step.currentOperation = body.currentOperation;
      if (body.report !== undefined) step.report = body.report;
      if (body.logEntry) {
        step.log.push({ time: new Date().toISOString(), text: String(body.logEntry) });
        if (step.log.length > MAX_LOG) step.log.splice(0, step.log.length - MAX_LOG);
      }
    }
    if (body.activeStep !== undefined) state.activeStep = body.activeStep;
    if (body.question !== undefined) state.question = body.question;
    if (body.reviewSummary !== undefined) state.reviewSummary = body.reviewSummary;
    if (body.summary !== undefined) state.summary = body.summary;
    persist();
  }

  const answers = [];
  const waiters = [];

  function pushAnswer(a) {
    const w = waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(a); return; }
    answers.push(a);
  }

  function popAnswer(waitMs) {
    if (answers.length) return Promise.resolve(answers.shift());
    if (!waitMs) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        resolve(null);
      }, waitMs);
      waiters.push(waiter);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, state);
      }
      if (req.method === 'POST' && url.pathname === '/api/state') {
        const body = JSON.parse(await readBody(req) || '{}');
        try {
          applyUpdate(body);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = JSON.parse(await readBody(req) || '{}');
        pushAnswer(body);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/answer') {
        // 300 s cap: long polls resolve instantly when an answer arrives, so a
        // high cap only reduces the number of empty polls while the user thinks.
        const waitS = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 300);
        const answer = await popAnswer(waitS * 1000);
        return sendJson(res, 200, { answer });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!['mockups', 'contracts'].includes(body.category)) {
          return sendJson(res, 400, { error: 'bad category' });
        }
        const name = path.basename(String(body.filename || '').replace(/\\/g, '/'));
        if (!name || name === '.' || name === '..') {
          return sendJson(res, 400, { error: 'bad filename' });
        }
        const destDir = path.join(sessionDir, body.category);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, name);
        fs.writeFileSync(dest, Buffer.from(String(body.dataBase64 || ''), 'base64'));
        return sendJson(res, 200, { ok: true, path: dest });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth') {
        const body = JSON.parse(await readBody(req) || '{}');
        const login = String(body.login || '').trim();
        const password = String(body.password || '');
        if (!login || !password.trim()) {
          return sendJson(res, 400, { error: 'login and password are required' });
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        // Write-only secret: no GET counterpart, so credentials never travel
        // back over HTTP; agents read the file straight from disk.
        fs.writeFileSync(path.join(sessionDir, 'auth.json'),
          JSON.stringify({ login, password }), { mode: 0o600 });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        // Credentials must not outlive the pipeline: best-effort wipe on shutdown.
        try { fs.rmSync(path.join(sessionDir, 'auth.json'), { force: true }); } catch {}
        // Flush the response first, then close; keep-alive sockets would
        // otherwise hold the server open, so force-close them.
        res.on('finish', () => setImmediate(() => {
          server.close(() => { if (opts.onShutdown) opts.onShutdown(); });
          if (server.closeAllConnections) server.closeAllConnections();
        }));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  });

  return { server, getState: () => state };
}

function main() {
  const args = process.argv.slice(2);
  const get = flag => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const sessionDir = get('--session-dir');
  if (!sessionDir) {
    console.error('usage: node server.cjs --session-dir <dir> [--port <n>]');
    process.exit(1);
  }
  const app = createApp(path.resolve(sessionDir), { onShutdown: () => process.exit(0) });
  const port = parseInt(get('--port') || '0', 10) || 0;
  app.server.listen(port, '127.0.0.1', () => {
    const actual = app.server.address().port;
    fs.mkdirSync(path.resolve(sessionDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(sessionDir), 'server.json'),
      JSON.stringify({ port: actual, pid: process.pid }));
    console.log(JSON.stringify({ port: actual }));
  });
}

module.exports = { createApp, initialState };
if (require.main === module) main();
