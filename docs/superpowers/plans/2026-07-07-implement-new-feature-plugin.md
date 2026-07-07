# Plugin `implement-new-feature` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin exposing the `/implementNewFeature` skill: a 5-step feature-implementation pipeline (Requirements → Refinement → Implementation → Validation & E2E → Code Review) driven by an orchestrator session, with a browser stepper UI served by a zero-dependency Node server.

**Architecture:** The plugin ships a Node `http` server (`server.cjs`) that holds pipeline state, serves a single-file vanilla-JS stepper UI, and bridges user answers to the orchestrator via a polled answer queue. The orchestrator (main Claude session following `SKILL.md`) spawns four sub-agents (prompts in `references/`) that report progress straight to the server via `curl POST /api/state`.

**Tech Stack:** Node ≥18 (`http`, `fs`, `path`, `node:test`), vanilla JS + HTML single file, PowerShell/bash launcher scripts, Claude Code plugin manifest.

**Spec:** `docs/superpowers/specs/2026-07-07-implement-new-feature-skill-design.md` — read it before starting any task.

## Global Constraints

- Server binds **only** to `127.0.0.1`; free port chosen automatically (`listen(0)`).
- Zero external npm dependencies anywhere (no `package.json` with deps; only Node built-ins).
- Plugin name: `implement-new-feature`; skill directory: `skills/implementNewFeature/`; invocation `/implement-new-feature:implementNewFeature`.
- Session directory in the *target* project: `.implementNewFeature/<timestamp>/`; must be gitignored there.
- UI step labels in English: `Requirements`, `Feature Refinement`, `Implementation`, `Validation & E2E`, `Code Review`; dynamic content language follows the conversation.
- Step statuses exactly: `waiting`, `in_progress`, `completed`, `failed`.
- The pipeline never commits in the target project; work happens on `feature/<slug>`; changes are staged at the end.
- Loop caps: 3 cycles in Steps 4 and 5, then `failed` + report.
- Commit messages in this repo end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All commands in plan steps are PowerShell 5.1-safe unless marked bash (no `&&`, use `;`).

## File Structure

```
D:\WebstormProjects\claude\
  .claude-plugin\
    plugin.json                                   ← Task 1
    marketplace.json                              ← Task 1
  skills\implementNewFeature\
    SKILL.md                                      ← Task 6
    references\
      refinement-agent.md                         ← Task 7
      implementation-agent.md                     ← Task 8
      validation-agent.md                         ← Task 9
      review-agent.md                             ← Task 9
    scripts\
      server.cjs                                  ← Tasks 2–3
      server.test.cjs                             ← Tasks 2–3
      ui\index.html                               ← Task 5
      start-server.ps1                            ← Task 4
      start-server.sh                             ← Task 4
```

Responsibilities: `server.cjs` = state store + HTTP API + static UI + persistence; `index.html` = whole stepper front-end; `SKILL.md` = orchestrator procedure; `references/*.md` = one self-contained prompt per sub-agent; launcher scripts = background start + port discovery.

---

### Task 1: Plugin scaffolding (manifest, marketplace, gitignore)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: plugin identity `implement-new-feature` used by every later task's paths; marketplace source `./` so `claude plugin marketplace add D:\WebstormProjects\claude` works.

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "implement-new-feature",
  "description": "Pipeline skill /implementNewFeature: requirements → refinement → implementation → validation & E2E → code review, with a browser stepper UI",
  "version": "0.1.0",
  "author": {
    "name": "DohGE"
  },
  "license": "MIT",
  "keywords": ["pipeline", "feature", "orchestrator", "stepper"]
}
```

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "implement-new-feature-local",
  "owner": {
    "name": "DohGE"
  },
  "plugins": [
    {
      "name": "implement-new-feature",
      "source": "./",
      "description": "Pipeline skill /implementNewFeature with browser stepper UI"
    }
  ]
}
```

- [ ] **Step 3: Append to `.gitignore`**

Append these lines to the existing `.gitignore` (keep existing content):

```
node_modules/
.implementNewFeature/
```

- [ ] **Step 4: Validate JSON syntax**

Run: `node -e "['.claude-plugin/plugin.json','.claude-plugin/marketplace.json'].forEach(f=>JSON.parse(require('fs').readFileSync(f,'utf8'))); console.log('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```powershell
git add .claude-plugin .gitignore; git commit -m "feat: scaffold implement-new-feature plugin manifest and local marketplace"
```

---

### Task 2: Server core — state store, persistence, `/api/state`

**Files:**
- Create: `skills/implementNewFeature/scripts/server.cjs`
- Test: `skills/implementNewFeature/scripts/server.test.cjs`

**Interfaces:**
- Produces: `createApp(sessionDir)` → `{ server: http.Server, getState(): object }`; `initialState(): object`; state shape consumed by UI (Task 5) and agents (Tasks 6–9):

```json
{
  "steps": [{ "id": 1, "name": "Requirements", "status": "waiting", "progress": null,
              "currentOperation": "", "report": null, "log": [] }],
  "activeStep": 1, "question": null, "reviewSummary": null, "summary": null
}
```

- `POST /api/state` body (all fields optional, merged): `{ "step": 1-5, "status", "progress", "currentOperation", "report", "logEntry", "activeStep", "question", "reviewSummary", "summary" }`.

- [ ] **Step 1: Write failing tests**

`skills/implementNewFeature/scripts/server.test.cjs`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('./server.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inf-'));
}

async function listen(app) {
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test('GET /api/state returns initial 5-step state', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.steps.length, 5);
  assert.equal(state.steps[0].name, 'Requirements');
  assert.equal(state.steps[4].name, 'Code Review');
  assert.ok(state.steps.every(s => s.status === 'waiting'));
  assert.equal(state.activeStep, 1);
});

test('POST /api/state merges updates and persists to pipeline-state.json', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 3, status: 'in_progress', progress: 40,
      currentOperation: 'Task 2/5', logEntry: 'started task 2', activeStep: 3 })
  });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[2].status, 'in_progress');
  assert.equal(state.steps[2].progress, 40);
  assert.equal(state.steps[2].currentOperation, 'Task 2/5');
  assert.equal(state.steps[2].log.length, 1);
  assert.equal(state.activeStep, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.equal(onDisk.steps[2].status, 'in_progress');
});

test('createApp reloads persisted state after restart', async t => {
  const dir = tmpDir();
  const app1 = createApp(dir);
  const base1 = await listen(app1);
  await fetch(`${base1}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 1, status: 'completed' })
  });
  await new Promise(r => app1.server.close(r));
  const app2 = createApp(dir);
  const base2 = await listen(app2);
  t.after(() => app2.server.close());
  const state = await (await fetch(`${base2}/api/state`)).json();
  assert.equal(state.steps[0].status, 'completed');
});

test('POST /api/state with unknown step returns 400', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 9, status: 'completed' })
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test skills/implementNewFeature/scripts/server.test.cjs`
Expected: FAIL — `Cannot find module './server.cjs'`

- [ ] **Step 3: Implement server core**

`skills/implementNewFeature/scripts/server.cjs`:

```js
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function createApp(sessionDir) {
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
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  });

  return { server, getState: () => state };
}

module.exports = { createApp, initialState };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test skills/implementNewFeature/scripts/server.test.cjs`
Expected: `# pass 4`, `# fail 0`

- [ ] **Step 5: Commit**

```powershell
git add skills/implementNewFeature/scripts; git commit -m "feat: stepper server core - state store, persistence, /api/state"
```

---

### Task 3: Server interaction — answer queue, uploads, static UI, CLI entry

**Files:**
- Modify: `skills/implementNewFeature/scripts/server.cjs` (extend Task 2 code)
- Test: `skills/implementNewFeature/scripts/server.test.cjs` (append tests)

**Interfaces:**
- Consumes: `createApp`, `readBody`, `sendJson`, `persist` from Task 2.
- Produces:
  - `POST /api/answer` body: `{ "kind": "step1"|"answer"|"decision", ... }` → queued FIFO, response `{ "ok": true }`.
  - `GET /api/answer?wait=<seconds>` → `{ "answer": <object|null> }` (long-poll; pops oldest).
  - `POST /api/upload` body: `{ "category": "mockups"|"contracts", "filename", "dataBase64" }` → file saved to `<sessionDir>/<category>/<basename>`, response `{ "ok": true, "path": "<absolute path>" }`.
  - `GET /` → `ui/index.html`.
  - CLI: `node server.cjs --session-dir <dir> [--port <n>]` → prints `{"port":N}` on stdout, writes `<sessionDir>/server.json` = `{ "port": N, "pid": <pid> }`.

- [ ] **Step 1: Append failing tests**

Append to `server.test.cjs`:

```js
test('answer queue is FIFO and empties', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const post = a => fetch(`${base}/api/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(a)
  });
  await post({ kind: 'answer', text: 'first' });
  await post({ kind: 'answer', text: 'second' });
  const a1 = await (await fetch(`${base}/api/answer`)).json();
  const a2 = await (await fetch(`${base}/api/answer`)).json();
  const a3 = await (await fetch(`${base}/api/answer`)).json();
  assert.equal(a1.answer.text, 'first');
  assert.equal(a2.answer.text, 'second');
  assert.equal(a3.answer, null);
});

test('GET /api/answer?wait=2 long-polls until an answer arrives', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  setTimeout(() => {
    fetch(`${base}/api/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decision', decision: 'approve' })
    });
  }, 300);
  const started = Date.now();
  const got = await (await fetch(`${base}/api/answer?wait=2`)).json();
  assert.equal(got.answer.decision, 'approve');
  assert.ok(Date.now() - started >= 250, 'should have waited for the POST');
});

test('POST /api/upload writes sanitized file into session dir', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'mockups', filename: '..\\..\\evil.png',
      dataBase64: Buffer.from('img-bytes').toString('base64') })
  });
  assert.equal(res.status, 200);
  const saved = path.join(dir, 'mockups', 'evil.png');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'img-bytes');
});

test('POST /api/upload rejects unknown category', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'secrets', filename: 'x', dataBase64: 'aa' })
  });
  assert.equal(res.status, 400);
});

test('GET / serves the stepper UI', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Requirements/);
});
```

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `node --test skills/implementNewFeature/scripts/server.test.cjs`
Expected: 4 pass (Task 2), 5 fail (404s / missing file).

Note: `GET /` test needs `ui/index.html` to exist. Create a placeholder now (replaced in Task 5):

`skills/implementNewFeature/scripts/ui/index.html`:

```html
<!doctype html><html><head><meta charset="utf-8"><title>implementNewFeature</title></head>
<body>Requirements placeholder</body></html>
```

- [ ] **Step 3: Extend `server.cjs`**

Inside `createApp`, after `applyUpdate`, add the answer queue and a waiter mechanism:

```js
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
```

In the request handler, before the final 404, add routes:

```js
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = JSON.parse(await readBody(req) || '{}');
        pushAnswer(body);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/answer') {
        const waitS = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 120);
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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
```

At the bottom of the file, replace `module.exports = ...` with the CLI entry:

```js
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
  const app = createApp(path.resolve(sessionDir));
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
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test skills/implementNewFeature/scripts/server.test.cjs`
Expected: `# pass 9`, `# fail 0`

- [ ] **Step 5: Commit**

```powershell
git add skills/implementNewFeature/scripts; git commit -m "feat: stepper server - answer queue, uploads, static UI, CLI entry"
```

---

### Task 4: Launcher scripts (background start + port discovery)

**Files:**
- Create: `skills/implementNewFeature/scripts/start-server.ps1`
- Create: `skills/implementNewFeature/scripts/start-server.sh`

**Interfaces:**
- Consumes: `server.cjs` CLI (`--session-dir`, `server.json` with `{port,pid}`) from Task 3.
- Produces: launcher contract used by SKILL.md (Task 6) — run script with session dir, get `{"port":N}` on stdout, browser opened when `-Open`/`--open` given. Stop = kill PID from `server.json`.

- [ ] **Step 1: Write `start-server.ps1`**

```powershell
param(
  [Parameter(Mandatory = $true)][string]$SessionDir,
  [switch]$Open
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $scriptDir 'server.cjs'
New-Item -ItemType Directory -Force $SessionDir | Out-Null
$serverJson = Join-Path $SessionDir 'server.json'
if (Test-Path $serverJson) { Remove-Item $serverJson -Force }

Start-Process -FilePath 'node' `
  -ArgumentList @($serverJs, '--session-dir', $SessionDir) `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path $serverJson)) {
  if ((Get-Date) -gt $deadline) { Write-Error 'server did not start within 15s'; exit 1 }
  Start-Sleep -Milliseconds 200
}
$info = Get-Content $serverJson -Raw | ConvertFrom-Json
if ($Open) { Start-Process "http://127.0.0.1:$($info.port)/" }
Write-Output ('{"port":' + $info.port + '}')
```

- [ ] **Step 2: Write `start-server.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
SESSION_DIR=""
OPEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -n "$SESSION_DIR" ] || { echo "usage: start-server.sh --session-dir <dir> [--open]" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SESSION_DIR"
rm -f "$SESSION_DIR/server.json"
nohup node "$SCRIPT_DIR/server.cjs" --session-dir "$SESSION_DIR" \
  > "$SESSION_DIR/server.log" 2>&1 &
for _ in $(seq 1 75); do
  [ -f "$SESSION_DIR/server.json" ] && break
  sleep 0.2
done
[ -f "$SESSION_DIR/server.json" ] || { echo "server did not start" >&2; exit 1; }
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port)" "$SESSION_DIR/server.json")
if [ "$OPEN" = 1 ]; then
  (xdg-open "http://127.0.0.1:$PORT/" || open "http://127.0.0.1:$PORT/") >/dev/null 2>&1 || true
fi
echo "{\"port\":$PORT}"
```

- [ ] **Step 3: Verify launcher end-to-end (Windows)**

```powershell
$out = powershell -NoProfile -File skills/implementNewFeature/scripts/start-server.ps1 -SessionDir "$env:TEMP\inf-smoke"
$port = ($out | ConvertFrom-Json).port
Invoke-RestMethod "http://127.0.0.1:$port/api/state" | ConvertTo-Json -Depth 3
$pid2 = (Get-Content "$env:TEMP\inf-smoke\server.json" -Raw | ConvertFrom-Json).pid
Stop-Process -Id $pid2 -Force
Remove-Item -Recurse -Force "$env:TEMP\inf-smoke"
```

Expected: JSON with 5 steps, all `waiting`; process stops cleanly.

- [ ] **Step 4: Commit**

```powershell
git add skills/implementNewFeature/scripts; git commit -m "feat: background launcher scripts with port discovery"
```

---

### Task 5: Stepper UI (`ui/index.html`)

**Files:**
- Modify: `skills/implementNewFeature/scripts/ui/index.html` (replace Task 3 placeholder)

**Interfaces:**
- Consumes: `GET /api/state` (1 s polling), `POST /api/answer`, `POST /api/upload` from Tasks 2–3.
- Produces answers the orchestrator (Task 6) reads:
  - `{ "kind": "step1", "taskDescription", "businessRequirements", "contractsText", "mockups": [names], "contracts": [names] }`
  - `{ "kind": "answer", "questionId", "value" }`
  - `{ "kind": "decision", "decision": "approve"|"feedback"|"retry"|"finish", "text"? }`
- Expects in state: `question = { id, text, options?: [string] }`, `reviewSummary = { text }`, `summary = { changes: [], features: [], tests, mockupComparison, codeReview, finalStatus }`, per-step `report` (string) when failed.

- [ ] **Step 1: Write HTML + CSS shell (empty `<script>` for now)**

`skills/implementNewFeature/scripts/ui/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>implementNewFeature</title>
<style>
  :root {
    --waiting:#9aa0a6; --in_progress:#1a73e8; --completed:#188038; --failed:#d93025;
    --bg:#f6f8fa; --card:#fff; --border:#dde1e6; --text:#202124;
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0 0 24px; }
  .stepper { display:flex; gap:4px; margin-bottom:24px; }
  .step { flex:1; background:var(--card); border:1px solid var(--border); border-radius:8px;
          padding:10px 8px; text-align:center; position:relative; }
  .step .num { display:inline-flex; align-items:center; justify-content:center;
          width:26px; height:26px; border-radius:50%; color:#fff; font-size:13px;
          background:var(--waiting); margin-bottom:6px; }
  .step.in_progress .num { background:var(--in_progress); animation:pulse 1.5s infinite; }
  .step.completed .num { background:var(--completed); }
  .step.failed .num { background:var(--failed); }
  @keyframes pulse { 50% { opacity:.55; } }
  .step .name { font-size:12.5px; font-weight:600; }
  .step .badge { display:block; font-size:10.5px; margin-top:4px; text-transform:uppercase;
          letter-spacing:.4px; color:var(--waiting); }
  .step.in_progress .badge { color:var(--in_progress); }
  .step.completed .badge { color:var(--completed); }
  .step.failed .badge { color:var(--failed); }
  .panel { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:20px; }
  .panel h2 { margin:0 0 12px; font-size:16px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
  label .req { color:var(--failed); }
  textarea, input[type=file] { width:100%; font:inherit; }
  textarea { min-height:90px; border:1px solid var(--border); border-radius:6px; padding:8px; resize:vertical; }
  button { font:inherit; font-weight:600; border:0; border-radius:6px; padding:9px 18px;
           cursor:pointer; background:var(--in_progress); color:#fff; margin-top:14px; }
  button:disabled { background:var(--waiting); cursor:not-allowed; }
  button.secondary { background:#5f6368; }
  button.danger { background:var(--failed); }
  .options button { display:block; width:100%; text-align:left; background:var(--card);
           color:var(--text); border:1px solid var(--border); margin-top:8px; }
  .options button:hover { border-color:var(--in_progress); }
  .bar { height:10px; background:var(--bg); border:1px solid var(--border); border-radius:6px;
         overflow:hidden; margin:8px 0 4px; }
  .bar > div { height:100%; background:var(--in_progress); width:0; transition:width .4s; }
  .op { font-size:13px; color:#5f6368; margin:6px 0 12px; }
  .log { list-style:none; margin:8px 0 0; padding:0; font-size:12.5px; }
  .log li { padding:4px 0; border-top:1px solid var(--bg); color:#3c4043; }
  .log time { color:var(--waiting); margin-right:8px; font-variant-numeric:tabular-nums; }
  pre.report, pre.summary-text { white-space:pre-wrap; background:var(--bg); border:1px solid var(--border);
        border-radius:6px; padding:12px; font-size:13px; }
  .muted { color:#5f6368; font-size:13px; }
  .summary section { margin-bottom:16px; }
  .summary h3 { font-size:14px; margin:0 0 6px; }
  .status-final { font-size:15px; font-weight:700; }
</style>
</head>
<body>
<div class="wrap">
  <h1>implementNewFeature</h1>
  <div class="stepper" id="stepper"></div>
  <div class="panel" id="panel"><p class="muted">Connecting…</p></div>
</div>
<script>
/* filled in Step 2 */
</script>
</body>
</html>
```

- [ ] **Step 2: Fill in the `<script>` block**

Replace `/* filled in Step 2 */` with:

```js
'use strict';
const STEP_NAMES = ['Requirements', 'Feature Refinement', 'Implementation',
  'Validation & E2E', 'Code Review'];
const BADGE = { waiting: 'Waiting', in_progress: 'In Progress',
  completed: 'Completed', failed: 'Failed' };
let lastSig = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function toB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function postJson(url, body) {
  await fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const sendAnswer = payload => postJson('/api/answer', payload);

async function tick() {
  let state;
  try {
    state = await (await fetch('/api/state')).json();
  } catch (_e) {
    $('#panel').innerHTML = '<p class="muted">Server unreachable — retrying…</p>';
    lastSig = null;
    return;
  }
  renderStepper(state);
  renderPanel(state);
}

function renderStepper(state) {
  $('#stepper').innerHTML = state.steps.map(s => `
    <div class="step ${s.status}">
      <span class="num">${s.id}</span>
      <span class="name">${esc(s.name || STEP_NAMES[s.id - 1])}</span>
      <span class="badge">${BADGE[s.status] || s.status}</span>
    </div>`).join('');
}

function sig(state) {
  const step = state.steps[state.activeStep - 1] || state.steps[0];
  return [state.activeStep, step.status,
    state.question ? state.question.id : '',
    state.reviewSummary ? '1' : '', state.summary ? '1' : ''].join('|');
}

function renderPanel(state) {
  const s = sig(state);
  const step = state.steps[state.activeStep - 1] || state.steps[0];
  if (s === lastSig) { updateDynamic(step); return; }
  lastSig = s;
  if (state.summary) return renderSummary(state.summary);
  if (step.status === 'failed') return renderFailed(step);
  if (state.activeStep === 1) return renderStep1(step);
  if (state.activeStep === 2) {
    if (state.question) return renderQuestion(state.question);
    if (state.reviewSummary) return renderReview(state.reviewSummary);
  }
  renderProgress(step);
}

function renderStep1(step) {
  if (step.status !== 'in_progress') {
    $('#panel').innerHTML = '<p class="muted">Waiting for the pipeline…</p>';
    return;
  }
  $('#panel').innerHTML = `
    <h2>Requirements</h2>
    <label>Task description <span class="req">*</span></label>
    <textarea id="task"></textarea>
    <label>Business requirements <span class="req">*</span></label>
    <textarea id="biz"></textarea>
    <label>Mockups (optional)</label>
    <input type="file" id="mockups" multiple accept="image/*,.pdf">
    <label>API contracts / specs (optional — files or pasted text)</label>
    <input type="file" id="contracts" multiple>
    <textarea id="contractsText" placeholder="…or paste contracts here"></textarea>
    <button id="next" disabled>Next</button>`;
  const gate = () => {
    $('#next').disabled = !($('#task').value.trim() && $('#biz').value.trim());
  };
  $('#task').addEventListener('input', gate);
  $('#biz').addEventListener('input', gate);
  $('#next').addEventListener('click', async () => {
    $('#next').disabled = true;
    $('#next').textContent = 'Sending…';
    const upload = async (cat, input) => {
      const names = [];
      for (const f of input.files) {
        await postJson('/api/upload',
          { category: cat, filename: f.name, dataBase64: await toB64(f) });
        names.push(f.name);
      }
      return names;
    };
    const mockups = await upload('mockups', $('#mockups'));
    const contracts = await upload('contracts', $('#contracts'));
    await sendAnswer({ kind: 'step1',
      taskDescription: $('#task').value.trim(),
      businessRequirements: $('#biz').value.trim(),
      contractsText: $('#contractsText').value.trim(),
      mockups, contracts });
    $('#panel').innerHTML = '<p class="muted">Submitted — starting refinement…</p>';
  });
}

function renderQuestion(q) {
  const opts = (q.options || []).map((o, i) =>
    `<button data-opt="${i}">${esc(o)}</button>`).join('');
  $('#panel').innerHTML = `
    <h2>Feature Refinement</h2>
    <p>${esc(q.text)}</p>
    <div class="options">${opts}</div>
    <label>Answer</label>
    <textarea id="freeAnswer"></textarea>
    <button id="send">Send answer</button>`;
  document.querySelectorAll('[data-opt]').forEach(btn =>
    btn.addEventListener('click', () =>
      sendAnswer({ kind: 'answer', questionId: q.id, value: q.options[+btn.dataset.opt] })));
  $('#send').addEventListener('click', () => {
    const v = $('#freeAnswer').value.trim();
    if (v) sendAnswer({ kind: 'answer', questionId: q.id, value: v });
  });
}

function renderReview(review) {
  $('#panel').innerHTML = `
    <h2>Plan review</h2>
    <pre class="summary-text">${esc(review.text)}</pre>
    <button id="approve">Approve</button>
    <label>…or request changes</label>
    <textarea id="feedback"></textarea>
    <button id="sendFeedback" class="secondary">Send feedback</button>`;
  $('#approve').addEventListener('click', () =>
    sendAnswer({ kind: 'decision', decision: 'approve' }));
  $('#sendFeedback').addEventListener('click', () => {
    const t = $('#feedback').value.trim();
    if (t) sendAnswer({ kind: 'decision', decision: 'feedback', text: t });
  });
}

function renderProgress(step) {
  $('#panel').innerHTML = `
    <h2>${esc(step.name)}</h2>
    <div class="bar"><div id="barFill"></div></div>
    <div class="op" id="op"></div>
    <ul class="log" id="log"></ul>`;
  updateDynamic(step);
}

function updateDynamic(step) {
  const fill = $('#barFill');
  if (fill) fill.style.width = `${step.progress || 0}%`;
  const op = $('#op');
  if (op) op.textContent = (step.progress != null ? `${step.progress}% — ` : '')
    + (step.currentOperation || '');
  const log = $('#log');
  if (log) log.innerHTML = step.log.slice(-15).reverse().map(e =>
    `<li><time>${esc(e.time.slice(11, 19))}</time>${esc(e.text)}</li>`).join('');
}

function renderFailed(step) {
  $('#panel').innerHTML = `
    <h2>${esc(step.name)} — failed</h2>
    <pre class="report">${esc(step.report || 'No report provided.')}</pre>
    <button id="retry" class="danger">Retry step</button>
    <button id="finish" class="secondary">Finish</button>`;
  $('#retry').addEventListener('click', () =>
    sendAnswer({ kind: 'decision', decision: 'retry' }));
  $('#finish').addEventListener('click', () =>
    sendAnswer({ kind: 'decision', decision: 'finish' }));
}

function renderSummary(sum) {
  const list = items => `<ul>${(items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const block = text => `<pre class="summary-text">${esc(text || '—')}</pre>`;
  $('#panel').innerHTML = `<div class="summary">
    <h2>Pipeline summary</h2>
    <section><h3>Final status</h3>
      <p class="status-final">${esc(sum.finalStatus || '')}</p></section>
    <section><h3>Changes</h3>${list(sum.changes)}</section>
    <section><h3>Implemented features</h3>${list(sum.features)}</section>
    <section><h3>Test results</h3>${block(sum.tests)}</section>
    <section><h3>Mockup comparison</h3>${block(sum.mockupComparison)}</section>
    <section><h3>Code review</h3>${block(sum.codeReview)}</section>
  </div>`;
}

setInterval(tick, 1000);
tick();
```

- [ ] **Step 3: Server tests still pass**

Run: `node --test skills/implementNewFeature/scripts/server.test.cjs`
Expected: `# pass 9` (the `GET /` test matches the `Requirements` literal in `STEP_NAMES`).

- [ ] **Step 4: Manual UI verification**

```powershell
$out = powershell -NoProfile -File skills/implementNewFeature/scripts/start-server.ps1 -SessionDir "$env:TEMP\inf-ui" -Open
$port = ($out | ConvertFrom-Json).port
$H = @{ 'content-type' = 'application/json' }
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"step":1,"status":"in_progress"}'
```

In the browser: form appears, **Next** enabled only with both required fields; submit, then:

```powershell
Invoke-RestMethod "http://127.0.0.1:$port/api/answer" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"step":1,"status":"completed"}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"activeStep":2,"step":2,"status":"in_progress","question":{"id":"q1","text":"Które podejście?","options":["A","B"]}}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"question":null,"reviewSummary":{"text":"Plan: ..."}}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"reviewSummary":null,"activeStep":3,"step":3,"status":"in_progress","progress":40,"currentOperation":"Task 2/5","logEntry":"task 1 done"}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"step":4,"status":"failed","activeStep":4,"report":"2 tests failing"}'
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/state" -Headers $H -Body '{"summary":{"finalStatus":"Completed","changes":["a.ts"],"features":["login"],"tests":"12 passed","mockupComparison":"n/a","codeReview":"0 findings"}}'
```

Verify each state renders (question buttons, Approve view, progress bar, Failed view with Retry/Finish, summary screen). Then stop:

```powershell
$pid2 = (Get-Content "$env:TEMP\inf-ui\server.json" -Raw | ConvertFrom-Json).pid
Stop-Process -Id $pid2 -Force; Remove-Item -Recurse -Force "$env:TEMP\inf-ui"
```

- [ ] **Step 5: Commit**

```powershell
git add skills/implementNewFeature/scripts/ui; git commit -m "feat: single-file stepper UI"
```

---

### Task 6: Orchestrator instructions (`SKILL.md`)

**Files:**
- Create: `skills/implementNewFeature/SKILL.md`

**Interfaces:**
- Consumes: launcher contract (Task 4), server API (Tasks 2–3), UI answer payloads (Task 5), agent prompts `references/*.md` (Tasks 7–9).
- Produces: the complete orchestrator procedure Claude follows when the user invokes `/implementNewFeature`.

- [ ] **Step 1: Write `SKILL.md`**

````markdown
---
name: implementNewFeature
description: Use when the user wants a complete feature implemented end-to-end - runs a 5-step pipeline (Requirements, Feature Refinement, Implementation, Validation & E2E, Code Review) with a browser stepper UI; the orchestrator coordinates sub-agents and keeps the main context clean
---

# implementNewFeature — pipeline orchestrator

You are the **orchestrator**. You never implement, test, or review code yourself.
Sub-agents do all heavy work; you hold only: step statuses, artifact paths, short summaries.
Dynamic texts (questions, reports, summary) stay in the user's conversation language; UI chrome is English.

## Hard rules

- NEVER paste file contents (spec, plan, code) into your own context — pass **paths** to sub-agents.
- Every sub-agent ends its final message with a single JSON object: `{"type":"question"|"result"|"error", ...}`. Parse it; ignore prose around it.
- Spawn sub-agents with the Agent tool (`subagent_type: "general-purpose"`); continue an existing one with SendMessage (its context is preserved).
- The pipeline NEVER commits in the target project. Work happens on a feature branch; stage changes at the very end.
- Update the stepper before and after every phase so the browser always reflects reality.

## Setup

1. `SKILL_DIR` = this skill's base directory (given in the skill header). `PROJECT` = current working directory.
2. `SESSION = <PROJECT>/.implementNewFeature/<yyyyMMdd-HHmmss>` — create it.
3. Ensure `.implementNewFeature/` is listed in the project's `.gitignore` (append if missing; create the file if absent).
4. Start the server (pick the script for the OS) and capture the port:
   - Windows: `powershell -NoProfile -File "<SKILL_DIR>/scripts/start-server.ps1" -SessionDir "<SESSION>" -Open`
   - POSIX: `bash "<SKILL_DIR>/scripts/start-server.sh" --session-dir "<SESSION>" --open`
   - stdout is `{"port":N}`; remember `PORT`. Tell the user the stepper is open at `http://127.0.0.1:PORT/`.

## Server helpers (use exactly these shapes)

- Update state:
  `curl -s -X POST http://127.0.0.1:PORT/api/state -H "content-type: application/json" -d "<json>"`
  Fields: `{"step":N,"status":"waiting|in_progress|completed|failed","progress":0-100,"currentOperation":"...","report":"...","logEntry":"...","activeStep":N,"question":{...}|null,"reviewSummary":{...}|null,"summary":{...}}`
- Wait for a user answer (long-poll, repeat until non-null):
  `curl -s "http://127.0.0.1:PORT/api/answer?wait=60"` → `{"answer":{...}|null}`
  Repeat the call in a loop while `answer` is null. If curl cannot connect, the server died: re-run the launcher (state reloads from `pipeline-state.json`) and continue.

## Step 1 — Requirements (interactive)

1. POST `{"step":1,"status":"in_progress","activeStep":1}`.
2. Poll answers until `kind=="step1"`.
3. Write `<SESSION>/requirements.md`:

   ```markdown
   # Requirements

   ## Task description
   <taskDescription>

   ## Business requirements
   <businessRequirements>

   ## Contracts (pasted)
   <contractsText or "—">

   ## Uploaded files
   Mockups: <mockups list or "—">  |  Contracts: <contracts list or "—">
   ```

   (Uploads already sit in `<SESSION>/mockups/` and `<SESSION>/contracts/`.)
4. POST `{"step":1,"status":"completed"}` then `{"activeStep":2}`.

## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"step":2,"status":"in_progress","activeStep":2,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent: prompt = contents of `<SKILL_DIR>/references/refinement-agent.md` with placeholders `{{SESSION}}`, `{{PORT}}`, `{{PROJECT}}`, `{{LANGUAGE}}` substituted.
3. Loop on the agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"question":{...}}`, poll answers until `kind=="answer"`, POST `{"question":null}`, SendMessage the answer text to the agent.
   - `{"type":"result","summary"}` → spec/plan/checklist now exist in `<SESSION>`. Go to 4.
   - `{"type":"error","report"}` → failure protocol (below) for step 2.
4. Gate: POST `{"reviewSummary":{"text":"<summary>"}}`; poll answers until `kind=="decision"`:
   - `approve` → POST `{"reviewSummary":null,"step":2,"status":"completed"}`; continue.
   - `feedback` → SendMessage the feedback to the agent; back to 3.

## Step 3 — Implementation (view-only)

1. Derive `SLUG` from the feature title (first line of `<SESSION>/spec.md`): lowercase, ASCII, spaces→`-`, strip other chars, max 40 chars. `git checkout -b feature/<SLUG>`.
2. POST `{"step":3,"status":"in_progress","activeStep":3,"progress":0}`.
3. Spawn the implementation agent from `references/implementation-agent.md` (same placeholder substitution). It reports progress itself via POST /api/state.
4. Final JSON `{"type":"result","filesChanged":[...],"summary"}` → POST `{"step":3,"status":"completed","progress":100}`. Keep `filesChanged` count and summary only. `error` → failure protocol.

## Step 4 — Validation & E2E (view-only)

1. POST `{"step":4,"status":"in_progress","activeStep":4,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`.
3. `{"type":"result","compliance":NN,"testsSummary","mockupSummary"}` with `compliance>=99` → POST completed. `{"type":"error","report"}` (e.g. <99% after 3 cycles) → failure protocol.

## Step 5 — Code Review (view-only)

1. POST `{"step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md`.
3. `{"type":"result","findingsFixed":N,"reviewSummary"}` → POST completed. `error` → failure protocol.

## Failure protocol (any step)

1. POST `{"step":N,"status":"failed","report":"<report>"}`.
2. Poll answers until `kind=="decision"`:
   - `retry` → POST `{"step":N,"status":"in_progress","report":null}`; re-spawn that step's agent **fresh** (new Agent call, same prompt + note about the previous failure report path).
   - `finish` → write the final summary (below) with `finalStatus:"Failed at step N"`, then stop.

## Final summary

1. Collect from step results only (no file contents): changes, features, tests, mockup comparison, review results.
2. POST `{"summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","mockupComparison":"...","codeReview":"..."}}`.
3. Print the same summary in the terminal (user's language).
4. Stage everything: `git add -A` (already done by step 5 agent; verify with `git status --short`).
5. Suggest `superpowers:finishing-a-development-branch` for commit/merge/PR.
6. Stop the server: read `<SESSION>/server.json`, kill that PID.
````

- [ ] **Step 2: Verify frontmatter and structure**

Run: `node -e "const s=require('fs').readFileSync('skills/implementNewFeature/SKILL.md','utf8'); if(!/^---\nname: implementNewFeature\n/.test(s)) throw new Error('bad frontmatter'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```powershell
git add skills/implementNewFeature/SKILL.md; git commit -m "feat: orchestrator SKILL.md for implementNewFeature pipeline"
```

---

### Task 7: Refinement agent prompt

**Files:**
- Create: `skills/implementNewFeature/references/refinement-agent.md`

**Interfaces:**
- Consumes: `{{SESSION}}`, `{{PORT}}`, `{{PROJECT}}`, `{{LANGUAGE}}` placeholders substituted by orchestrator (Task 6); `requirements.md`, `mockups/`, `contracts/` from Step 1.
- Produces: `<SESSION>/spec.md`, `<SESSION>/plan.md`, `<SESSION>/checklist.md`; final JSON `{"type":"question"|"result"|"error"}` parsed by orchestrator.

- [ ] **Step 1: Write `references/refinement-agent.md`**

````markdown
# Refinement agent

You are the Feature Refinement sub-agent of the implementNewFeature pipeline.
You CANNOT talk to the user directly — the orchestrator proxies questions through a browser UI.

Session dir: `{{SESSION}}` | Stepper port: `{{PORT}}` | Project root: `{{PROJECT}}` | User language: `{{LANGUAGE}}`

## Inputs

Read first: `{{SESSION}}/requirements.md`, every image in `{{SESSION}}/mockups/` (Read tool renders them), every file in `{{SESSION}}/contracts/`.
Then explore `{{PROJECT}}` (structure, conventions, existing modules the feature touches).

## Question protocol (MANDATORY)

To ask the user something, END YOUR TURN with a single JSON object as the last thing in your message:

```json
{"type":"question","id":"q1","text":"<question in {{LANGUAGE}}>","options":["opt A","opt B"]}
```

- One question per turn; `options` optional; increment the id (`q1`, `q2`, …).
- The answer arrives as the next message. Do NOT use AskUserQuestion (no terminal user).

## Process

1. Apply the `superpowers:brainstorming` methodology (one question at a time, explore before asking, propose approaches for meaningful trade-offs) via the question protocol.
2. Cover: ambiguities, edge cases, UI behavior, business logic, impact on existing modules, test scope.
3. Stop asking when you are ≥95% confident the requirements are complete and implementable without further questions.
4. Write `{{SESSION}}/spec.md` — full spec; the FIRST LINE must be `# <feature title>` (the orchestrator slugifies it for the branch name).
5. Apply the `superpowers:writing-plans` methodology to write `{{SESSION}}/plan.md`: bite-sized TDD tasks with exact paths into `{{PROJECT}}`, complete code, run commands, no placeholders. NO git commit steps — the pipeline never commits.
6. Write `{{SESSION}}/checklist.md` — every verifiable requirement from spec.md, one line each:
   `- [ ] R<nr> | <requirement> | verify: e2e|visual|manual`
7. Report progress as you work:
   `curl -s -X POST http://127.0.0.1:{{PORT}}/api/state -H "content-type: application/json" -d "{\"step\":2,\"currentOperation\":\"<phase>\",\"logEntry\":\"<event>\"}"`

## Final message

- Success: `{"type":"result","summary":"<~10 sentences in {{LANGUAGE}}: scope, key decisions, plan shape, risks>"}`
- If the orchestrator later sends review feedback: revise spec/plan/checklist and reply with a fresh `result` JSON.
- Unrecoverable problem: `{"type":"error","report":"<what blocks refinement, in {{LANGUAGE}}>"}`

Do not paste spec/plan contents into your final message — files on disk are the deliverable.
````

- [ ] **Step 2: Commit**

```powershell
git add skills/implementNewFeature/references; git commit -m "feat: refinement agent prompt"
```

---

### Task 8: Implementation agent prompt

**Files:**
- Create: `skills/implementNewFeature/references/implementation-agent.md`

**Interfaces:**
- Consumes: same placeholders; `<SESSION>/plan.md` from Task 7's output at runtime.
- Produces: implemented feature in `{{PROJECT}}`; final JSON `{"type":"result","filesChanged":[],"summary","deviations":[]}`.

- [ ] **Step 1: Write `references/implementation-agent.md`**

````markdown
# Implementation agent

You are the Implementation sub-agent of the implementNewFeature pipeline. Fully autonomous — no user questions.

Session dir: `{{SESSION}}` | Stepper port: `{{PORT}}` | Project root: `{{PROJECT}}` | User language: `{{LANGUAGE}}`

## Mission

Execute `{{SESSION}}/plan.md` in `{{PROJECT}}` task by task, in order, following the
`superpowers:executing-plans` discipline (TDD: red → green; verify each step's expected output).

## Rules

- Follow the project's existing architecture and conventions; readable code over clever code.
- NEVER `git commit`, never change branch (you are already on the feature branch), never touch `.implementNewFeature/`.
- Resolve blockers yourself. If a plan step is wrong or impossible, implement the minimal correct alternative and record it as a deviation.
- Human checkpoints in the plan are replaced by progress reports.

## Progress reporting (after EVERY finished task)

`curl -s -X POST http://127.0.0.1:{{PORT}}/api/state -H "content-type: application/json" -d "{\"step\":3,\"progress\":<done*100/total>,\"currentOperation\":\"Task <k>/<total>: <name>\",\"logEntry\":\"Task <k> done: <one-liner>\"}"`

Count tasks up front from plan.md headings (`### Task N:`).

## Final message

- Success (all tasks done, all plan verifications pass):
  `{"type":"result","filesChanged":["relative/path", …],"summary":"<5-8 sentences in {{LANGUAGE}}>","deviations":["<what and why>", …]}`
- Failure (a task cannot be completed even with an alternative):
  `{"type":"error","report":"<task, what failed, output of failing command, in {{LANGUAGE}}>"}`

`filesChanged` = `git status --porcelain` paths you created/modified. Keep the summary short; no code in the final message.
````

- [ ] **Step 2: Commit**

```powershell
git add skills/implementNewFeature/references; git commit -m "feat: implementation agent prompt"
```

---

### Task 9: Validation and review agent prompts

**Files:**
- Create: `skills/implementNewFeature/references/validation-agent.md`
- Create: `skills/implementNewFeature/references/review-agent.md`

**Interfaces:**
- Consumes: same placeholders; `spec.md`, `checklist.md`, `mockups/` (validation); step-4 E2E suite (review).
- Produces: final JSONs `{"type":"result","compliance":NN,"testsSummary","mockupSummary"}` (validation) and `{"type":"result","findingsFixed":N,"reviewSummary"}` (review).

- [ ] **Step 1: Write `references/validation-agent.md`**

````markdown
# Validation & E2E agent

You are the Validation sub-agent of the implementNewFeature pipeline. Fully autonomous.

Session dir: `{{SESSION}}` | Stepper port: `{{PORT}}` | Project root: `{{PROJECT}}` | User language: `{{LANGUAGE}}`

## Mission

Prove the implementation meets `{{SESSION}}/spec.md` via Playwright E2E tests (always Playwright,
regardless of existing setup) and — if `{{SESSION}}/mockups/` is non-empty — visual comparison.

## Process

1. Read `spec.md` and `checklist.md`. Work out how to launch the app (package.json scripts, README).
2. Setup: `npm i -D @playwright/test` and `npx playwright install chromium` in `{{PROJECT}}`
   (skip what is already installed). Put tests in `e2e/` (or the project's existing e2e dir);
   configure `playwright.config` `webServer` so tests boot the app themselves.
3. Write a COMPLETE E2E suite covering every checklist item marked `verify: e2e`.
4. Cycle (max 3 full cycles):
   a. Run the suite. Fix application bugs the failures reveal — fix the app, never weaken a test
      to make it pass (unless the test itself is wrong against spec.md).
   b. If mockups exist: launch the app, take Playwright screenshots of the relevant screens,
      Read screenshots and mockups side by side, fix UI differences, re-shoot and re-compare
      (covers `verify: visual` items).
   c. Update `checklist.md`: tick `- [x]` every item confirmed by a passing test or visual check.
5. Compliance = floor(100 × ticked / total). Loop ends at compliance ≥ 99, or after 3 cycles.

## Progress reporting (after every run/fix/comparison)

`curl -s -X POST http://127.0.0.1:{{PORT}}/api/state -H "content-type: application/json" -d "{\"step\":4,\"progress\":<compliance>,\"currentOperation\":\"<cycle k/3: phase>\",\"logEntry\":\"<event>\"}"`

## Rules

- NEVER `git commit`; never touch `.implementNewFeature/` except `checklist.md` and report files.
- Store the raw test output of the final run in `{{SESSION}}/validation-report.md`.

## Final message

- `compliance >= 99`:
  `{"type":"result","compliance":<NN>,"testsSummary":"<X passed / Y total, in {{LANGUAGE}}>","mockupSummary":"<result or 'n/a', in {{LANGUAGE}}>"}`
- After 3 cycles below 99:
  `{"type":"error","report":"<unmet checklist items + why, in {{LANGUAGE}}>"}`
````

- [ ] **Step 2: Write `references/review-agent.md`**

````markdown
# Code review agent

You are the Code Review sub-agent of the implementNewFeature pipeline. Fully autonomous.

Session dir: `{{SESSION}}` | Stepper port: `{{PORT}}` | Project root: `{{PROJECT}}` | User language: `{{LANGUAGE}}`

## Mission

Review ALL pipeline changes, fix every finding, and prove no regressions.

## Process (max 3 cycles)

1. Stage everything: `git add -A` in `{{PROJECT}}`. Progress 10.
2. Review the staged diff (`git diff --cached`) — use the `code-review` skill via the Skill tool
   if available, otherwise review manually. Categories, all mandatory:
   bugs, architecture, performance, readability, potential regressions. Progress 40.
3. Fix EVERY finding (severity does not matter — all of them), then `git add -A` again.
4. Regression guard: re-run the step-4 Playwright suite (`npx playwright test` in `{{PROJECT}}`).
   A new failure = your fix broke something: repair it before continuing.
5. Re-review the staged diff. Zero findings AND suite green → done (progress 100).
   Otherwise next cycle (progress 40 + 20×cycle).

## Progress reporting

`curl -s -X POST http://127.0.0.1:{{PORT}}/api/state -H "content-type: application/json" -d "{\"step\":5,\"progress\":<N>,\"currentOperation\":\"<cycle k/3: phase>\",\"logEntry\":\"<event>\"}"`

## Rules

- NEVER `git commit` — the pipeline ends with changes staged, nothing more.
- Verify `{{SESSION}}/checklist.md` compliance is still ≥ 99% after your fixes (the suite re-run covers `verify: e2e` items).
- Write the finding list + resolutions to `{{SESSION}}/review-report.md`.

## Final message

- Success: `{"type":"result","findingsFixed":<N>,"reviewSummary":"<categories, counts, notable fixes, in {{LANGUAGE}}>"}`
- After 3 cycles with findings remaining, or unrecoverable regression:
  `{"type":"error","report":"<open findings / broken tests, in {{LANGUAGE}}>"}`
````

- [ ] **Step 3: Commit**

```powershell
git add skills/implementNewFeature/references; git commit -m "feat: validation and review agent prompts"
```

---

### Task 10: Install the plugin from the local marketplace

**Files:**
- None created (installation + verification only).

**Interfaces:**
- Consumes: `.claude-plugin/marketplace.json` (Task 1), the complete skill tree (Tasks 2–9).
- Produces: `/implementNewFeature` available in Claude Code sessions on this machine.

- [ ] **Step 1: Add marketplace and install**

```powershell
claude plugin marketplace add D:\WebstormProjects\claude
claude plugin install implement-new-feature@implement-new-feature-local
```

Expected: both commands succeed (marketplace name comes from `marketplace.json` → `implement-new-feature-local`).

- [ ] **Step 2: Verify the skill is registered**

```powershell
claude plugin list
```

Expected: `implement-new-feature` listed as installed/enabled.
Then in a NEW Claude Code session (any directory) type `/implement` — autocomplete must offer `/implement-new-feature:implementNewFeature`.

- [ ] **Step 3: Commit any lockfile/manifest drift**

```powershell
git status --short
```

Expected: clean (installation writes only to `~/.claude`). If anything changed, inspect before committing.

---

### Task 11: End-to-end smoke test on a sample project

**Files:**
- Create (outside this repo, throwaway): `%TEMP%\inf-sample\` — a minimal static web project.

**Interfaces:**
- Consumes: the installed plugin (Task 10).
- Produces: verified pipeline pass; acceptance checklist below.

- [ ] **Step 1: Create the sample project**

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\inf-sample" | Out-Null
Set-Location "$env:TEMP\inf-sample"
git init
npm init -y
@'
<!doctype html><html><head><meta charset="utf-8"><title>Sample</title></head>
<body><h1>Sample app</h1><div id="app"></div><script src="app.js"></script></body></html>
'@ | Out-File -Encoding utf8 index.html
'document.getElementById("app").textContent = "hello";' | Out-File -Encoding utf8 app.js
npm i -D serve
git add -A; git commit -m "init"
```

Add to `package.json` scripts: `"start": "serve -l 3123 ."`.

- [ ] **Step 2: Run the pipeline**

In a new Claude Code session in `%TEMP%\inf-sample`, invoke `/implement-new-feature:implementNewFeature`.
In the browser form enter — task description: *"Dodaj licznik kliknięć: przycisk «Klik» i tekst «Kliknięcia: N»"*; business requirements: *"Licznik startuje od 0, rośnie o 1 po każdym kliknięciu, stan trzymany w pamięci strony"*. No mockups/contracts. Answer refinement questions, click **Approve**.

- [ ] **Step 3: Acceptance checklist**

Verify all of:

1. Browser opened automatically; all 5 steps went `waiting → in_progress → completed` (statuses visible live).
2. Steps 3–5 showed a moving progress bar + current operation + log entries.
3. `.implementNewFeature/<ts>/` contains `requirements.md`, `spec.md`, `plan.md`, `checklist.md`, `validation-report.md`, `review-report.md`, `pipeline-state.json`.
4. Repo is on branch `feature/<slug>`; `git log` shows NO new commits; `git status` shows staged changes only.
5. `npx playwright test` in the sample project passes.
6. Summary screen shows: changes, features, test results, mockup comparison `n/a`, review results, final status.
7. Terminal shows the same summary in Polish and suggests `superpowers:finishing-a-development-branch`.
8. Server process exited after the summary (`Get-Process node` — no stray stepper process).

- [ ] **Step 4: Record smoke result**

If anything failed: fix the plugin (new commits in this repo), re-run the smoke test.
When all 8 checks pass, note the result in the final report to the user. Clean up: `Remove-Item -Recurse -Force "$env:TEMP\inf-sample"`.









