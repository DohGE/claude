#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
// The session holds auth.json — the user's real credentials — and SKILL.md asks the
// orchestrator to write the catch-all .gitignore next to it by hand. Doing it here too
// costs nothing and removes the one prose step whose omission would let step 6's
// `git add -A` stage those credentials. Best-effort: an existing file is left alone.
let ensureDohGitignore = null;
try {
  ({ ensureDohGitignore } = require('../../codeReview/scripts/review-context.cjs'));
} catch { /* the sibling skill is optional; the orchestrator still writes the file */ }

const STEP_NAMES = ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation',
  'Validation & E2E', 'Code Review', 'Mockoon Mocks'];
// Ids stay fixed so agent prompts can hardcode their step number; opt-in steps
// start disabled and the orchestrator enables them from the step-1 answer.
const OPTIONAL_STEPS = [3];
const STATUSES = ['waiting', 'in_progress', 'completed', 'failed'];
const MOCKUP_DIR = 'generated-mockups';
const MOCKOON_FILE = 'mockoon.json';
const MOCKUP_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2'
};
const MAX_BODY = 25 * 1024 * 1024;
// The panel renders the last 15 entries and the whole state document is re-sent to
// the browser once a second, per task — so the cap sits just above what is visible.
const MAX_LOG = 20;
const UPLOAD_CATEGORIES = ['mockups', 'contracts', 'hints'];

// One task is one feature on one branch with its own seven-step pipeline, its own
// artifacts under tasks/<id>/ and its own sub-agents. A run holds one or more.
function taskState(id) {
  return {
    id, branch: '', root: null,
    steps: STEP_NAMES.map((name, i) => ({
      id: i + 1, name, status: 'waiting', progress: null,
      enabled: !OPTIONAL_STEPS.includes(i + 1),
      currentOperation: '', report: null, log: []
    })),
    activeStep: 1, question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0,
    reviewSummary: null, mockupReview: null, summary: null,
    step1: null, step1Submitted: false, authSaved: false
  };
}

function initialState() {
  return { tasks: [taskState('t1')], nextTaskId: 2 };
}

function safeName(raw) {
  const name = path.basename(String(raw || '').replace(/\\/g, '/'));
  return !name || name === '.' || name === '..' ? null : name;
}

const MAX_FIELD = 200 * 1024;
// Truncation has to be visible. A pasted OpenAPI contract or a long requirement that
// runs past the cap used to be cut mid-sentence with nothing said, and the refinement
// agent then designed against half a document it had no way to know was half. The
// marker travels into requirements.md and into the chat, where a human reads it.
const TRUNCATED = " […ucięte: pole przekroczyło 200 KB…]";
const text = (v) => {
  const value = String(v == null ? '' : v);
  return value.length <= MAX_FIELD ? value : value.slice(0, MAX_FIELD) + TRUNCATED;
};
const names = v => (Array.isArray(v) ? v : []).map(safeName).filter(Boolean).slice(0, 200);

// The step-1 form, and nothing else a client happens to send.
function formOf(body) {
  return {
    taskDescription: text(body.taskDescription),
    businessRequirements: text(body.businessRequirements),
    branch: text(body.branch),
    contractsText: text(body.contractsText),
    hintsNote: text(body.hintsNote),
    mockups: names(body.mockups), contracts: names(body.contracts), hints: names(body.hints),
    authProvided: !!body.authProvided, generateMockups: !!body.generateMockups
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

// The cap has to be reported, not just enforced. Destroying the socket first left the
// page with a bare network failure, so an upload past the limit read as "the server is
// gone" - and the user went looking for a dead server instead of a smaller file.
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (over) return;
      if (size > MAX_BODY) {
        // Drain the rest instead of destroying the socket: a response written while the
        // upload is still in flight does not reach the client, so cutting it here is what
        // made an over-size file look like a dead server. Chunks stop being kept, so the
        // memory stays bounded however long the client keeps sending.
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) return resolve(decodeBody(Buffer.concat(chunks)));
      const limit = Math.round(MAX_BODY / (1024 * 1024));
      if (res && !res.headersSent) sendJson(res, 413, { error: `body over ${limit} MB` });
      reject(new Error(`body over ${limit} MB`));
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function createApp(sessionDir, opts = {}) {
  const dohDir = path.dirname(path.resolve(sessionDir));
  if (ensureDohGitignore && path.basename(dohDir) === 'doh') {
    try { ensureDohGitignore(dohDir); } catch { /* best effort */ }
  }
  const stateFile = path.join(sessionDir, 'pipeline-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // A state file from before tasks existed cannot be migrated meaningfully —
    // its single run has no branch and no task dir. Start clean instead.
    if (!Array.isArray(state.tasks) || !state.tasks.length) state = initialState();
  } catch (_e) {
    // Losing the state silently is the worst outcome: the run reappears at step 1
    // with no sign of what happened. Keep the unreadable file so it can be
    // inspected (or salvaged by hand) instead of being overwritten by the first
    // update of the fresh run.
    try {
      if (fs.existsSync(stateFile)) fs.renameSync(stateFile, `${stateFile}.corrupt`);
    } catch (_e2) { /* best effort: a fresh start still beats refusing to run */ }
    state = initialState();
  }

  const findTask = id => state.tasks.find(t => t.id === id);
  const taskDir = id => path.join(sessionDir, 'tasks', id);

  function copyCategory(fromId, toId, category) {
    const from = path.join(taskDir(fromId), category);
    let files;
    try {
      files = fs.readdirSync(from, { withFileTypes: true })
        .filter(e => e.isFile()).map(e => e.name);
    } catch (_e) {
      return [];
    }
    if (!files.length) return [];
    const to = path.join(taskDir(toId), category);
    fs.mkdirSync(to, { recursive: true });
    for (const n of files) fs.copyFileSync(path.join(from, n), path.join(to, n));
    return files;
  }

  function persist() {
    fs.mkdirSync(sessionDir, { recursive: true });
    // Write-then-rename, never write in place: the file is rewritten on every
    // single state update, so a process killed mid-write would leave truncated
    // JSON — and the reader below treats unreadable JSON as "no state", which
    // silently restarts the whole pipeline at step 1. The rename is atomic
    // within the session dir, so the file is always one complete version.
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  }

  function applyUpdate(body) {
    const task = findTask(body.taskId);
    if (!task) throw new Error(`unknown task ${body.taskId}`);
    if (body.step !== undefined) {
      const step = task.steps.find(s => s.id === body.step);
      if (!step) throw new Error(`unknown step ${body.step}`);
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new Error(`bad status ${body.status}`);
        step.status = body.status;
      }
      if (body.enabled !== undefined) step.enabled = !!body.enabled;
      if (body.progress !== undefined) step.progress = body.progress;
      if (body.currentOperation !== undefined) step.currentOperation = body.currentOperation;
      if (body.report !== undefined) step.report = body.report;
      if (body.logEntry) {
        step.log.push({ time: new Date().toISOString(), text: String(body.logEntry) });
        if (step.log.length > MAX_LOG) step.log.splice(0, step.log.length - MAX_LOG);
      }
    }
    if (body.activeStep !== undefined) task.activeStep = body.activeStep;
    if (body.branch !== undefined) task.branch = String(body.branch);
    if (body.root !== undefined) task.root = body.root == null ? null : String(body.root);
    if (body.question !== undefined) {
      task.question = body.question;
      // Monotonic, server-owned: the UI keys its re-render on this counter, so a
      // sub-agent that reuses a question id still gets a fresh, unlocked panel.
      task.questionSeq = (task.questionSeq || 0) + 1;
    }
    if (body.reviewSummary !== undefined) {
      // Server-owned, like the mockups' rev: the UI keys its re-render on it, so a
      // plan revised after feedback replaces the text on screen instead of leaving
      // the previous version under the gate. A caller may still pass one — the
      // tests and a resumed run do.
      task.reviewSummary = body.reviewSummary && {
        ...body.reviewSummary,
        rev: body.reviewSummary.rev !== undefined ? body.reviewSummary.rev
          : (task.reviewSeq = (task.reviewSeq || 0) + 1)
      };
    }
    if (body.mockupReview !== undefined) {
      // The chat and the revision counter live here, not in the orchestrator: its
      // context must not grow with a mockup conversation, and a repeated `rev`
      // would leave the panel locked on the previous round. A caller may still
      // pass either explicitly — the tests and a resumed run do.
      const chat = body.mockupReview && body.mockupReview.chat !== undefined
        ? body.mockupReview.chat
        : (task.mockupReview && task.mockupReview.chat) || [];
      task.mockupReview = body.mockupReview && {
        ...body.mockupReview,
        rev: body.mockupReview.rev !== undefined ? body.mockupReview.rev
          : (task.mockupSeq = (task.mockupSeq || 0) + 1),
        chat
      };
    }
    if (body.mockupChat) {
      if (!task.mockupReview) task.mockupReview = { rev: 0, text: '', screens: [], chat: [] };
      if (!Array.isArray(task.mockupReview.chat)) task.mockupReview.chat = [];
      task.mockupReview.chat.push({
        role: body.mockupChat.role === 'user' ? 'user' : 'agent',
        text: text(body.mockupChat.text)
      });
    }
    if (body.summary !== undefined) task.summary = body.summary;
    persist();
  }

  const answers = new Map();   // taskId -> queued answers
  const waiters = [];          // {taskId|null, resolve, timer}

  const queueFor = id => {
    if (!answers.has(id)) answers.set(id, []);
    return answers.get(id);
  };

  function pushAnswer(a) {
    // A waiter with no taskId is the orchestrator's event loop: it takes anything.
    const i = waiters.findIndex(w => !w.taskId || w.taskId === a.taskId);
    if (i !== -1) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(a);
      return;
    }
    queueFor(a.taskId).push(a);
  }

  // A removed task must not leave a poll parked on it until its timeout expires.
  function releaseWaiters(taskId) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].taskId !== taskId) continue;
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  function takeQueued(taskId) {
    if (taskId) {
      const q = answers.get(taskId);
      return q && q.length ? q.shift() : null;
    }
    // Unfiltered: task order, so the oldest task's backlog drains first.
    for (const t of state.tasks) {
      const q = answers.get(t.id);
      if (q && q.length) return q.shift();
    }
    return null;
  }

  function popAnswer(taskId, waitMs, req) {
    const queued = takeQueued(taskId);
    if (queued) return Promise.resolve(queued);
    if (!waitMs) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = { taskId: taskId || null, resolve, timer: null };
      // A poll whose client is gone must not stay parked: pushAnswer picks the
      // first matching waiter, so a dead one would swallow the answer into a
      // closed socket instead of queueing it, and the next poll would find
      // nothing. The user sees the answer sent and the pipeline never moves.
      const drop = () => {
        const i = waiters.indexOf(waiter);
        if (i === -1) return;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        resolve(null);
      };
      waiter.timer = setTimeout(drop, waitMs);
      if (req) req.once('close', drop);
      waiters.push(waiter);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Outside the try this was a way to kill the run from a browser address bar:
    // `GET ////` makes the URL parser throw, the async handler rejects, and an unhandled
    // rejection takes the process down with every task's state still open.
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (_e) {
      return sendJson(res, 400, { error: 'bad request line' });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, state);
      }
      if (req.method === 'POST' && url.pathname === '/api/state') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        try {
          applyUpdate(body);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (body.kind === 'step1') {
          // The form is re-rendered from this on a revisit. Only the form's own
          // fields are kept: the whole state document is persisted on every write
          // and re-sent to the browser once a second, so anything else a client
          // sends would be paid for on every tick. Credentials never pass through
          // here — they go to /api/auth and only a flag comes back in the answer.
          task.step1 = formOf(body);
          task.step1Submitted = true;
          task.branch = task.step1.branch;
          persist();
        }
        if (body.kind === 'mockup' && body.decision === 'feedback' && task.mockupReview) {
          if (!Array.isArray(task.mockupReview.chat)) task.mockupReview.chat = [];
          task.mockupReview.chat.push({ role: 'user', text: text(body.text) });
          persist();
        }
        pushAnswer({ ...body, taskId: task.id });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/answer') {
        const taskId = url.searchParams.get('taskId') || null;
        if (taskId && !findTask(taskId)) return sendJson(res, 400, { error: 'unknown task' });
        // 300 s cap: long polls resolve instantly when an answer arrives, so a
        // high cap only reduces the number of empty polls while the user thinks.
        const waitS = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), 300);
        const answer = await popAnswer(taskId, waitS * 1000, req);
        return sendJson(res, 200, { answer });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const src = body.copyFrom ? findTask(body.copyFrom) : null;
        if (body.copyFrom && !src) return sendJson(res, 400, { error: 'unknown task' });
        const task = taskState(`t${state.nextTaskId++}`);
        const v = body.values || {};
        const copied = { mockups: [], contracts: [], hints: [] };
        if (src) {
          for (const cat of UPLOAD_CATEGORIES) copied[cat] = copyCategory(src.id, task.id, cat);
          const srcAuth = path.join(taskDir(src.id), 'auth.json');
          if (fs.existsSync(srcAuth)) {
            fs.mkdirSync(taskDir(task.id), { recursive: true });
            fs.copyFileSync(srcAuth, path.join(taskDir(task.id), 'auth.json'));
            task.authSaved = true;
          }
        }
        // Everything the form holds except the branch: two tasks cannot share one,
        // and an empty required field forces a deliberate name.
        task.step1 = formOf({ ...v, ...copied, branch: '', authProvided: task.authSaved });
        state.tasks.push(task);
        persist();
        return sendJson(res, 200, { id: task.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/remove') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (state.tasks.length < 2) return sendJson(res, 400, { error: 'last task' });
        // Only a task whose pipeline never started: closing a running one would
        // orphan its agents and its branch. Step 1 sitting in_progress is just an
        // unsubmitted form, so the test is the submission, not that step's status.
        if (task.step1Submitted || !task.steps.slice(1).every(s => s.status === 'waiting')) {
          return sendJson(res, 400, { error: 'task already started' });
        }
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        answers.delete(task.id);
        releaseWaiters(task.id);
        try { fs.rmSync(taskDir(task.id), { recursive: true, force: true }); } catch {}
        persist();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (!UPLOAD_CATEGORIES.includes(body.category)) {
          return sendJson(res, 400, { error: 'bad category' });
        }
        const name = safeName(body.filename);
        if (!name) return sendJson(res, 400, { error: 'bad filename' });
        const destDir = path.join(taskDir(task.id), body.category);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, name);
        fs.writeFileSync(dest, Buffer.from(String(body.dataBase64 || ''), 'base64'));
        return sendJson(res, 200, { ok: true, path: dest });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload/remove') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (!UPLOAD_CATEGORIES.includes(body.category)) {
          return sendJson(res, 400, { error: 'bad category' });
        }
        const name = safeName(body.filename);
        if (!name) return sendJson(res, 400, { error: 'bad filename' });
        try {
          fs.rmSync(path.join(taskDir(task.id), body.category, name), { force: true });
        } catch {}
        // The form lists files from step1, so the record must follow the disk.
        const listed = task.step1 && task.step1[body.category];
        if (Array.isArray(listed)) {
          task.step1[body.category] = listed.filter(n => n !== name);
          persist();
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        const login = String(body.login || '').trim();
        const password = String(body.password || '');
        if (!login || !password.trim()) {
          return sendJson(res, 400, { error: 'login and password are required' });
        }
        fs.mkdirSync(taskDir(task.id), { recursive: true });
        // Write-only secret: no GET counterpart, so credentials never travel
        // back over HTTP; agents read the file straight from disk.
        fs.writeFileSync(path.join(taskDir(task.id), 'auth.json'),
          JSON.stringify({ login, password }), { mode: 0o600 });
        task.authSaved = true;
        persist();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        // Credentials must not outlive the pipeline: best-effort wipe on shutdown.
        for (const t of state.tasks) {
          try { fs.rmSync(path.join(taskDir(t.id), 'auth.json'), { force: true }); } catch {}
        }
        // Flush the response first, then close; keep-alive sockets would
        // otherwise hold the server open, so force-close them.
        res.on('finish', () => setImmediate(() => {
          server.close(() => { if (opts.onShutdown) opts.onShutdown(); });
          if (server.closeAllConnections) server.closeAllConnections();
        }));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/mockoon') {
        // Read-only window onto the task's mockoon.json, served verbatim: the step-7
        // agent writes the environment to disk and the browser copies it from here,
        // so the JSON never passes through the orchestrator's context.
        const task = findTask(url.searchParams.get('taskId'));
        if (!task) return sendJson(res, 404, { error: 'not found' });
        let data;
        try {
          data = fs.readFileSync(path.join(taskDir(task.id), MOCKOON_FILE));
        } catch (_e) {
          return sendJson(res, 404, { error: 'not found' });
        }
        // no-store: a regenerated environment must never be served from cache.
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'
        });
        return res.end(data);
      }
      if (req.method === 'GET' && url.pathname.startsWith(`/${MOCKUP_DIR}/`)) {
        // Read-only window into one task's generated-mockups for the review iframe.
        // Only <taskId>/<bare filename with a known extension> is served, so the
        // route can never walk out of the task dir or hand back auth.json.
        let parts;
        try {
          parts = decodeURIComponent(url.pathname.slice(MOCKUP_DIR.length + 2))
            .replace(/\\/g, '/').split('/');
        } catch (_e) {
          return sendJson(res, 400, { error: 'bad path' });
        }
        if (parts.length !== 2 || !findTask(parts[0])) {
          return sendJson(res, 404, { error: 'not found' });
        }
        const name = parts[1];
        const type = MOCKUP_TYPES[path.extname(name).toLowerCase()];
        if (!type || name.startsWith('.') || name !== path.basename(name)) {
          return sendJson(res, 404, { error: 'not found' });
        }
        let data;
        try {
          data = fs.readFileSync(path.join(taskDir(parts[0]), MOCKUP_DIR, name));
        } catch (_e) {
          return sendJson(res, 404, { error: 'not found' });
        }
        // no-store: the agent rewrites the same filenames between chat rounds.
        // The mockup instruction requires a self-contained screen - inline CSS and JS,
        // images as data: URIs, no CDN and no web fonts - and justifies it by saying the
        // preview simply renders an external reference as a gap. A sandbox alone does not
        // do that: it isolates the origin but still lets the request out, so on a connected
        // machine the CDN font loads and the author sees nothing wrong. The policy below is
        // what makes the promise true, and it permits exactly what the instruction asks for.
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          'content-security-policy': [
            "default-src 'self' data:",
            "script-src 'self' 'unsafe-inline' data:",
            "style-src 'self' 'unsafe-inline' data:",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "connect-src 'none'",
          ].join('; '),
        });
        return res.end(data);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      // A route that already answered - the size cap replies 413 and then rejects - must
      // not be answered twice: writing a second response throws ERR_HTTP_HEADERS_SENT and
      // takes the whole server down with it, turning one refused upload into a dead run.
      if (res.headersSent) return res.end();
      // A body that will not parse is the caller's mistake, not this server's: answering
      // 500 tells the page the run broke when the truth is that it sent something bad.
      if (e instanceof SyntaxError) return sendJson(res, 400, { error: `malformed JSON body: ${e.message}` });
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
  const announce = () => {
    const actual = app.server.address().port;
    fs.mkdirSync(path.resolve(sessionDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(sessionDir), 'server.json'),
      JSON.stringify({ port: actual, pid: process.pid }));
    console.log(JSON.stringify({ port: actual }));
  };
  // A restart asks for the port it had, so the browser tab the user already has
  // open keeps working. If something else took it meanwhile, any port will do.
  app.server.on('error', e => {
    if (e.code !== 'EADDRINUSE' || !port) throw e;
    app.server.listen(0, '127.0.0.1', announce);
  });
  app.server.listen(port, '127.0.0.1', announce);
}

module.exports = { createApp, initialState, taskState };
if (require.main === module) main();
