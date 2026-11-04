'use strict';

// Resuming a run whose sessions were closed (SKILL.md "Resume"). Closing the terminals - or the
// machine - ends every orchestrator, and often the stepper server with them; the run itself is
// still all on disk, in `<SESSION>/pipeline-state.json`. Without this the user had to find each
// task's old session in `claude --resume` and resume it by hand, one by one.
//
// `--list` names the runs of the project that still have work: a task whose form was sent and
// whose final summary is not shown yet. `--resume [<stamp>]` brings one back: the server is
// started again on its session directory when it is down - `orphaned`, so none of the old
// orchestrators the state names holds its task for ORCHESTRATOR_IDLE_MS - and every task without a
// living orchestrator but the first gets a fresh `--attach` session in a terminal of its own, as
// the stepper's "Open session" opens one. The first is left for the session that runs this
// script, which goes on at SKILL.md "Attach". Old sessions are never resumed: Attach rebuilds a
// task from the server's state, without re-reading a whole old conversation.

const fs = require('node:fs');
const path = require('node:path');
const { restartServer, taskLine } = require('./pipeline-hooks.cjs');

const skillDir = path.resolve(__dirname, '..');
const STAMP = /^\d{8}-\d{6}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// A run left alone for longer is abandoned more often than paused: the plain start offers it no more.
const MAX_AGE_DAYS = 14;
// The statuses of server.cjs orchestratorStatus() under which a task already has a session.
const HAS_SESSION = new Set(['listening', 'working', 'starting']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sameDir = (a, b) => (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b));

// A task a new session has something to do for: not finished, and either sent - its pipeline
// runs - or already given an orchestrator, whose form would otherwise open no session when sent.
const resumable = (t) => t && !t.summary && (t.step1Submitted || !!t.orchestrator);

// SKILL.md Setup point 2: `<PROJECT>/.claude/doh/<stamp>`, or the skill's own folder.
function listRuns({ project, skillDir: skill = skillDir, now = Date.now(), maxAgeDays = MAX_AGE_DAYS,
  alive = isAlive } = {}) {
  const roots = [path.join(project, '.claude', 'doh'), path.join(skill, '.implementNewFeature')];
  const runs = [];
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const stamp of names.filter((n) => STAMP.test(n))) {
      const dir = path.join(root, stamp);
      const stateFile = path.join(dir, 'pipeline-state.json');
      const state = readJson(stateFile);
      if (!state || !Array.isArray(state.tasks)) continue;
      if (!state.tasks.some((t) => resumable(t) && t.step1Submitted)) continue;
      let updatedAt;
      try {
        updatedAt = fs.statSync(stateFile).mtimeMs;
      } catch {
        continue;
      }
      if (now - updatedAt > maxAgeDays * DAY_MS) continue;
      const server = readJson(path.join(dir, 'server.json'));
      runs.push({
        stamp, dir, project: path.resolve(project), updatedAt: new Date(updatedAt).toISOString(),
        server: server && Number.isInteger(server.pid) && alive(server.pid) ? { pid: server.pid, port: server.port } : null,
        tasks: state.tasks.filter(resumable).map((t) => ({ id: t.id, branch: t.branch || '', line: taskLine(t) })),
      });
    }
  }
  return runs.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

async function getJson(url, fetchImpl, init) {
  try {
    const res = await fetchImpl(url, init);
    return { status: res.status, body: await res.json() };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
}

// The port of the run's own server, when one is up: server.json's pid may have been handed to
// another process since, and port 9999 may be another run's - only its answer proves it.
async function livePort(run, fetchImpl) {
  if (!run.server || !Number.isInteger(run.server.port) || !run.tasks.length) return null;
  const r = await getJson(`http://127.0.0.1:${run.server.port}/api/orchestrator?taskId=${run.tasks[0].id}`, fetchImpl);
  return r.status === 200 && r.body && sameDir(r.body.sessionDir, run.dir) ? run.server.port : null;
}

async function resumeRun(run, { restart = (r, flags) => restartServer(r, flags), fetchImpl = fetch } = {}) {
  const head = { stamp: run.stamp, sessionDir: run.dir };
  let port = await livePort(run, fetchImpl);
  const restarted = port === null;
  if (restarted) {
    const r = await restart(run, { open: true, orphaned: true });
    if (!r || !r.ok) return { ...head, error: (r && r.error) || 'the server did not start' };
    port = r.port;
  }
  const base = `http://127.0.0.1:${port}`;
  let self = null;
  const launched = [];
  const running = [];
  for (const { id } of run.tasks) {
    const view = await getJson(`${base}/api/orchestrator?taskId=${id}`, fetchImpl);
    if (view.status !== 200) continue;
    if (HAS_SESSION.has(view.body.status)) {
      running.push({ taskId: id, status: view.body.status });
      continue;
    }
    if (!self) {
      self = id;
      continue;
    }
    const r = await getJson(`${base}/api/orchestrator/launch`, fetchImpl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: id }) });
    if (r.status === 409) running.push({ taskId: id, status: 'working' });
    else if (r.body) launched.push({ taskId: id, ...r.body });
    else launched.push({ taskId: id, launched: false, error: r.error || `HTTP ${r.status}` });
  }
  return { ...head, port, restarted, self, launched, running };
}

function parseArgs(argv) {
  const args = { project: process.cwd(), maxAgeDays: MAX_AGE_DAYS, list: false, resume: false, stamp: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') args.project = argv[++i];
    else if (arg === '--max-age-days') args.maxAgeDays = Number(argv[++i]) || MAX_AGE_DAYS;
    else if (arg === '--list') args.list = true;
    else if (arg === '--resume') {
      args.resume = true;
      if (STAMP.test(argv[i + 1] || '')) args.stamp = argv[++i];
    }
  }
  return { ...args, project: path.resolve(args.project) };
}

async function main(argv = process.argv.slice(2)) {
  const { project, maxAgeDays, list, resume, stamp: want } = parseArgs(argv);
  if (list) {
    const runs = listRuns({ project, maxAgeDays });
    process.stdout.write(`${JSON.stringify(runs.map(({ stamp, dir, updatedAt, server, tasks }) => ({ stamp, dir, updatedAt,
      serverUp: !!server, tasks: tasks.map((t) => t.line) })))}\n`);
    return 0;
  }
  if (!resume) {
    process.stderr.write('usage: node resume-run.cjs --project <dir> (--list | --resume [<stamp>]) [--max-age-days <n>]\n');
    return 1;
  }
  // A stamp named outright is resumed whatever its age.
  const runs = listRuns({ project, maxAgeDays: want ? Infinity : maxAgeDays });
  const run = want ? runs.find((r) => r.stamp === want) : runs[0];
  if (!run) {
    process.stdout.write(`${JSON.stringify({ error: want ? `no run ${want} with unfinished tasks` : 'no run with unfinished tasks' })}\n`);
    return 1;
  }
  const out = await resumeRun(run);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.error ? 1 : 0;
}

module.exports = { listRuns, resumeRun, MAX_AGE_DAYS };
if (require.main === module) main().then((code) => { process.exitCode = code; });
