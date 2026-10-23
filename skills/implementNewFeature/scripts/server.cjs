#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { usageReader } = require('./usage.cjs');
const { manualCommand, launchOrchestrator } = require('./launch-orchestrator.cjs');
// The session holds auth.json — the user's real credentials — and SKILL.md asks the
// orchestrator to write the catch-all .gitignore next to it by hand. Doing it here too
// costs nothing and removes the one prose step whose omission would let step 6's
// `git add -A` stage those credentials. Best-effort: an existing file is left alone.
let ensureDohGitignore = null;
try {
  ({ ensureDohGitignore } = require('../../codeReview/scripts/review-context.cjs'));
} catch { /* the sibling skill is optional; the orchestrator still writes the file */ }

const STEP_NAMES = ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation',
  'Validation & E2E', 'Code Review', 'Mockoon Mocks', 'Story Description'];
// Ids stay fixed so agent prompts can hardcode their step number. That is why Story
// Description is 8 although it runs between Mockups and Implementation: it was added
// last, and renumbering would have moved every step after it. The stepper orders the
// tiles itself. Opt-in steps start disabled; the steps a switch on the form controls
// follow that switch from the step-1 answer on.
const OPTIONAL_STEPS = [3, 8];
const STATUSES = ['waiting', 'in_progress', 'completed', 'failed'];
// One fixed port, so the stepper always lives at the same URL: the user can keep the
// tab open across runs, and everything the browser remembers for that origin - the
// agent settings, the E2E credentials - is still there on the next one.
const DEFAULT_PORT = 9999;
const REFINEMENT_STEP = 2;
const MOCKUP_STEP = 3;
const STORY_STEP = 8;
// The steps added after the state file's shape was settled. A run resumed from an older
// file gets them appended.
const ADDED_STEPS = [STORY_STEP];
const MOCKUP_DIR = 'generated-mockups';
const MOCKOON_FILE = 'mockoon.json';
const STORY_FILE = 'story.md';
const MOCKUP_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2'
};
// Every sub-agent the pipeline spawns runs on a step, so a per-step override is the
// finest grain the setting can have. Step 1 has no agent: the form IS step 1.
const AGENT_STEPS = [2, 3, 4, 5, 6, 7, 8];
// What the Agent tool accepts as a model override, and the effort levels the
// orchestrator knows how to turn into a thinking directive. Anything else is stored as
// '' (inherit): a value the spawn cannot use would only fail halfway through the run.
// The models are the session's own: at setup the orchestrator copies the tool's
// `model` enum into models.json, labelled with the versions it currently maps to. A
// list written here went stale with every release and named versions nobody ran.
// Without the file the bare aliases still spawn, they just cannot say which version.
const MODELS_FILE = 'models.json';
const FALLBACK_MODELS = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' }];
const AGENT_EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_BODY = 25 * 1024 * 1024;
// The panel renders the last 15 entries and the whole state document is re-sent to
// the browser once a second, per task — so the cap sits just above what is visible.
const MAX_LOG = 20;
// The chat is a conversation a human reads back, so it is capped far above the log:
// high enough that no real run reaches it, low enough that a looping agent cannot
// grow the state document without bound.
const MAX_CHAT = 200;
// `images` are the pictures attached to the task description: images only, and read with
// the description by every agent that reads it.
const UPLOAD_CATEGORIES = ['mockups', 'contracts', 'hints', 'images'];
const IMAGES = 'images';
// Images the user attaches to a correction or an answer on steps 2, 3 and 8. Kept apart
// from the form's own files: they belong to one message, never to the requirements, so
// they neither reach requirements.md nor count as a change to the form.
const ATTACHMENTS = 'attachments';
const MAX_ATTACHMENTS = 20;
// What the form and the composers preview as a thumbnail. An SVG can carry script; the
// preview route sends every image under a policy that runs none.
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
};
const isImage = name => !!IMAGE_TYPES[path.extname(String(name)).toLowerCase()];
// The mockup step's screenshots, written by scripts/screenshot-mockups.cjs next to the
// mockups themselves. The only folder the page may ask the server to open.
const SCREENSHOT_DIR = 'mockup-screenshots';
const OPEN_FOLDERS = [SCREENSHOT_DIR];
const IMPLEMENTATION_STEP = 4;
// The step that runs the project's E2E suite - one task at a time, through the slot this
// server keeps (POST /api/e2e): two suites at once fight over the app's ports and the browser.
const VALIDATION_STEP = 5;
const E2E_WAITING = 'Waiting for the E2E slot';
// Every task has an orchestrator of its own (launch-orchestrator.cjs). One is listening while
// its waiter's poll is parked here and working between two polls; one not seen for this long,
// or whose poll was cut off mid-wait - which is what closing its terminal does to the waiter -
// is closed, and its task may be taken over.
const ORCHESTRATOR_IDLE_MS = 15 * 60 * 1000;
// A terminal opened for a task has this long to poll before the page offers to open another.
const LAUNCH_GRACE_MS = 5 * 60 * 1000;
// The route before implementation, in the order the stepper shows it. Ids are fixed, so
// Story Description (8) runs before Implementation (4).
const PRE_STEPS = [REFINEMENT_STEP, MOCKUP_STEP, STORY_STEP];
// A resubmitted form is diffed in named groups. A FLOW group is something a step before
// implementation reads, so changing it repeats that work; a SETTING is only read when a
// later step starts or a review run begins, so changing it alone repeats nothing.
// FIXED IDENTIFIERS: SKILL.md and the orchestrator read these names off `revision.changed`.
const FLOW_GROUPS = ['description', 'branch', 'steps', 'materials', 'mockups', 'contracts'];
const SETTING_GROUPS = ['codeReview', 'agents', 'authorization'];
const FILE_GROUP = { hints: 'materials', mockups: 'mockups', contracts: 'contracts', images: 'description' };
// What each pre-implementation step's output is read by. Approved mockups also write the
// ## UI design section into the refinement's files, so a refinement that ran before them
// reads them too - but only once they were approved.
const READERS = { [REFINEMENT_STEP]: [MOCKUP_STEP, STORY_STEP], [MOCKUP_STEP]: [REFINEMENT_STEP, STORY_STEP],
  [STORY_STEP]: [] };
// Everything POST /api/state accepts. A body carrying anything else used to be
// answered 200 with nothing applied: an agent that wrote `currentOperationn`
// saw success, the panel stopped tracking its run, and the first sign of it was
// a step that sat at the same operation for twenty minutes. The prompts are
// hand-written and copied between six agents, which is exactly where a typo
// comes from, so the body is checked against this list instead.
// /api/answer is deliberately NOT checked this way: it is a pipe to the
// orchestrator, and what travels through it belongs to whoever reads it.
const STATE_FIELDS = new Set(['taskId', 'step', 'status', 'enabled', 'progress',
  'currentOperation', 'report', 'chat', 'logEntry', 'activeStep', 'branch', 'root',
  'question', 'reviewSummary', 'mockupReview', 'mockupChat', 'summary', 'reopenGate']);

// One task is one feature on one branch with its own eight-step pipeline, its own
// artifacts under tasks/<id>/ and its own sub-agents. A run holds one or more.
function taskState(id) {
  return {
    id, branch: '', root: null,
    steps: STEP_NAMES.map((name, i) => ({
      id: i + 1, name, status: 'waiting', progress: null,
      enabled: !OPTIONAL_STEPS.includes(i + 1),
      currentOperation: '', report: null, log: [], chat: []
    })),
    activeStep: 1, question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0,
    reviewSummary: null, mockupReview: null, summary: null,
    step1: null, step1Submitted: false, authSaved: false,
    // What changed on disk since the last submission: { <category>: { <name>: added |
    // replaced | removed }, auth: true }. A file is uploaded or removed before the form is
    // sent, so by then the stored list already follows the disk and the diff alone would
    // miss it.
    step1Touched: {}
  };
}

// One transcript per step, appended to from three directions: the agent working on
// the step, the browser's composer, and the orchestrator's own mockup rounds.
function pushChat(step, msg) {
  if (!Array.isArray(step.chat)) step.chat = [];
  // Timed, because a transcript is also the only durable record of what the user wrote to a
  // step whose agent had already died. The orchestrator keeps such a line to hand to the
  // retry, and its own memory is summarised away on a long run - so the line has to be
  // recoverable from here, and recovering it means knowing which side of the failure it
  // fell on. Log entries have carried a time all along; these now do too.
  // The id is what the page deletes a line by. Per step and never reused, so a line dropped
  // past the cap or deleted cannot hand its number to the next one.
  const line = {
    id: step.chatSeq = (step.chatSeq || 0) + 1,
    role: msg.role === 'user' ? 'user' : 'agent',
    text: text(msg.text, MAX_CHAT_TEXT),
    time: new Date().toISOString(),
  };
  // Bare names under tasks/<id>/attachments/; the page shows them as thumbnails.
  if (Array.isArray(msg.attachments) && msg.attachments.length) line.attachments = msg.attachments;
  step.chat.push(line);
  if (step.chat.length > MAX_CHAT) step.chat.splice(0, step.chat.length - MAX_CHAT);
}

function pushLog(step, entry) {
  if (!Array.isArray(step.log)) step.log = [];
  step.log.push({ time: new Date().toISOString(), text: text(entry) });
  if (step.log.length > MAX_LOG) step.log.splice(0, step.log.length - MAX_LOG);
}

// The session that starts the run orchestrates its first task; `starter` is its id.
function initialState(starter = null) {
  const first = taskState('t1');
  first.orchestrator = { session: starter, claimedAt: starter ? new Date().toISOString() : null };
  return { tasks: [first], nextTaskId: 2, e2e: { holder: null, queue: [] } };
}

// The slot as the steps showed it before the server kept it: held by the task whose step 5
// runs or waits for its retry, queued in the order the waiting ones were told so.
function e2eFromSteps(tasks) {
  const step = t => (t.steps || []).find(s => s.id === VALIDATION_STEP) || {};
  const holder = tasks.find(t => ['in_progress', 'failed'].includes(step(t).status));
  const queuedAt = t => ((step(t).log || []).filter(e => e.text === 'Queued for the E2E slot').at(-1) || {}).time || '';
  const queue = tasks.filter(t => step(t).status === 'waiting' && step(t).currentOperation === E2E_WAITING)
    .sort((a, b) => queuedAt(a).localeCompare(queuedAt(b))).map(t => t.id);
  return { holder: holder ? holder.id : null, queue };
}

// One directory however it is spelled: separators, a trailing one, and case on Windows.
const rootKey = p => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function safeName(raw) {
  const name = path.basename(String(raw || '').replace(/\\/g, '/'));
  return !name || name === '.' || name === '..' ? null : name;
}

const MAX_FIELD = 200 * 1024;
// A chat line is one message a human reads back in a transcript, not a pasted
// document, so it is capped far below the step-1 form. MAX_CHAT above says it keeps a
// looping agent from growing the state document without bound - and at the form's
// 200 KB it did not: 200 entries x 200 KB is 40 MB for ONE step, re-sent to the
// browser every second and rewritten to disk on every update. Measured, an ordinary
// chatty step (40 lines of 2 KB) weighs 82 KB, so this cap costs a real run nothing
// and bounds the runaway at 1.6 MB.
const MAX_CHAT_TEXT = 8 * 1024;
// Truncation has to be visible. A pasted OpenAPI contract or a long requirement that
// runs past the cap used to be cut mid-sentence with nothing said, and the refinement
// agent then designed against half a document it had no way to know was half. The
// marker travels into requirements.md and into the chat, where a human reads it, and
// it names the cap it hit so the two are told apart.
const text = (v, limit = MAX_FIELD) => {
  const value = String(v == null ? '' : v);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)} […ucięte: pole przekroczyło ${Math.round(limit / 1024)} KB…]`;
};
const names = v => (Array.isArray(v) ? v : []).map(safeName).filter(Boolean).slice(0, 200);
// One line of a step's log: an answer of a paragraph is still one entry the eye can take in.
const brief = (v, limit = 120) => {
  const value = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
};

const pick = (allowed, v) => (allowed.includes(String(v == null ? '' : v)) ? String(v) : '');

// models.json as the orchestrator writes it: [{ "value": "opus", "label": "Opus 5.5" }].
// The value goes to the spawn, so it has to look like a model name; the label is only
// shown, so a missing one falls back to the value. A file that yields nothing usable -
// absent, unparsable, the wrong shape - means the fallback, never an empty list: a
// select holding only Inherit would hide that the setting exists at all.
function loadModels(sessionDir) {
  let raw;
  try {
    raw = JSON.parse(decodeBody(fs.readFileSync(path.join(sessionDir, MODELS_FILE))));
  } catch (_e) {
    return FALLBACK_MODELS;
  }
  const seen = new Set();
  const models = (Array.isArray(raw) ? raw : []).flatMap(m => {
    const value = m && typeof m.value === 'string' ? m.value.trim() : '';
    if (!/^[A-Za-z0-9][\w.[\]-]{0,63}$/.test(value) || seen.has(value)) return [];
    seen.add(value);
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 40) : value;
    return [{ value, label }];
  }).slice(0, 20);
  return models.length ? models : FALLBACK_MODELS;
}

// Which model each of this task's sub-agents runs on, and how hard it is told to think.
// Stored as a full shape - every step present, unset values as '' - so the orchestrator
// reads one key per step instead of guessing whether a missing one means inherit.
function agentsOf(raw, models) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const steps = a.steps && typeof a.steps === 'object' ? a.steps : {};
  return {
    model: pick(models, a.model), effort: pick(AGENT_EFFORTS, a.effort),
    steps: Object.fromEntries(AGENT_STEPS.map(n => {
      const s = steps[n] && typeof steps[n] === 'object' ? steps[n] : {};
      return [String(n), { model: pick(models, s.model),
        effort: pick(AGENT_EFFORTS, s.effort) }];
    }))
  };
}

// The review step runs /doh:codeReview one to three times, and the form sets the flags of
// every run. They are read from that skill's own SKILL.md, whose "Strip the flags FIRST"
// list is what the skill actually honours, and read per request, so a flag added or
// renamed there reaches the form without this file being touched. A copy kept here would
// go stale the way the hardcoded model list did, and a stale flag is worse than a missing
// one: codeReview takes a word it does not know for a branch name. The description is the
// README's usage row where there is one, written for a person; else the bullet's own
// first sentence.
const CODE_REVIEW_DIR = path.join(__dirname, '..', '..', 'codeReview');
const MAX_REVIEW_RUNS = 3;
const defaultReviewRuns = () => [{ flags: [] }, { flags: ['--since-last'] }];

function flagText(row, bullet) {
  let s = row ? row.replace(/^any of the above, but /, '')
    : bullet.replace(/^pass it through to the context script(?: \([^)]*\))?[:.]?\s*/, '');
  s = s.replace(/\s*\(see (?:\[[^\]]*\]\([^)]*\)|[^()[\]])*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!row) s = (s.match(/^.*?[.!?](?=\s|$)/) || [s])[0];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// [{ name, description }], or null when the skill cannot be read.
function readReviewFlags() {
  let skill;
  let readme = '';
  try {
    skill = fs.readFileSync(path.join(CODE_REVIEW_DIR, 'SKILL.md'), 'utf8').replace(/\r\n?/g, '\n');
  } catch (_e) {
    return null;
  }
  try {
    readme = fs.readFileSync(path.join(CODE_REVIEW_DIR, 'README.md'), 'utf8').replace(/\r\n?/g, '\n');
  } catch (_e) { /* the bullets alone still describe every flag */ }
  const rows = new Map();
  for (const m of readme.matchAll(/^\| `\/codeReview(?: \[target\])? (--[a-z][\w-]*)` \| (.+) \|$/gm)) {
    rows.set(m[1], m[2]);
  }
  const start = skill.search(/^2\. Strip the flags FIRST/m);
  if (start === -1) return null;
  const end = skill.indexOf('\n3. ', start);
  const flags = [];
  // A bullet with the lines indented under it.
  for (const m of skill.slice(start, end === -1 ? undefined : end)
    .matchAll(/^ {3}- `(--[a-z][\w-]*)(=[^`]*)?` → (.*(?:\n {5}.*)*)/gm)) {
    // A switch has nowhere to put a value, and the one flag that takes one, --project, is
    // the pipeline's own: the review agent always points it at the task's worktree.
    if (m[2] || flags.some(f => f.name === m[1])) continue;
    flags.push({ name: m[1], description: flagText(rows.get(m[1]), m[3]) });
  }
  return flags;
}

// Every run as { flags: [...] }, in the skill's own order. `known` is the flag names
// readReviewFlags() found; null keeps any well-formed flag, so a skill that cannot be
// read for a moment does not wipe what the user set. A missing or empty list is the
// default, the two passes the review step ran before they could be configured.
function reviewRunsOf(raw, known) {
  if (!Array.isArray(raw) || !raw.length) return defaultReviewRuns();
  return raw.slice(0, MAX_REVIEW_RUNS).map(r => {
    const given = new Set((Array.isArray(r && r.flags) ? r.flags : []).map(String));
    return { flags: known ? known.filter(f => given.has(f))
      : [...given].filter(f => /^--[a-z][a-z0-9-]*$/.test(f)) };
  });
}

// The step-1 form, and nothing else a client happens to send. `models` are the values
// this session can spawn, `reviewFlags` what readReviewFlags() returned.
function formOf(body, models, reviewFlags) {
  // The task description and the business requirements were two fields until they were
  // merged: every agent read them together anyway. A form saved before that - a resumed
  // run, a copied task - still carries the second one, so it is folded in, not lost.
  const description = [body.taskDescription, body.businessRequirements]
    .map(v => String(v == null ? '' : v)).filter(v => v.trim()).join('\n\n');
  return {
    taskDescription: text(description),
    branch: text(body.branch),
    contractsText: text(body.contractsText),
    hintsNote: text(body.hintsNote),
    mockups: names(body.mockups), contracts: names(body.contracts), hints: names(body.hints),
    images: names(body.images).filter(isImage),
    authProvided: !!body.authProvided,
    // A form from before the switch existed ran the refinement, so only an explicit
    // false turns it off.
    refinement: body.refinement !== false,
    generateMockups: !!body.generateMockups,
    storyDescription: !!body.storyDescription,
    codeReview: reviewRunsOf(body.codeReview, reviewFlags && reviewFlags.map(f => f.name)),
    agents: agentsOf(body.agents, models)
  };
}

// The steps a switch on the form controls. The stepper shows a disabled step as absent,
// so the tiles follow the form as soon as it is submitted.
function applySwitches(task) {
  const f = task.step1;
  for (const [id, on] of [[REFINEMENT_STEP, f.refinement], [MOCKUP_STEP, f.generateMockups],
    [STORY_STEP, f.storyDescription]]) {
    const step = (task.steps || []).find(s => s.id === id);
    if (step) step.enabled = on;
  }
}

const SWITCHES = { [REFINEMENT_STEP]: 'refinement', [MOCKUP_STEP]: 'generateMockups',
  [STORY_STEP]: 'storyDescription' };
const ROUTE_ORDER = [...PRE_STEPS, IMPLEMENTATION_STEP];

// What a resubmitted form changed against the last submitted one, and the earliest step
// whose work that makes stale. `restartAt` is null when nothing that already ran read what
// changed: a step the route has not reached yet reads the new form when it starts anyway.
function revisionOf(task, before, after) {
  const touched = task.step1Touched || {};
  const files = [];
  for (const cat of UPLOAD_CATEGORIES) {
    const marks = { ...(touched[cat] || {}) };
    // A form stored before a category existed has no list for it.
    const was = before[cat] || [];
    const now = after[cat] || [];
    for (const n of now) if (!was.includes(n) && !marks[n]) marks[n] = 'added';
    for (const n of was) if (!now.includes(n)) marks[n] = 'removed';
    for (const [name, change] of Object.entries(marks)) files.push({ category: cat, name, change });
  }
  const on = (form, id) => !!form[SWITCHES[id]];
  const switchedOn = PRE_STEPS.filter(id => on(after, id) && !on(before, id));
  const switchedOff = PRE_STEPS.filter(id => !on(after, id) && on(before, id));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const groups = new Set(files.map(f => FILE_GROUP[f.category]));
  if (before.taskDescription !== after.taskDescription) groups.add('description');
  if (before.branch !== after.branch) groups.add('branch');
  if (switchedOn.length || switchedOff.length) groups.add('steps');
  if (before.hintsNote !== after.hintsNote) groups.add('materials');
  if (before.contractsText !== after.contractsText) groups.add('contracts');
  if (!same(before.codeReview, after.codeReview)) groups.add('codeReview');
  if (!same(before.agents, after.agents)) groups.add('agents');
  if (before.authProvided !== after.authProvided || touched.auth) groups.add('authorization');
  const changed = [...FLOW_GROUPS, ...SETTING_GROUPS].filter(g => groups.has(g));

  const status = id => ((task.steps || []).find(s => s.id === id) || {}).status;
  const started = id => !!status(id) && status(id) !== 'waiting';
  const route = [...PRE_STEPS.filter(id => on(after, id)), IMPLEMENTATION_STEP];
  const candidates = [];
  // A change to what the steps read repeats the first of them that already ran. The branch
  // is not among it: nothing before implementation reads it.
  if (['description', 'materials', 'mockups', 'contracts'].some(g => groups.has(g))) {
    const first = route.find(id => id !== IMPLEMENTATION_STEP && started(id));
    if (first) candidates.push(first);
  }
  // A step switched on runs where the route reaches it - unless a step after it already
  // ran without it, which then has to go round again behind it.
  for (const id of switchedOn) {
    if (route.slice(route.indexOf(id) + 1).some(started)) candidates.push(id);
  }
  // A step switched off takes its output with it, so whatever already read that output
  // repeats. The one the pipeline is sitting on hands over to the next step of the route.
  for (const id of switchedOff) {
    candidates.push(...READERS[id].filter(r => route.includes(r) && started(r)
      && (id !== MOCKUP_STEP || status(MOCKUP_STEP) === 'completed' || r !== REFINEMENT_STEP)));
    if (task.activeStep === id) {
      candidates.push(route.find(r => ROUTE_ORDER.indexOf(r) > ROUTE_ORDER.indexOf(id)));
    }
  }
  const restartAt = ROUTE_ORDER.find(id => candidates.includes(id)) || null;
  return { changed, restartAt, switchedOn, switchedOff, files };
}

// The pipeline goes back to `restartAt` the moment the form is accepted, before the
// orchestrator has read the answer: the page sends the user there and has to find that
// step working, and every step after it not yet reached, exactly as on the first run.
function restartFrom(task, revision) {
  const at = ROUTE_ORDER.indexOf(revision.restartAt);
  for (const step of task.steps || []) {
    const i = ROUTE_ORDER.indexOf(step.id);
    if ((i > at && step.status !== 'waiting') || revision.switchedOff.includes(step.id)) {
      Object.assign(step, { status: 'waiting', progress: null, currentOperation: '', report: null });
      delete step.stopped;
    }
  }
  const step = (task.steps || []).find(s => s.id === revision.restartAt);
  if (!step) return;
  delete step.stopped;
  Object.assign(step, { status: 'in_progress', progress: 5, report: null,
    currentOperation: step.id === IMPLEMENTATION_STEP ? 'Starting implementation'
      : 'Requirements changed - repeating this step' });
  pushLog(step, `Requirements changed (${revision.changed.join(', ')}) - the pipeline continues from here`);
  task.activeStep = step.id;
  // A question or a gate left standing would keep the old round on screen and take an
  // answer for a round that no longer exists.
  task.question = null;
  task.questionSeq = (task.questionSeq || 0) + 1;
  task.reviewSummary = null;
  task.mockupReview = null;
}

// Best effort and detached: the folder opens in the user's file manager on this machine,
// which is the machine the server runs on.
function openInFileManager(dir) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]]
    : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
  const child = require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
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

// The stepper page, curl and the waiter pass; a request another site made the browser send
// does not. Host is checked first because the other two are only ever compared against it.
function sameOrigin(req, url) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `http://${host.toLowerCase()}`) return false;
  const site = req.headers['sec-fetch-site'];
  const page = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');
  return !site || site === 'same-origin' || site === 'none' || page;
}

function createApp(sessionDir, opts = {}) {
  const dohDir = path.dirname(path.resolve(sessionDir));
  // Every run of one project shares this; two projects never do. With a fixed port
  // the browser has ONE origin for every project on the machine, so anything it
  // remembers per project - the E2E credentials above all - has to be filed under a
  // key like this or project A's login would prefill project B's form. Hashed
  // because a filesystem path has no business sitting in browser storage.
  const projectKey = crypto.createHash('sha1').update(dohDir).digest('hex').slice(0, 12);
  if (ensureDohGitignore && path.basename(dohDir) === 'doh') {
    try { ensureDohGitignore(dohDir); } catch { /* best effort */ }
  }
  // Read once: the orchestrator writes the file before it starts the server.
  const models = loadModels(sessionDir);
  const modelValues = models.map(m => m.value);
  const form = body => formOf(body, modelValues, readReviewFlags());
  // The session that started the server orchestrates the first task of a fresh run; every
  // other task gets a session of its own, opened by `launcher` (null in the tests, which must
  // never open a terminal). The usage corner reads each one's own snapshot (usage.cjs).
  const starterSession = opts.starterSession !== undefined ? opts.starterSession
    : process.env.CLAUDE_CODE_SESSION_ID || null;
  const launcher = opts.launchOrchestrator || null;
  const projectDir = path.resolve(opts.project || process.cwd());
  const readers = new Map();
  const readUsage = opts.readUsage || (session => {
    if (!readers.has(session)) {
      // Only the starting session's effort is in this process's environment.
      readers.set(session, usageReader({ sessionId: session, env: session === starterSession ? process.env : {} }));
    }
    return readers.get(session)();
  });
  const stateFile = path.join(sessionDir, 'pipeline-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // A state file from before tasks existed cannot be migrated meaningfully —
    // its single run has no branch and no task dir. Start clean instead.
    if (!Array.isArray(state.tasks) || !state.tasks.length) state = initialState(starterSession);
    if (!state.e2e || typeof state.e2e !== 'object') state.e2e = e2eFromSteps(state.tasks);
    if (!Array.isArray(state.e2e.queue)) state.e2e.queue = [];
    // A run resumed from a state file written by an older version has no chats. The
    // field is read on every render and appended to by every agent, so it is filled
    // in here rather than defended against at each of those places.
    for (const t of state.tasks) {
      // A step added since the file was written - Story Description - is appended by id,
      // in the state a new task would give it. Only those: a file that lacks one of the
      // original seven is damaged, not old, and filling the gap in would hide it.
      if (!Array.isArray(t.steps)) t.steps = [];
      for (const st of taskState(t.id).steps) {
        if (ADDED_STEPS.includes(st.id) && !t.steps.some(s => s.id === st.id)) t.steps.push(st);
      }
      for (const st of t.steps) {
        if (!Array.isArray(st.chat)) st.chat = [];
        // Lines written before they had ids get them in order, so they can be deleted too.
        for (const m of st.chat) if (m.id == null) m.id = st.chatSeq = (st.chatSeq || 0) + 1;
      }
      // Through the same normalisation as a submitted form: it merges the business
      // requirements of an older form into the description and fills in the switches
      // and the review runs. And a run resumed in a session whose Agent tool no longer
      // offers a model it picked would fail at that step's spawn; it inherits instead,
      // and the form shows it that way.
      if (t.step1 && typeof t.step1 === 'object') t.step1 = form(t.step1);
    }
  } catch (_e) {
    // Losing the state silently is the worst outcome: the run reappears at step 1
    // with no sign of what happened. Keep the unreadable file so it can be
    // inspected (or salvaged by hand) instead of being overwritten by the first
    // update of the fresh run.
    try {
      if (fs.existsSync(stateFile)) fs.renameSync(stateFile, `${stateFile}.corrupt`);
    } catch (_e2) { /* best effort: a fresh start still beats refusing to run */ }
    state = initialState(starterSession);
  }

  // Each task's orchestrator as this process has seen it: { session, listening, seen, gone }.
  // Not persisted - only a poll proves a session alive, and none has reached a server that
  // has just started. A session the state names counts as seen at the start, so a restart
  // does not hand its task to whichever session polls first.
  const startedAt = Date.now();
  const live = new Map();
  for (const t of state.tasks) {
    if (t.orchestrator && t.orchestrator.session) {
      live.set(t.id, { session: t.orchestrator.session, listening: 0, seen: startedAt, gone: false });
    }
  }

  const findTask = id => state.tasks.find(t => t.id === id);
  // By id, never by position. Ids are the contract every agent prompt hardcodes;
  // a state file resumed from a version that ordered the steps differently would
  // send step 3's chat wherever index 2 happens to sit, and a shorter one would
  // send it to `undefined`. Both are silent - the agent sees 200 either way.
  const findStep = (task, id) => (task.steps || []).find(s => s.id === id);
  // The step an answer from the page goes to, when the user had stopped it: a message names
  // its step, mockup feedback is step 3's, and an answer or a gate decision belongs to the
  // step the pipeline is on.
  const stoppedStepOf = (task, body) => {
    const id = body.kind === 'message' ? Number(body.step)
      : body.kind === 'mockup' ? MOCKUP_STEP
        : body.kind === 'answer' || body.kind === 'decision' ? task.activeStep : null;
    const step = id == null ? null : findStep(task, id);
    return step && step.stopped ? step : null;
  };
  const taskDir = id => path.join(sessionDir, 'tasks', id);
  const openFolder = opts.openFolder || openInFileManager;
  // Once implementation has started, what it was built from stays put: only the settings
  // a later step reads when it starts - the review runs, the agents, the E2E login - may
  // still change. Once the summary exists, nothing does.
  const implementing = task => {
    const step = findStep(task, IMPLEMENTATION_STEP);
    return !!step && step.status !== 'waiting';
  };
  const flowFrozen = task => !!task.summary || (task.step1Submitted && implementing(task));
  const FROZEN = 'implementation has started - only the code review, agent and authorization '
    + 'settings can still change';

  const alive = l => !!l && (l.listening > 0 || (!l.gone && Date.now() - l.seen < ORCHESTRATOR_IDLE_MS));
  // none: no session was ever started or seen for the task; starting: a terminal was opened
  // and its session has not polled yet; listening: its waiter is parked here; working: it is
  // between two polls; closed: it is gone, or never came up.
  function orchestratorStatus(task) {
    const o = task.orchestrator;
    if (!o) return 'none';
    const l = live.get(task.id);
    if (l && l.listening > 0) return 'listening';
    const launched = o.launchedAt ? Date.parse(o.launchedAt) : 0;
    if (launched && (!l || l.seen < launched)) {
      return !o.launchError && Date.now() - launched < LAUNCH_GRACE_MS ? 'starting' : 'closed';
    }
    if (!l) return 'none';
    return alive(l) ? 'working' : 'closed';
  }
  const orchestratorView = task => ({ status: orchestratorStatus(task),
    session: (task.orchestrator && task.orchestrator.session) || null,
    launchError: (task.orchestrator && task.orchestrator.launchError) || null });

  // Opens the task's terminal. The record is written before the launch is awaited, so a form
  // sent twice in a row opens one terminal, not two.
  async function launchFor(task) {
    if (!task.orchestrator) task.orchestrator = { session: null, claimedAt: null };
    Object.assign(task.orchestrator, { launchedAt: new Date().toISOString(), launchError: null });
    persist();
    let r;
    try {
      r = await launcher({ project: projectDir, taskId: task.id, port: server.address().port });
    } catch (e) {
      r = { launched: false, command: manualCommand(task.id, server.address().port), cwd: projectDir, error: e.message };
    }
    if (!r.launched) task.orchestrator.launchError = r.error || 'the terminal did not open';
    persist();
    return r;
  }

  // The slot goes to the next queued task still running, whose orchestrator hears it as an
  // answer of its own. `dequeue` also takes the task out of the queue: it no longer needs a turn.
  function releaseE2e(taskId, dequeue) {
    const e2e = state.e2e;
    if (dequeue) e2e.queue = e2e.queue.filter(id => id !== taskId);
    if (e2e.holder !== taskId) return;
    e2e.holder = null;
    while (e2e.queue.length && !e2e.holder) {
      const next = findTask(e2e.queue.shift());
      if (!next || next.summary) continue;
      e2e.holder = next.id;
      const step = findStep(next, VALIDATION_STEP);
      if (step) {
        step.currentOperation = 'Took the E2E slot';
        pushLog(step, 'Took the E2E slot');
      }
      pushAnswer({ kind: 'e2e', taskId: next.id });
    }
  }

  // Uploads and removals happen before the form is sent, so they are recorded as they
  // happen and read when it arrives. The first submission has nothing to differ from.
  function touch(task, category, name, change) {
    if (!task.step1Submitted) return;
    const touched = task.step1Touched || (task.step1Touched = {});
    const marks = touched[category] || (touched[category] = {});
    const was = marks[name];
    if (change === 'removed') {
      if (was === 'added') delete marks[name];
      else marks[name] = 'removed';
    } else {
      marks[name] = was === 'added' ? 'added' : was === 'removed' ? 'replaced' : change;
    }
  }

  // The images a message names, as stored under tasks/<id>/attachments/: names the page
  // never uploaded are dropped rather than passed on as paths to nothing.
  function attachmentsOf(task, raw) {
    const dir = path.join(taskDir(task.id), ATTACHMENTS);
    return names(raw).filter(n => isImage(n) && fs.existsSync(path.join(dir, n)))
      .slice(0, MAX_ATTACHMENTS);
  }

  // What the user answered leaves the page the moment it is sent, not when the orchestrator
  // gets round to it: a question or a gate left on screen until the agent's next post replaced
  // it asked again for a decision already made, with the reply trailing under it. So it is
  // taken down here, and what was decided is filed on the step - an answer in its log,
  // feedback in its transcript - where the progress view that takes its place shows it.
  // Everything is still forwarded: a reply to a question already replaced takes nothing down,
  // and the orchestrator, which knows what it was for, decides what it means.
  function consumeGate(task, body, attached) {
    const active = findStep(task, task.activeStep);
    const images = attached.length ? ` (+${attached.length} image${attached.length > 1 ? 's' : ''})` : '';
    const say = (step, operation, entry) => {
      if (!step) return;
      step.currentOperation = operation;
      if (entry) pushLog(step, entry);
    };
    if (body.kind === 'answer') {
      if (!task.question || String(task.question.id) !== String(body.questionId)) return;
      task.question = null;
      task.questionSeq = (task.questionSeq || 0) + 1;
      say(active, 'Processing answer…', `${body.questionId}: ${brief(body.value)}${images}`);
    } else if (body.kind === 'decision') {
      const review = task.reviewSummary;
      const what = task.activeStep === STORY_STEP ? 'story' : 'plan';
      if (body.decision === 'approve' && review && !review.answered) {
        task.reviewSummary = null;
        say(active, 'Approved — moving on…', `The ${what} was approved`);
      } else if (body.decision === 'feedback' && active) {
        // Into the transcript even with the gate already down: what went to the agent is
        // what the transcript is the record of.
        pushChat(active, { role: 'user', text: body.text, attachments: attached });
        if (review && !review.answered) {
          review.answered = new Date().toISOString();
          say(active, `Reworking the ${what}…`);
        }
      } else if (body.decision === 'retry' && active && active.status === 'failed') {
        // The orchestrator respawns the agent; the step stops showing the failure now.
        active.status = 'in_progress';
        active.report = null;
        say(active, 'Retrying the step…', 'Retry requested');
      }
    } else if (body.kind === 'mockup') {
      const step = findStep(task, MOCKUP_STEP);
      const review = task.mockupReview;
      if (body.decision === 'feedback') {
        pushChat(step, { role: 'user', text: body.text, attachments: attached });
        if (review && !review.answered) {
          review.answered = new Date().toISOString();
          say(step, 'Reworking the mockups…');
        }
      } else if (body.decision === 'approve' && review && !review.answered) {
        task.mockupReview = null;
        say(step, 'Approved — updating spec, plan and checklist…', 'The mockups were approved');
      }
    }
  }

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
    // Checked before anything is applied, so a rejected body changes nothing.
    const unknown = Object.keys(body).filter((k) => !STATE_FIELDS.has(k));
    if (unknown.length) {
      throw new Error(`unknown field(s) ${unknown.join(', ')} - expected one of ${[...STATE_FIELDS].join(', ')}`);
    }
    const task = findTask(body.taskId);
    if (!task) throw new Error(`unknown task ${body.taskId}`);
    // Every task's orchestrator picks its working directory on its own (SKILL.md step 4), so the
    // project's checkout is claimed here, where two of them cannot both win it: a root another
    // task holds is refused, and the one refused takes a worktree.
    if (body.root != null) {
      const holder = state.tasks.find(t => t.id !== task.id && t.root && rootKey(t.root) === rootKey(body.root));
      if (holder) throw Object.assign(new Error(`root ${body.root} is task ${holder.id}'s`), { status: 409 });
    }
    // A chat line with nowhere to go used to vanish: the agent sees 200, the user sees
    // silence. The step is what the transcript hangs on, so its absence is an error.
    if (body.chat && body.step === undefined) throw new Error('chat requires step');
    if (body.step !== undefined) {
      const step = findStep(task, body.step);
      if (!step) throw new Error(`unknown step ${body.step}`);
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new Error(`bad status ${body.status}`);
        step.status = body.status;
        // A step that finished, failed or went back to waiting has nothing left to resume. A
        // post that keeps it running leaves a Stop standing: the agent may still report
        // progress in the seconds before the orchestrator gets round to stopping it.
        if (body.status !== 'in_progress') delete step.stopped;
      }
      if (body.enabled !== undefined) step.enabled = !!body.enabled;
      if (body.progress !== undefined) step.progress = body.progress;
      // Through `text()`, like the step-1 form and the chat: `GET /api/state` re-sends
      // the WHOLE document to the browser once a second and `persist()` rewrites it on
      // every update, so one oversized post here is paid again every tick for the rest
      // of the run. A report is where that happens - an agent that pastes its findings
      // instead of a summary - and the marker is what tells the reader it was cut.
      if (body.currentOperation !== undefined) step.currentOperation = text(body.currentOperation);
      // `report` is nullable on purpose (null clears the panel), so the cap must not
      // turn that null into an empty string.
      if (body.report !== undefined) step.report = body.report == null ? null : text(body.report);
      if (body.chat) pushChat(step, body.chat);
      if (body.logEntry) pushLog(step, body.logEntry);
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
      // The revision counter lives here, not in the orchestrator: a repeated `rev`
      // would leave the panel locked on the previous round. A caller may still pass
      // one explicitly — the tests and a resumed run do. The conversation is NOT
      // here: it belongs to the step, so it outlives the panel being cleared and a
      // revision that sends the mockups round again.
      task.mockupReview = body.mockupReview && {
        ...body.mockupReview,
        rev: body.mockupReview.rev !== undefined ? body.mockupReview.rev
          : (task.mockupSeq = (task.mockupSeq || 0) + 1)
      };
    }
    // A gate means the agent ended its turn with something for the user, so a Stop that lost
    // the race to it has nothing left to interrupt.
    const gate = body.mockupReview ? MOCKUP_STEP
      : body.question || body.reviewSummary ? task.activeStep : null;
    if (gate != null && findStep(task, gate)) delete findStep(task, gate).stopped;
    // A review gate the user sent feedback to is hidden until the agent's next round
    // (`answered`, set by POST /api/answer). An agent that answers the feedback with a remark
    // only - `noted` - sends no new round, so the orchestrator hands the same one back.
    if (body.reopenGate) {
      if (task.reviewSummary) delete task.reviewSummary.answered;
      if (task.mockupReview) delete task.mockupReview.answered;
    }
    // The step-3 composer's own name for the same thing, kept so the mockup agent's
    // prompt needs no step number: it writes to step 3's chat like any other agent.
    if (body.mockupChat) {
      const step = findStep(task, MOCKUP_STEP);
      if (!step) throw new Error(`unknown step ${MOCKUP_STEP}`);
      pushChat(step, body.mockupChat);
    }
    if (body.summary !== undefined) task.summary = body.summary;
    // The E2E slot follows its holder's step 5: done or put back, the step frees it; failed, it
    // keeps it for the retry. A finished task neither holds it nor waits for it.
    if (body.step === VALIDATION_STEP && (body.status === 'completed' || body.status === 'waiting')) {
      releaseE2e(task.id, body.status === 'completed');
    }
    if (body.summary != null) releaseE2e(task.id, true);
    persist();
  }

  const answers = new Map();   // taskId -> queued answers
  const waiters = [];          // {taskId|null, resolve, timer}

  const queueFor = id => {
    if (!answers.has(id)) answers.set(id, []);
    return answers.get(id);
  };

  function pushAnswer(a) {
    // A waiter with no taskId is the orchestrator's event loop: it takes anything, so it
    // is served LAST. An answer carries the task it was written for, and the agent parked
    // on that task is the one that asked the question. Taking the first match let the
    // catch-all swallow it: the agent waited out its whole timeout and then re-polled
    // into an empty queue, because the answer had already been consumed elsewhere. The
    // user had watched it send, and the pipeline sat still with nothing to show why.
    let i = waiters.findIndex(w => w.taskId && w.taskId === a.taskId);
    if (i === -1) i = waiters.findIndex(w => !w.taskId);
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

  // `sign` is the polled task's entry in `live`: while the poll is parked its orchestrator is
  // listening, and the moment the poll ends is when it was last seen.
  function popAnswer(taskId, waitMs, req, sign) {
    const queued = takeQueued(taskId);
    if (queued) return Promise.resolve(queued);
    if (!waitMs) return Promise.resolve(null);
    return new Promise(resolve => {
      if (sign) sign.listening++;
      const waiter = { taskId: taskId || null, timer: null, resolve: a => {
        if (sign) {
          sign.listening--;
          sign.seen = Date.now();
        }
        resolve(a);
      } };
      // A poll whose client is gone must not stay parked: pushAnswer picks the
      // first matching waiter, so a dead one would swallow the answer into a
      // closed socket instead of queueing it, and the next poll would find
      // nothing. The user sees the answer sent and the pipeline never moves.
      const drop = gone => {
        const i = waiters.indexOf(waiter);
        if (i === -1) return;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        // Hung up mid-wait: a waiter does that only when it is killed, and a session that
        // ends takes its waiter with it. One that ran its poll out is between two polls.
        if (gone && sign) sign.gone = true;
        waiter.resolve(null);
      };
      waiter.timer = setTimeout(() => drop(false), waitMs);
      if (req) req.once('close', () => drop(true));
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
    // Since this server can open a terminal running Claude Code, a page from anywhere else
    // must not be able to call it. Whatever another site makes the browser send says so -
    // its Origin, or Sec-Fetch-Site - and a name rebound to 127.0.0.1 still arrives with its
    // own Host. The page itself may be reached from a link; it is only a page.
    if (!sameOrigin(req, url)) return sendJson(res, 403, { error: 'cross-origin request refused' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        // projectKey is computed, never persisted: it follows the directory the
        // session lives in, so a moved project gets a new one rather than a stale one.
        // The models are the session's too, so a resumed run offers what it can spawn now.
        // So is the usage: per task, what its orchestrator's session has spent.
        const orchestrators = Object.fromEntries(state.tasks.map(t => [t.id, orchestratorView(t)]));
        const usage = Object.fromEntries(state.tasks.filter(t => t.orchestrator && t.orchestrator.session)
          .map(t => [t.id, readUsage(t.orchestrator.session)]));
        return sendJson(res, 200, { ...state, project: projectKey, models, orchestrators, usage });
      }
      if (req.method === 'POST' && url.pathname === '/api/state') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        try {
          applyUpdate(body);
        } catch (e) {
          return sendJson(res, e.status || 400, { error: e.message });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (body.kind === 'step1') {
          if (task.summary) {
            return sendJson(res, 409, { error: 'the task is finished - its requirements can no longer change' });
          }
          // The form is re-rendered from this on a revisit. Only the form's own
          // fields are kept: the whole state document is persisted on every write
          // and re-sent to the browser once a second, so anything else a client
          // sends would be paid for on every tick. Credentials never pass through
          // here — they go to /api/auth and only a flag comes back in the answer.
          const next = form(body);
          // A resubmission is a revision: what changed, and where the pipeline goes back to.
          const revision = task.step1Submitted && task.step1 ? revisionOf(task, task.step1, next) : null;
          const flow = revision ? revision.changed.filter(g => FLOW_GROUPS.includes(g)) : [];
          if (flow.length && implementing(task)) {
            return sendJson(res, 409, { error: `${FROZEN} (changed: ${flow.join(', ')})` });
          }
          task.step1 = next;
          task.step1Submitted = true;
          task.step1Touched = {};
          if (!revision || revision.changed.includes('branch')) task.branch = next.branch;
          applySwitches(task);
          if (revision && revision.restartAt) restartFrom(task, revision);
          persist();
          // The orchestrator gets the form as stored, not as sent: requirements.md is
          // written from it, and only the stored one has the description merged and the
          // review flags checked against what codeReview takes.
          pushAnswer({ kind: 'step1', ...task.step1, ...(revision ? { revision } : {}), taskId: task.id });
          // The first form of a task nobody orchestrates opens the session that will; the
          // answer waits in the queue for its first poll.
          if (!revision && !task.orchestrator && launcher) launchFor(task).catch(() => {});
          return sendJson(res, 200, revision ? { ok: true, revision } : { ok: true });
        }
        // The Stop button. It interrupts the agent and nothing else: the step keeps its status,
        // its gate and its transcript, and the page only says it was stopped. The flag stays
        // until the user sends that step something - which is what resumes the agent - or the
        // step moves on. The orchestrator stops the agent when the answer reaches it.
        if (body.kind === 'stop') {
          const step = findStep(task, Number(body.step));
          if (!step || !AGENT_STEPS.includes(step.id)) return sendJson(res, 400, { error: 'unknown step' });
          if (step.status !== 'in_progress') {
            return sendJson(res, 409, { error: `step ${step.id} is not running` });
          }
          if (step.stopped) return sendJson(res, 409, { error: `step ${step.id} is already stopped` });
          step.stopped = new Date().toISOString();
          pushLog(step, 'Stopped by the user');
          persist();
          pushAnswer({ kind: 'stop', step: step.id, taskId: task.id });
          return sendJson(res, 200, { ok: true });
        }
        // The × on a line the user wrote. It leaves the transcript at once, so a retry or a
        // spawn never hands it over, and the orchestrator tells the agent that may have read it.
        // Only the user's own lines: what an agent said is its record of the work.
        if (body.kind === 'delete') {
          const step = findStep(task, Number(body.step));
          if (!step) return sendJson(res, 400, { error: 'unknown step' });
          const i = (step.chat || []).findIndex(m => m.role === 'user' && m.id === Number(body.id));
          if (i === -1) return sendJson(res, 404, { error: `step ${step.id} has no message ${body.id} of yours` });
          const [line] = step.chat.splice(i, 1);
          persist();
          const answer = { kind: 'delete', step: step.id, id: line.id, text: line.text, taskId: task.id };
          if (line.attachments) {
            answer.attachments = line.attachments.map(n => path.join(taskDir(task.id), ATTACHMENTS, n));
          }
          // A stopped agent hears about it too, but it is not resumed by it: the flag stays.
          if (step.stopped) answer.afterStop = true;
          pushAnswer(answer);
          return sendJson(res, 200, { ok: true });
        }
        const attached = attachmentsOf(task, body.attachments);
        if (body.kind === 'mockup' && !findStep(task, MOCKUP_STEP)) {
          return sendJson(res, 400, { error: `unknown step ${MOCKUP_STEP}` });
        }
        // A message typed on a step that has no gate of its own: it goes to that step's
        // agent through the orchestrator, and into the step's transcript right now, so
        // the user sees it land without waiting for the poll to come round.
        if (body.kind === 'message') {
          const step = findStep(task, Number(body.step));
          if (!step) return sendJson(res, 400, { error: 'unknown step' });
          pushChat(step, { role: 'user', text: body.text, attachments: attached });
        }
        consumeGate(task, body, attached);
        // Whatever the user sends a stopped step is what resumes its agent: the flag goes, and
        // the answer says so, so the orchestrator can tell the agent it was cut off mid-work.
        const resumed = stoppedStepOf(task, body);
        if (resumed) delete resumed.stopped;
        persist();
        // The transcript keeps bare names for the thumbnails; the orchestrator gets the
        // absolute paths, which is what the agent it forwards them to can Read.
        const answer = { ...body, taskId: task.id };
        delete answer.attachments;
        delete answer.afterStop;
        if (resumed) answer.afterStop = true;
        if (attached.length) {
          answer.attachments = attached.map(n => path.join(taskDir(task.id), ATTACHMENTS, n));
        }
        pushAnswer(answer);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/answer') {
        const taskId = url.searchParams.get('taskId') || null;
        const task = taskId ? findTask(taskId) : null;
        if (taskId && !task) return sendJson(res, 400, { error: 'unknown task' });
        // A task's poll is its orchestrator's sign of life, and with a `session` it is also a
        // claim: the first session to poll a task orchestrates it. Another one is refused
        // while that one is alive - two would act on the same answers - and takes the task
        // over once it is not.
        let sign = null;
        if (task) {
          const session = url.searchParams.get('session') || null;
          sign = live.get(task.id) || { session: null, listening: 0, seen: 0, gone: false };
          if (session && sign.session && sign.session !== session && alive(sign)) {
            return sendJson(res, 409, { error: `task ${task.id} has an orchestrator of its own`, session: sign.session });
          }
          live.set(task.id, sign);
          Object.assign(sign, { seen: Date.now(), gone: false });
          if (session) sign.session = session;
          if (session && (!task.orchestrator || task.orchestrator.session !== session)) {
            if (!task.orchestrator) task.orchestrator = {};
            Object.assign(task.orchestrator, { session, claimedAt: new Date().toISOString(), launchError: null });
            persist();
          }
        }
        // 300 s cap: long polls resolve instantly when an answer arrives, so a
        // high cap only reduces the number of empty polls while the user thinks.
        const waitS = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), 300);
        const answer = await popAnswer(taskId, waitS * 1000, req, sign);
        return sendJson(res, 200, { answer });
      }
      if (req.method === 'GET' && url.pathname === '/api/orchestrator') {
        // What a session opened for a task reads first: where the run keeps its files, and
        // what the task's orchestrator looks like from here (SKILL.md, "Attach").
        const task = findTask(url.searchParams.get('taskId'));
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        const port = server.address().port;
        return sendJson(res, 200, { taskId: task.id, sessionDir: path.resolve(sessionDir), projectDir, port,
          command: manualCommand(task.id, port), ...orchestratorView(task) });
      }
      if (req.method === 'POST' && url.pathname === '/api/orchestrator/launch') {
        // The page's "Open" on a task whose orchestrator is gone, or never came up.
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        const status = orchestratorStatus(task);
        if (status === 'listening' || status === 'working') {
          return sendJson(res, 409, { error: `task ${task.id} already has an orchestrator (${status})` });
        }
        if (!launcher) {
          return sendJson(res, 200, { launched: false, command: manualCommand(task.id, server.address().port),
            cwd: projectDir, error: 'this server opens no terminals' });
        }
        return sendJson(res, 200, await launchFor(task));
      }
      if (req.method === 'POST' && url.pathname === '/api/e2e') {
        // The one E2E run at a time (VALIDATION_STEP). The reply says whether the slot is the
        // caller's now. A task that has to wait is queued and shown waiting, and its
        // orchestrator hears `{ "kind": "e2e" }` when the slot comes round to it.
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        const e2e = state.e2e;
        if (!e2e.holder || e2e.holder === task.id) {
          e2e.holder = task.id;
          e2e.queue = e2e.queue.filter(id => id !== task.id);
          persist();
          return sendJson(res, 200, { granted: true });
        }
        if (!e2e.queue.includes(task.id)) {
          e2e.queue.push(task.id);
          const step = findStep(task, VALIDATION_STEP);
          if (step) {
            Object.assign(step, { status: 'waiting', currentOperation: E2E_WAITING });
            pushLog(step, 'Queued for the E2E slot');
          }
          task.activeStep = VALIDATION_STEP;
          persist();
        }
        return sendJson(res, 200, { granted: false, holder: e2e.holder, queue: e2e.queue });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const src = body.copyFrom ? findTask(body.copyFrom) : null;
        if (body.copyFrom && !src) return sendJson(res, 400, { error: 'unknown task' });
        const task = taskState(`t${state.nextTaskId++}`);
        const v = body.values || {};
        const copied = Object.fromEntries(UPLOAD_CATEGORIES.map(cat => [cat, []]));
        if (src) {
          for (const cat of UPLOAD_CATEGORIES) copied[cat] = copyCategory(src.id, task.id, cat);
          const srcAuth = path.join(taskDir(src.id), 'auth.json');
          if (fs.existsSync(srcAuth)) {
            fs.mkdirSync(taskDir(task.id), { recursive: true });
            fs.copyFileSync(srcAuth, path.join(taskDir(task.id), 'auth.json'));
            task.authSaved = true;
          }
        }
        // The form fields come from the CALLER, never from `src`: the page holds a
        // half-typed version of the form the server has never seen, and copying the last
        // SUBMITTED one instead would silently drop whatever the user was in the middle
        // of writing. `src` is read for the two things only the server has - the uploaded
        // files and auth.json. The branch is dropped whatever the caller sent: two tasks
        // cannot share one, and an empty required field forces a deliberate name.
        task.step1 = form({ ...v, ...copied, branch: '', authProvided: task.authSaved });
        applySwitches(task);
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
        state.e2e.queue = state.e2e.queue.filter(id => id !== task.id);
        answers.delete(task.id);
        live.delete(task.id);
        releaseWaiters(task.id);
        try { fs.rmSync(taskDir(task.id), { recursive: true, force: true }); } catch {}
        persist();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        const attachment = body.category === ATTACHMENTS;
        if (!attachment && !UPLOAD_CATEGORIES.includes(body.category)) {
          return sendJson(res, 400, { error: 'bad category' });
        }
        const name = safeName(body.filename);
        if (!name) return sendJson(res, 400, { error: 'bad filename' });
        if ((attachment || body.category === IMAGES) && !isImage(name)) {
          return sendJson(res, 400, { error: `${body.category} are images only` });
        }
        if (!attachment && flowFrozen(task)) return sendJson(res, 409, { error: FROZEN });
        const destDir = path.join(taskDir(task.id), body.category);
        fs.mkdirSync(destDir, { recursive: true });
        const data = Buffer.from(String(body.dataBase64 || ''), 'base64');
        if (attachment) {
          // Every message keeps its own copy: two screenshots called image.png, sent a
          // round apart, must not leave the first message pointing at the second picture.
          let n = 1;
          while (fs.existsSync(path.join(destDir, `${n}-${name}`))) n++;
          const stored = `${n}-${name}`;
          fs.writeFileSync(path.join(destDir, stored), data);
          return sendJson(res, 200, { ok: true, path: path.join(destDir, stored), name: stored });
        }
        const dest = path.join(destDir, name);
        let previous = null;
        try { previous = fs.readFileSync(dest); } catch { /* a new file */ }
        fs.writeFileSync(dest, data);
        // The same file picked again is no change; the same name with new bytes is.
        if (!previous || !previous.equals(data)) touch(task, body.category, name, previous ? 'replaced' : 'added');
        persist();
        return sendJson(res, 200, { ok: true, path: dest, name });
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
        if (flowFrozen(task)) return sendJson(res, 409, { error: FROZEN });
        const file = path.join(taskDir(task.id), body.category, name);
        const existed = fs.existsSync(file);
        try {
          fs.rmSync(file, { force: true });
        } catch {}
        // The form lists files from step1, so the record must follow the disk.
        const listed = task.step1 && task.step1[body.category];
        if (existed || (Array.isArray(listed) && listed.includes(name))) {
          touch(task, body.category, name, 'removed');
        }
        if (Array.isArray(listed)) task.step1[body.category] = listed.filter(n => n !== name);
        persist();
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
        const authFile = path.join(taskDir(task.id), 'auth.json');
        const secret = JSON.stringify({ login, password });
        let previous = null;
        try { previous = fs.readFileSync(authFile, 'utf8'); } catch { /* none yet */ }
        fs.writeFileSync(authFile, secret, { mode: 0o600 });
        // Remembered credentials are sent again with every submission; only new ones are
        // a change. The flag says THAT they changed - never what they are.
        if (task.step1Submitted && previous !== secret) {
          task.step1Touched = { ...(task.step1Touched || {}), auth: true };
        }
        task.authSaved = true;
        persist();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        // Credentials must not outlive the pipeline: best-effort wipe on shutdown.
        for (const t of state.tasks) {
          try { fs.rmSync(path.join(taskDir(t.id), 'auth.json'), { force: true }); } catch {}
        }
        // And neither does the pid. `server.json` is what a launcher reads to find the
        // instance it must stop, so leaving it behind after a clean exit advertises a
        // pid the OS is free to hand to something else - and the next launcher run then
        // aims a kill at whatever inherited it. The launchers check what they are about
        // to stop, but the file has no business outliving the process it describes.
        try { fs.rmSync(path.join(path.resolve(sessionDir), 'server.json'), { force: true }); } catch {}
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
      if (req.method === 'GET' && url.pathname === '/api/story') {
        // The same window onto the task's story.md: the step-8 agent writes the story and
        // the browser shows and copies it from here. Plain text, so a story that happens
        // to hold markup is shown as written and never rendered.
        const task = findTask(url.searchParams.get('taskId'));
        if (!task) return sendJson(res, 404, { error: 'not found' });
        let data;
        try {
          data = fs.readFileSync(path.join(taskDir(task.id), STORY_FILE));
        } catch (_e) {
          return sendJson(res, 404, { error: 'not found' });
        }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'
        });
        return res.end(data);
      }
      if (req.method === 'GET' && url.pathname === '/api/review-flags') {
        // Asked once, when the page opens; see readReviewFlags. An unreadable skill
        // leaves the runs without switches, never without runs.
        return sendJson(res, 200, {
          flags: readReviewFlags() || [], defaultRuns: defaultReviewRuns(), maxRuns: MAX_REVIEW_RUNS
        });
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
      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        // Thumbnails of the images uploaded with the form or attached to a message: only
        // <taskId>/<category>/<bare image name>, so the route never reaches auth.json or
        // leaves the task dir.
        let parts;
        try {
          parts = decodeURIComponent(url.pathname.slice('/uploads/'.length)).replace(/\\/g, '/').split('/');
        } catch (_e) {
          return sendJson(res, 400, { error: 'bad path' });
        }
        const [id, category, name = ''] = parts;
        const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
        if (parts.length !== 3 || !type || !findTask(id) || name.startsWith('.') || safeName(name) !== name
          || ![...UPLOAD_CATEGORIES, ATTACHMENTS].includes(category)) {
          return sendJson(res, 404, { error: 'not found' });
        }
        let data;
        try {
          data = fs.readFileSync(path.join(taskDir(id), category, name));
        } catch (_e) {
          return sendJson(res, 404, { error: 'not found' });
        }
        // An uploaded SVG opened on its own would otherwise run whatever script it holds
        // on this origin, next to the API.
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        return res.end(data);
      }
      if (req.method === 'POST' && url.pathname === '/api/open-folder') {
        const body = JSON.parse(await readBody(req, res) || '{}');
        const task = findTask(body.taskId);
        if (!task) return sendJson(res, 400, { error: 'unknown task' });
        if (!OPEN_FOLDERS.includes(body.folder)) return sendJson(res, 400, { error: 'bad folder' });
        const dir = path.join(taskDir(task.id), body.folder);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { /* not written yet */ }
        if (!entries.length) return sendJson(res, 404, { error: 'the folder is empty or does not exist yet' });
        try {
          openFolder(dir);
        } catch (e) {
          return sendJson(res, 500, { error: `could not open ${dir}: ${e.message}`, path: dir });
        }
        return sendJson(res, 200, { ok: true, path: dir });
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
    console.error('usage: node server.cjs --session-dir <dir> [--port <n>] [--project <dir>]');
    process.exit(1);
  }
  // The project is where every task's own orchestrator is started; the launchers pass the
  // directory they were run from, which is the one the run's first session works in.
  const app = createApp(path.resolve(sessionDir), { onShutdown: () => process.exit(0),
    project: get('--project'), launchOrchestrator });
  // `--port 0` (the tests) still means "any free port"; everything else defaults to
  // the fixed one.
  const arg = get('--port');
  const port = arg === undefined ? DEFAULT_PORT : parseInt(arg, 10) || 0;
  const announce = () => {
    const actual = app.server.address().port;
    fs.mkdirSync(path.resolve(sessionDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(sessionDir), 'server.json'),
      JSON.stringify({ port: actual, pid: process.pid }));
    console.log(JSON.stringify({ port: actual }));
  };
  // A predecessor killed a moment ago can still hold the socket, so a few retries
  // ride that out. What must NOT happen is landing on another port: the orchestrator
  // and every sub-agent prompt carry this number, so a silent move would leave a run
  // that looks alive with panels that never update again. Say it and stop.
  let left = 10;
  app.server.on('error', e => {
    if (e.code !== 'EADDRINUSE') throw e;
    if (left-- > 0) {
      // No callback here: 'listening' is registered once below, so a retry does not
      // stack another one-time listener and warn about a leak in the log the user
      // is about to read for the real reason.
      setTimeout(() => app.server.listen(port, '127.0.0.1'), 200);
      return;
    }
    console.error(`port ${port} is already in use - another stepper (or another program) `
      + 'is on it. Close that run from its "Shut down server" button, or stop whatever '
      + `holds ${port}, then start this one again.`);
    process.exit(1);
  });
  app.server.once('listening', announce);
  app.server.listen(port, '127.0.0.1');
}

module.exports = { createApp, initialState, taskState, MOCKUP_DIR, MOCKUP_TYPES, SCREENSHOT_DIR };
if (require.main === module) main();
