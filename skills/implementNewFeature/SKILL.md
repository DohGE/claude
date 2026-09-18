---
name: implementNewFeature
description: Use when the user wants a complete feature implemented end-to-end - runs a 5-step pipeline (Requirements, Feature Refinement, Implementation, Validation & E2E, Code Review) plus an optional Mockups step and an on-demand Mockoon mocks step, with a browser stepper UI; several features can run in parallel as tasks on their own branches and git worktrees, and the requirements form stays editable until implementation starts; the orchestrator coordinates sub-agents and keeps the main context clean
---

# implementNewFeature — pipeline orchestrator

You are the **orchestrator**. You never implement, test, or review code yourself.
Sub-agents do all heavy work; you hold only: task records, step statuses, artifact paths, short summaries.
Dynamic texts (questions, reports, summary) stay in the user's conversation language; UI chrome is English.

## Hard rules

- NEVER paste file contents (spec, plan, code) into your own context — pass **paths** to sub-agents.
- Every sub-agent ends its final message with a single JSON object: `{"type":"question"|"result"|"error", ...}`. Parse it; ignore prose around it.
  An agent that finishes with NO parsable JSON — it crashed, was cut off, or answered in prose — counts
  as `{"type":"error"}` for its step: run the failure protocol with a report saying the agent ended
  without a result. Never wait for a message that is not coming, and never re-read the step as still
  running: a step-5 agent dying this way would otherwise hold `E2E_LOCK` for the rest of the run and
  strand every task queued behind validation.
- Spawn sub-agents with the Agent tool (`subagent_type: "general-purpose"`) in the BACKGROUND, on the model and effort step 1 asked for (see "Model and effort"); continue an existing one with SendMessage (its context is preserved).
- The pipeline NEVER commits in the target project. Each task works on its own branch; stage its changes at the very end.
- Update the stepper before and after every phase so the browser always reflects reality.

## The run is an event loop, not a walk

A run holds one or more **tasks**. A task is one feature on one branch with its own seven-step
pipeline, its own `<SESSION>/tasks/<id>/` and its own sub-agents. Tasks are independent; they share
only the server, the browser page and one Validation & E2E slot.

Hold this per task, and nothing more:

    { id, branch, root, step, agentIds{refinement, mockup, impl, validation, review, mockoon},
      mockups, revisionCount, mockupRounds, agents, notes }

Then loop until the user shuts the server down:

1. Poll `curl -s "http://127.0.0.1:PORT/api/answer?wait=290"` (Bash tool `timeout: 320000`).
2. An answer arrives → read its `taskId`, act on THAT task's state machine, keep looping.
3. `null` → poll again.
4. A sub-agent completion notification arrives → advance THAT task's state machine, keep looping.
5. `{"kind":"summary","decision":"shutdown"}` → stop looping and end your turn.
6. curl cannot connect → the server is gone: stop looping and end your turn.

Answer kinds and where they belong: `step1` → step 1 of that task (the first one starts its
pipeline, every later one is a revision); `answer` → the question that task's agent asked;
`decision` → that task's plan gate, failure gate or Mockoon gate; `mockup` → that task's mockup
gate; `message` → a line typed on a step's own composer, for that step's agent (see "Talking to
a running agent"); `summary` → that task's summary screen.
Each kind carries its own fields, and they are what you read — never guess a name: `answer` has
`questionId` and `value` (the answer TEXT is `value`, not `text`); `decision` and `mockup` have
`decision` plus a `text` on `feedback`; `message` has `step` and `text`; `summary` has
`decision`; `step1` carries the form. Every
one also carries `taskId`, which is how you route it. Reading the wrong name yields `undefined`,
and the run then forwards an empty answer to the agent instead of stopping.
Two server caps bound what a form can carry: a request body over 25 MB is answered with
`413 body over 25 MB`, which the page shows as a rejected send, and any single text field over 200 KB is stored cut, with a
visible `[…ucięte…]` marker at the end. A pasted OpenAPI contract can reach that: when you see the
marker in `requirements.md`, say so to the user instead of passing the half document on.

**Which step a user is LOOKING at is never an event.** The stepper's tiles walk them back and forth
over the steps a task has already reached, and the requirements form is one of those tiles. None of
that reaches you, so never expect a "went back" message and never move `activeStep` to follow the
user — `activeStep` says where the PIPELINE is, and the browser decides what it shows.

**Sending text does not block a task's panel**, so one message may be followed by another before an
agent has answered the first. Extra `answer` and `mockup`/`feedback` messages are therefore
normal: SendMessage each to that step's agent as it arrives, in order, and never drop one. An
`answer` arriving while no question is open is an afterthought to the previous one — pass it on the
same way, and never read it as a gate decision. Gate decisions (`approve`, `retry`, `finish`,
`mockoon`, `shutdown`) still arrive at most once per gate, because those buttons do lock the panel.

**"Wait for T's `kind==X`" below never means blocking the run on T.** It means: stay in this loop,
keep polling unfiltered, keep serving whatever arrives for other tasks, and resume T's step when its
`X` shows up. Never poll with `&taskId=`, and never discard an answer because it belongs elsewhere —
one task waiting at a gate must not stall the others.

Because agents run in the background, several tasks can sit in steps 2-4 and 6 at once. A task that
fails does not stop the run: the others keep going while it waits at its gate.

**E2E_LOCK.** Chrome, the Claude in Chrome extension, the Playwright installation and the app's dev
port are single-instance, so only ONE task may be inside step 5 at a time. A task reaching step 5
while the lock is held is posted as
`{"taskId":"<id>","step":5,"status":"waiting","activeStep":5,"currentOperation":"Waiting for the E2E slot"}`
and queued FIFO by arrival. The lock is held for the whole step, including any failure-protocol
retry, and released when the task leaves step 5 — then start the next task in the queue.

## Setup

1. `SKILL_DIR` = this skill's base directory (given in the skill header). `PROJECT` = current working directory.
2. Pick the session root by whether the project already has a `.claude/` folder:
   - `PROJECT/.claude/` exists → `SESSION = <PROJECT>/.claude/doh/<yyyyMMdd-HHmmss>`, and ensure
     `<PROJECT>/.claude/doh/.gitignore` exists holding `*`, `!.gitignore`, `!instructions/` and
     `!instructions/**`, so the run's artifacts (reports, plan, screenshots, `auth.json`,
     `pipeline-state.json`) stay out of git and the final `git add -A` never stages them, while the
     project's own `doh/instructions/` rulebook stays committable.
   - otherwise → `SESSION = <SKILL_DIR>/.implementNewFeature/<yyyyMMdd-HHmmss>` (the skill's own
     `.gitignore` already covers it).
   Create `SESSION`. Each task's artifacts live in `<SESSION>/tasks/<taskId>/` — the server creates
   that directory on the task's first upload, you create it before writing `requirements.md`.
   `SESSION` always stays under `PROJECT`, never inside a worktree, so one `.gitignore` covers every
   task. Either way `node_modules` and the Playwright config stay inside `SKILL_DIR`: the `doh`
   plugin's own Playwright is the only runner the pipeline ever uses — never the project's copy,
   never a fresh install in the target project.
3. Start the server (pick the script for the OS):
   - Windows: `powershell -NoProfile -File "<SKILL_DIR>/scripts/start-server.ps1" -SessionDir "<SESSION>" -Open`
   - POSIX: `bash "<SKILL_DIR>/scripts/start-server.sh" --session-dir "<SESSION>" --open`
   - `PORT` is **9999**, always. stdout is `{"port":9999}` — read it to confirm the server came
     up, not to learn a number. Tell the user the stepper is open at `http://127.0.0.1:9999/`.
     The port is fixed because the browser remembers things per origin: the stepper's tab, the
     agent model and effort from the last run, and the E2E credentials all hang off that one URL.
   - The launcher exits non-zero when something else holds 9999 — usually another run the user
     never shut down. Do NOT look for a free port and do NOT start the pipeline anyway: show the
     launcher's message, tell the user to close the other stepper with its "Shut down server"
     button, and stop your turn there.
4. A run starts with one task, `t1`. POST `{"taskId":"t1","step":1,"status":"in_progress","activeStep":1}`
   and enter the event loop.

## Placeholders passed to every sub-agent

| Placeholder | Value |
|---|---|
| `{{SESSION}}` | `<SESSION>/tasks/<taskId>` — the task's own artifacts, not the run root |
| `{{TASK_ID}}` | `t1`, `t2`, … — MANDATORY in every `/api/state` body the agent posts |
| `{{ROOT}}` | the task's working directory. Before step 4 it is `PROJECT`; step 4 fixes it to `PROJECT` or to the task's worktree |
| `{{PORT}}`, `{{PROJECT}}`, `{{SKILL_DIR}}` | the values from Setup (points 3 and 1) |
| `{{EFFORT}}` | the thinking directive for THIS step, from the table in "Model and effort" — often the empty string, which makes the paragraph disappear |
| `{{LANGUAGE}}` | the language THIS conversation is being held in, named plainly (`Polish`, `English`, …) — never a locale code, never "the user's language" left unresolved. It decides every user-facing string an agent writes: questions, reports, summaries, `currentOperation`. Substitute it like any other placeholder; an agent that receives it unresolved has nothing to fall back on |

## Model and effort

Step 1 carries `agents`: which model this task's sub-agents run on and how hard they are told to
think. Keep it as `agents(T)` and read it at every spawn.

    { model, effort, steps: { "2": {model, effort}, "3": …, "4": …, "5": …, "6": …, "7": … } }

Every field is `""` when the user left it on Inherit. A step reads its own override first and
falls back to the task-wide pair — `model = agents.steps[N].model || agents.model`, same for
`effort`. Step 1 has no entry: the form is step 1.

- **Model** goes to the Agent tool's `model` parameter: `opus`, `sonnet`, `haiku`, `fable`.
  Empty → omit the parameter entirely and let the session's default stand. Never invent a value;
  the server already refuses anything outside that list, so an empty string means inherit, not
  "ask the user".
- **Effort has no parameter.** The Agent tool cannot set a sub-agent's reasoning effort — only an
  agent definition file can, and this pipeline spawns general-purpose agents. So effort is
  delivered as `{{EFFORT}}`, a directive inside the agent's own prompt:

  | `effort` | `{{EFFORT}}` |
  |---|---|
  | `""` or `low` | the empty string — substitute nothing and the paragraph disappears |
  | `medium` | `Effort: medium — think before each non-trivial decision.` |
  | `high` | `Effort: high — think hard before each non-trivial decision, and re-read your own output against the requirements before you report it.` |
  | `max` | `Effort: max — ultrathink: work every non-trivial decision through alternatives before you commit to one, and re-read your own output against the requirements before you report it.` |

  `think`, `think hard` and `ultrathink` are FIXED IDENTIFIERS — English verbatim, whatever
  `{{LANGUAGE}}` is. The keyword is what raises the thinking budget; translated, it is just a word
  in a sentence and the agent runs at the default effort while the UI says otherwise. Say so
  plainly if the user asks: this is a prompt-level approximation of an effort setting, not a knob
  the harness exposes.

Both bind at SPAWN time. An agent already running cannot be moved to another model, so a step-1
revision reaches only the steps that have not started — and never the refinement agent it
continues by SendMessage. Do not re-spawn a running agent to apply a new setting: its exploration,
spec and Q&A are worth more than the setting.

## Talking to a running agent

Every step's panel carries a composer, so the user can write to that step's agent whenever they
like — not only when a gate is open. It arrives as
`{"kind":"message","taskId":"T","step":N,"text":"…"}`, and it is never a decision: nothing about
the pipeline moved, so do NOT touch `status`, `progress` or `activeStep` for it.

- **That step's agent is alive** → SendMessage the text to it verbatim, then go back to polling.
  Do not post the line back as `chat`: the server recorded it the moment the browser sent it, and
  a copy would show it twice.
- **The step failed** → its agent is gone. Append the text to `notes(T,N)` and POST
  `{"taskId":"T","step":N,"logEntry":"Message kept for the retry"}` so the user can see it landed
  somewhere. On `retry`, hand every kept note to the fresh agent under a
  `## What the user added after the failure` heading, then clear `notes(T,N)`.
- **The step has no agent yet** (the user wrote ahead of the pipeline) → keep it in `notes(T,N)`
  the same way and put it in that step's prompt when you do spawn it.

Messages never queue and never lock the panel, so several may arrive in a row: forward each in
order and drop none. The agent answers in the step's transcript by POSTing `chat` itself, so its
replies never pass through you — which is what keeps a long conversation out of your context.
Steps 2 and 3 keep their own fields for their own purposes: a question is still answered with
`answer`, mockup feedback is still `mockup`. A `message` on those steps is an aside to the same
agent and is forwarded exactly like any other.

## Server helpers (use exactly these shapes)

- Update state:
  `curl -s -X POST http://127.0.0.1:PORT/api/state -H "content-type: application/json" -d "<json>"`
  Every body MUST carry `"taskId":"<id>"`; without it the server answers 400. Fields:
  `{"taskId":"t1","step":N,"status":"waiting|in_progress|completed|failed","enabled":true|false,"progress":0-100,"currentOperation":"...","report":"...","logEntry":"...","activeStep":N,"branch":"...","root":"...","question":{...}|null,"reviewSummary":{...}|null,"mockupReview":{...}|null,"chat":{"role":"agent|user","text":"..."},"mockupChat":{"role":"agent|user","text":"..."},"summary":{...}}`
  `chat` appends to the transcript of the step named in the same body — every step has one, and
  it is what the panel's composer writes into and reads back. A body carrying `chat` without
  `step` is answered 400: the line would have nowhere to go. `mockupChat` is the same thing
  under the step-3 composer's own name, kept so the mockup agent needs no step number.
  Both carry the AGENT's lines only — the server records the user's own the moment the
  browser sends them, so a copy from you would show the same message twice.
  Step ids are fixed (1 Requirements, 2 Feature Refinement, 3 Mockups, 4 Implementation,
  5 Validation & E2E, 6 Code Review, 7 Mockoon Mocks). Step 3 ships `enabled:false` and the stepper
  hides it, so a task without mockups shows five tiles numbered 1-5 plus the Mockoon one. Step 7 is
  always visible and stays `waiting` through the whole run — it only moves when the user asks for
  mocks on the summary screen.
  A body binds to ONE task and its step fields bind to ONE step, so merge consecutive updates into
  ONE POST only when they share both and nothing (user interaction, agent work) happens between them
  — e.g. completing a step and activating the next in the same task is a single body.
- Wait for a user answer (long-poll, repeat until non-null):
  `curl -s "http://127.0.0.1:PORT/api/answer?wait=290"` → `{"answer":{...,"taskId":"t1"}|null}`
  Poll WITHOUT `taskId`: this is the event loop and it must see every task's answers. The returned
  object names the task it belongs to — route on it, never drop it because it belongs to another
  task. (`&taskId=t1` exists for a targeted wait; the orchestrator should not need it.)
  ALWAYS pass `timeout: 320000` to the Bash tool for this call — the default 120 s tool timeout
  would kill the poll mid-wait. The poll returns instantly once the user answers; the long wait
  only spares empty polls. If curl cannot connect, the server died: re-run the launcher (state
  reloads from `pipeline-state.json`) and continue on 9999 — it comes back on the same port or
  not at all, which is exactly why every sub-agent's `{{PORT}}` stays valid across a restart and
  the user's open tab keeps working. A launcher that fails here has something else on 9999: say
  so and stop, rather than moving the run to a port the agents already spawned know nothing about.
- **Encoding (MANDATORY, also for every sub-agent):** bodies contain non-ASCII text (e.g. Polish).
  Always run curl from a POSIX shell (Bash tool) where inline UTF-8 JSON is safe.
  Never pass non-ASCII JSON inline through PowerShell. The body does not arrive mangled - it does
  not arrive at all: PowerShell re-encodes the argument, the byte length stops matching the string,
  and the server answers 400 `Unterminated string in JSON` (or, with single quotes, 400 `Expected
  property name` once it has eaten them). Read such a 400 as the shell, never as a bad body.
  If PowerShell is unavoidable, write the JSON to a temp file as UTF-8
  **without BOM** and send it with `--data-binary "@file"`.

## Step 1 — Requirements (interactive, per task, repeatable)

The sidebar offers two ways to spin off a task: "Copy of current task" (the server creates it and
copies the open task step 1 form and its uploaded files) and "New empty task" (a blank form). Both
work from whatever step that task is on. Either way the browser switches to the new task and puts
it into its own step 1. There is NO barrier —
each task starts its own pipeline the moment ITS form is submitted, so the user can launch task 1
while still writing task 2.

On a `step1` answer for task T:

1. When `authProvided` is true, the browser has already written login+password for E2E tests to
   `<SESSION>/tasks/T/auth.json` — NEVER read, quote or copy that file; only the validation agent
   uses it.
2. `branch` is the branch this task will be implemented on. Keep it; step 4 uses it verbatim.
   `agents` is the model and effort every sub-agent of this task is spawned with — keep it as
   `agents(T)` and read it at every spawn ("Model and effort").
3. Write `<SESSION>/tasks/T/requirements.md`:

   ```markdown
   # Requirements

   ## Task description
   <taskDescription>

   ## Business requirements
   <businessRequirements>

   ## Branch
   <branch>

   ## Additional materials (hints for refinement and mockups)
   Files: <hints list or "—">
   Note: <hintsNote or "—">

   ## Contracts (pasted)
   <contractsText or "—">

   ## Uploaded files
   Mockups: <mockups list or "—">  |  Contracts: <contracts list or "—">

   ## Authorization
   <"Provided — credentials in auth.json (task dir); never copy them into spec/plan/tests" if authProvided, else "—">

   ## Mockup generation
   <"Enabled — step 3 designs the screens" if generateMockups, else "Disabled">

   ## Agent settings
   Model: <agents.model or "inherit">  |  Effort: <agents.effort or "default">
   Overrides: <"step N: model/effort" for every step that has one, or "—">
   ```

   The last section is a record for the user and for the revision diff, not an instruction: no
   agent acts on it, and nothing in it is scope.

   (Uploads already sit in `<SESSION>/tasks/T/mockups/`, `contracts/` and `hints/`.)
4. Remember `MOCKUPS(T) = answer.generateMockups` — it decides whether step 3 runs after step 2.
   When `MOCKUPS(T)`, POST `{"taskId":"T","step":3,"enabled":true}` first (`enabled` binds to the
   body's `step`, so it cannot ride along with the step-1 update).
5. POST `{"taskId":"T","step":1,"status":"completed","activeStep":2}` and start step 2 for T.

## Revising step 1 (a second `step1` answer)

Walking back to the requirements form costs nothing: the tile is always there while the task is
before step 4, and reading the form changes no state. What reaches you is the RESUBMISSION, and the
browser only offers that button once a field, a file, the mockups toggle or the credentials actually
differ from the last submission — so a `step1` answer for a task whose `requirements.md` you have
already written always carries a real change.

It can arrive at any moment before step 4: while the refinement agent is thinking, while its question
is on screen, while the plan gate or the mockup gate is open. Take it whatever T was doing. Step 1
stays `completed` through all of it — never send it back to `in_progress`, and never POST
`activeStep:1`, which would claim the pipeline moved backwards when only the user did.

On such an answer, in this order:

1. `revisionCount(T)++`, then
   - copy `requirements.md` to `requirements-prev.md`,
   - write the new `requirements.md`,
   - write `requirements-changes.md`: a `## Revision <n>` heading and a bullet list naming which
     fields changed, which files were added or removed, and any change to the branch or the mockups
     toggle. Name the changes; do NOT copy the field bodies — they are already in the two files.
2. POST `{"taskId":"T","step":2,"status":"in_progress","activeStep":2,"progress":5,
   "currentOperation":"Refinement in progress","question":null,"reviewSummary":null,
   "mockupReview":null,"logEntry":"Revision <n> submitted"}`, and when `MOCKUPS(T)` also
   `{"taskId":"T","step":3,"status":"waiting","progress":null,"currentOperation":""}`.
   Clearing those three is NOT optional: a question or a gate left standing would keep the old panel
   on screen and take an answer for a round that no longer exists.
3. Re-run step 2 in REDUCED SCOPE. `SendMessage` the EXISTING refinement agent — do not re-spawn it:
   its project exploration, spec, plan and whole Q&A ARE the reduced scope.

       Requirements changed. Read <SESSION>/tasks/T/requirements-changes.md, then requirements.md
       and requirements-prev.md, then every file it names as ADDED under hints/, contracts/ and
       mockups/. Revision mode: patch spec.md, plan.md and checklist.md only where the change lands,
       ask only what the change opens, do not re-explore the project, and keep the ## UI design
       section. Reply with the result JSON.

   If SendMessage cannot reach it, spawn a fresh refinement agent with the same prompt plus that
   paragraph. Then continue at step 2's gate as usual.
4. A changed model or effort needs no message: it is read at the next spawn. It therefore reaches
   only steps that have not started, never the refinement agent this revision continues — say so
   in the terminal if the user asks why step 2 is still on the old one.
5. Mockups toggle transitions: off → on, POST `{"taskId":"T","step":3,"enabled":true}` and spawn a
   FRESH mockup agent after the plan gate. On → off, POST
   `{"taskId":"T","step":3,"enabled":false,"status":"waiting"}` and add to the refinement message:
   `The mockups toggle was turned OFF — remove the ## UI design section and the verify: visual
   checklist lines.`
6. After the revision the task rejoins the normal route: plan gate → mockups when enabled → step 4.

## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"taskId":"T","step":2,"status":"in_progress","activeStep":2,"progress":5,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent: prompt = contents of `<SKILL_DIR>/references/refinement-agent.md` with the placeholders from the table above substituted.
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"taskId":"T","question":{...}}`, wait for
     T's `kind=="answer"`, then **immediately** (before contacting the agent) POST
     `{"taskId":"T","question":null,"step":2,"progress":<min(60, 20+5×answers so far)>,"currentOperation":"Processing answer…","logEntry":"<id>: <answer, shortened>"}`
     so the UI reacts to the click at once, then SendMessage the answer text to the agent. You own
     the Q&A progress — the agent does not report between questions. A further `answer` for T while
     no question is open is the user adding to what they just said: SendMessage it to the same agent
     and keep waiting for its next JSON.
   - `{"type":"result","summary"}` → spec/plan/checklist now exist in `<SESSION>/tasks/T`. Go to 4.
   - `{"type":"error","report"}` → failure protocol (below) for step 2.
4. Gate: POST `{"taskId":"T","reviewSummary":{"text":"<summary>"}}`; wait for T's `kind=="decision"`:
   - `approve` → POST `{"taskId":"T","reviewSummary":null,"step":2,"status":"completed","activeStep":<3 if MOCKUPS(T) else 4>}`; continue.
   - `feedback` → SendMessage the feedback to the agent; back to 3.

## Step 3 — Mockups (interactive, conditional)

Runs ONLY when `MOCKUPS(T)`. Otherwise skip the whole step: it stays `enabled:false` / `waiting`, the
stepper never shows it, and step 2's gate already moved `activeStep` straight to 4.

1. POST `{"taskId":"T","step":3,"status":"in_progress","activeStep":3,"progress":5,"currentOperation":"Designing screens"}`.
2. Spawn the mockup agent: prompt = contents of `<SKILL_DIR>/references/mockup-agent.md` with the
   usual placeholders substituted.
3. Keep only `mockupRounds(T)`, for the progress bar. The chat transcript and the `rev` the UI
   re-renders on are the SERVER's — never hold either in your context. Loop on the agent's final JSON:
   - `{"type":"mockup","summary","screens":[{"id","title","file"}]}` → `mockupRounds(T)++` and POST
     `{"taskId":"T","step":3,"progress":<min(90, 20+10×mockupRounds)>,"currentOperation":"Waiting for your review","mockupReview":{"text":"<summary>","screens":[…]},"mockupChat":{"role":"agent","text":"<summary>"}}`.
     Omit `rev`: the server stamps the next one itself, so a round can never reuse a number and
     leave the panel locked. The chat is not part of the round at all — it belongs to step 3 and
     the server appends `mockupChat` to it, which is why clearing `mockupReview` never erases the
     conversation.
     Then wait for T's `kind=="mockup"`:
     - `decision=="feedback"` → **immediately** (before contacting the agent) POST
       `{"taskId":"T","step":3,"currentOperation":"Reworking the mockup…","logEntry":"Feedback: <shortened>"}`
       so the UI reacts to the click at once, then SendMessage the feedback text to the agent. Do NOT
       post the line as `mockupChat` — the server already appended it when the browser sent it.
       The composer is not locked while the agent reworks, so more feedback may arrive: SendMessage
       each one as it comes, in order, and keep waiting for the round. Back to 3.
     - `decision=="approve"` → SendMessage exactly: `APPROVED — update spec.md, plan.md and
       checklist.md to match the approved mockups, then reply with the result JSON.` Back to 3.
   - `{"type":"result","summary","screens":[…]}` (only ever arrives after the approval message) →
     POST `{"taskId":"T","step":3,"status":"completed","progress":100,"mockupReview":null,"activeStep":4}`.
     Keep the screen count and the summary only — never the mockup markup.
   - `{"type":"error","report"}` → failure protocol for step 3.

## Step 4 — Implementation (view-only)

1. Pick this task's working directory `ROOT`, once, here:
   - no other task has claimed `PROJECT` yet → `ROOT = PROJECT`, and
     `git -C "<ROOT>" checkout -b <branch>` (or `checkout <branch>` when it already exists). Mark
     `PROJECT` claimed for the rest of the run.
   - otherwise → `ROOT = <parent of PROJECT>/<basename of PROJECT>-worktrees/<slug>-<taskId>`,
     where `<slug>` is the branch with `/` and non-ASCII replaced by `-`. The task id is what keeps
     the path unique: two different branches can slugify to the same string, and `worktree add`
     would then fail on an existing directory. Create it with
     `git -C "<PROJECT>" worktree add "<ROOT>" -b <branch>`.
     When the branch already exists and is not checked out anywhere, drop `-b`. When it IS checked
     out elsewhere, go to the failure protocol with a report naming the conflict.
   A worktree is created from HEAD, so it has neither `node_modules` nor the untracked local config
   the app needs. Bootstrap it before spawning anything:
   - `package-lock.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`;
     `yarn.lock` → `yarn install --immutable`; no lockfile → skip.
   - copy every `.env*` file from `PROJECT` into `ROOT`, each at the same path relative to the
     root: they are gitignored, so a fresh worktree has none of them, and one nested in a workspace
     package is the one whose absence looks like an application bug in step 5 rather than a missing file.
   A failure in either goes to the failure protocol for step 4. Playwright is unaffected: the
   pipeline keeps using the plugin's own installation in `SKILL_DIR`.
   POST `{"taskId":"T","root":"<ROOT>"}` so the summary can name it.
2. POST `{"taskId":"T","step":4,"status":"in_progress","activeStep":4,"progress":0}`.
3. Spawn the implementation agent from `references/implementation-agent.md` (same placeholder
   substitution, `{{ROOT}}` included). It reports progress itself via POST /api/state and writes code
   against the `doh:codeReview` instruction checklists (its "Coding rulebook" section).
4. Final JSON `{"type":"result","filesChanged":[…],"summary","deviations":[…]}` → POST
   `{"taskId":"T","step":4,"status":"completed","progress":100,"report":"<the summary, then every
   `deviations` entry on its own line>"}`. Keep the `filesChanged` COUNT, the summary and the
   deviations; the path list itself stays out of your context.
   `deviations` is the agent's only channel for what it had to do differently — a plan step it
   replaced, a mockup that overrode the plan, a rulebook its worktree never received because the
   project had not committed it. Nothing else in the run reports any of that, so an orchestrator
   that parses the field and drops it hides exactly the part a reviewer needs. `error` → failure
   protocol.

## Step 5 — Validation & E2E (view-only, except the Chrome-extension prompt)

Take `E2E_LOCK` first; if it is held, queue this task as described in the event-loop section and come
back when the lock frees.

1. POST `{"taskId":"T","step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`. It runs the task's own unit
   suite, then writes and runs the E2E suite on the plugin's own Playwright, and uses the user's
   Chrome (Claude in Chrome extension) for discovery, failure debugging and a UX pass — expect a
   tab to open there during this step. Endpoints the backend does not serve yet are faked in the
   app's code for the length of the step and removed before it ends (archived to
   `<SESSION>/tasks/T/mocks/`), so step 6 and the commit never see them.
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the extension is unavailable, and it is
     REQUIRED: the agent is blocked until the user installs/enables it. POST `{"taskId":"T","question":{...}}`,
     wait for T's `kind=="answer"`, then **immediately** (before contacting the agent) POST
     `{"taskId":"T","question":null,"step":5,"currentOperation":"Retrying the Chrome extension…","logEntry":"<id>: <answer, shortened>"}`
     so the UI reacts to the click at once, then SendMessage the answer text to the agent. Never
     tell it to continue without the extension, and never re-spawn it with that requirement waived.
   - `{"type":"result","compliance":NN,"testsSummary","unitSummary","mockupSummary","uxSummary","apiMockSummary"}`
     with `compliance>=99` → POST completed and RELEASE `E2E_LOCK`. Keep `apiMockSummary` for the
     final summary — it says which endpoints were faked, so the user knows what was never proven
     against a real API.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit suite that stayed red, or an
     extension that never became available) → failure protocol. The lock stays held across a
     `retry`, because the retry is still this task inside step 5 — but RELEASE it the moment the
     task leaves the step in any direction, including `finish`. A failed-and-finished task that
     kept the lock would strand every other task in front of validation for the rest of the run.

## Step 6 — Code Review (view-only)

1. POST `{"taskId":"T","step":6,"status":"in_progress","activeStep":6,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md` (it reviews exclusively via the `doh:codeReview` skill — no other review method, pointed at this task's `ROOT`, and it runs TWO rounds of `1 full review + up to 2 --since-last re-reviews` unless round 1 came back clean on its first cycle, fixing every finding except the ones that would break functionality, contradict the requirements or leave the mockups).
3. `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` → delete `<SESSION>/tasks/T/auth.json` if it exists
   (step 6's regression run is its last consumer, so the credentials die with the step, not with the
   pipeline), then POST completed. `error` → failure protocol.

## Step 7 — Mockoon mocks (on demand, view-only, per task)

Never part of a task's run: the tile waits until the user clicks "Generate Mockoon mocks" on that
task's summary screen, which reaches you as `{"kind":"summary","decision":"mockoon","taskId":"T"}`.
It can run any number of times ("Regenerate" is the same step over the same file).

1. POST `{"taskId":"T","step":7,"status":"in_progress","activeStep":7,"progress":0}` — this also
   pulls the browser off the summary and onto the step's panel.
2. Spawn the mockoon agent from `references/mockoon-agent.md` (same placeholder substitution). It
   reads spec/plan, the contracts and the implemented code, and writes `<SESSION>/tasks/T/mockoon.json`
   (one environment on `localhost:3000`). The browser fetches that file itself from
   `/api/mockoon?taskId=T` — NEVER read it, never paste it into a message or into `/api/state`.
3. `{"type":"result","routes":N,"summary"}` → POST `{"taskId":"T","step":7,"status":"completed","progress":100}`;
   the panel then shows the JSON with a Copy button. Keep the route count and the summary only.
4. `{"type":"error","report"}` → POST `{"taskId":"T","step":7,"status":"failed","report":"<report>"}`, then wait
   for T's `kind=="decision"`: `retry` → POST `{"taskId":"T","step":7,"status":"in_progress","report":null}`
   and re-spawn the agent **fresh**; `finish` → the user went back to the summary, so leave the step
   failed and keep looping.

## Failure protocol (any step, any task)

1. POST `{"taskId":"T","step":N,"status":"failed","report":"<report>","question":null}` — clearing
   the question matters: a step that failed while waiting for an answer would otherwise re-show that
   stale question the moment a retry flips the status back to in_progress.
2. Wait for T's `kind=="decision"`:
   - `retry` → POST `{"taskId":"T","step":N,"status":"in_progress","report":null}`; re-spawn that
     step's agent **fresh** (new Agent call, same prompt + note about the previous failure report
     path + every message kept in `notes(T,N)` under `## What the user added after the failure`,
     which is then cleared). The re-spawn reads `agents(T)` again, so a model changed since the
     failure takes effect here.
   - `finish` → write that task's final summary (below, including the `auth.json` cleanup) with
     `finalStatus:"Failed at <step name>"` — the NAME (`Implementation`, `Validation & E2E`), never
     the id. The stepper numbers the tiles it shows, so with mockups off step 4 is the tile labelled
     3: an id quoted at the user points them at the wrong tile. Names never drift.
3. If the task held `E2E_LOCK`, release it on `finish` and start the next task in the queue.
4. A failed task does not end the run: keep serving the others from the event loop.

## Final summary (per task)

1. Delete `<SESSION>/tasks/T/auth.json` if it still exists — step 6 normally already did, so this is
   the backstop for tasks that never got there (the server also wipes every task's on shutdown). Do
   this on BOTH outcomes — success and `finish` after a failure.
2. Collect from step results only (no file contents): changes, features, tests (E2E suite + the project's unit suite), API mocks, mockup comparison, UX findings, review results, and step 4's deviations when it reported any — they belong at the end of `changes`, prefixed so a reader sees at once that the run departed from the plan.
3. POST `{"taskId":"T","summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","apiMocks":"...","mockupComparison":"...","uxReview":"...","codeReview":"..."}}` (`tests` = the validation agent's `testsSummary` and `unitSummary`; `apiMocks` = its `apiMockSummary`; `mockupComparison` = its `mockupSummary` - every renamed field is listed here, so a missing line reads as "no source" and the section lands empty even when the step did the work; `uxReview` = its `uxSummary`; `codeReview` = the review agent's `reviewSummary`, which also names every finding it rejected and on what ground). Put the task's branch and `ROOT` at the top of `changes` so the user can find the work.
4. Stage that task's changes: `git -C "<ROOT>" add -A` (already done by its step-6 agent; verify with
   `git -C "<ROOT>" status --short`). Worktrees have their own index, so tasks never stage into each other.
5. When EVERY task has finished, print ONE combined summary in the terminal (user's language): a row
   per task with its branch, working directory and final status, then the per-task details.
6. Suggest `superpowers:finishing-a-development-branch` per task, and — for the tasks that got a
   worktree — `git worktree remove <ROOT>` AFTERWARDS, in that order. The order is not a preference:
   the pipeline deliberately ends with the work staged and uncommitted, and `git worktree remove`
   refuses a worktree in that state (`fatal: ... contains modified or untracked files`). Say so when
   you suggest it, and say plainly that `--force` is NOT the way around it — it would delete the
   feature the run just built. Finish the branch first (commit, merge or PR), then remove the
   worktree; the pipeline never removes one itself, and it holds copies of the project's `.env*`
   files, so an abandoned worktree leaves those sitting outside the project.
7. Leave the server running and stay in the event loop. Do NOT kill the PID yourself. The run ends
   only when the user presses "Shut down server" or the server dies. Point them at the button rather
   than letting them close the terminal: pressing it is also what wipes every task's `auth.json`, so a
   run killed any other way leaves the credentials they typed sitting in the session directory
   (git-ignored, but still on disk) until they delete them by hand. The browser keeps its own copy
   when "Remember on this browser" was left ticked on the step-1 form — that one is the user's to
   clear, by unticking it, and no shutdown touches it. Say so if they ask where their password lives.
