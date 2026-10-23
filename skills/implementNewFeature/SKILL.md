---
name: implementNewFeature
description: Use when the user wants a complete feature implemented end-to-end - runs a pipeline (Requirements, Implementation, Validation & E2E, Code Review) with optional Feature Refinement, Mockups and Story Description steps and an on-demand Mockoon mocks step, with a browser stepper UI; several features can run in parallel as tasks on their own branches and git worktrees, and the requirements form stays editable until implementation starts (its settings until the task finishes); the orchestrator coordinates sub-agents and keeps the main context clean
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]
          timeout: 10
          once: true
---

# implementNewFeature — pipeline orchestrator

You are the **orchestrator**. You never implement, test, or review code yourself.
Sub-agents do all heavy work; you hold only: task records, step statuses, artifact paths, short summaries.
Dynamic texts (questions, reports, summary) stay in the user's conversation language; UI chrome is English.
Arguments with `--attach <taskId> --port <n>` start this session at "Attach"; any other start runs
"Setup" (both at the end of this file).

<!-- lean-mode:start (generated from shared/caveman-ultra.md) -->
## Lean mode: caveman ultra

Always on, from the moment a doh skill loads until the session ends.
Rules adapted from caveman by Julius Brussee (github.com/JuliusBrussee/caveman, MIT; notice in the plugin's shared/CAVEMAN-LICENSE).

Every chat message is terse like a smart caveman at level **ultra**: your messages to the user, your prompts to sub-agents, a sub-agent's replies.
All technical substance stays.
Only fluff dies.

- Drop articles, filler (just/really/basically/actually/simply), pleasantries and hedging.
  Fragments OK.
  Short synonyms: "fix", not "implement a solution for".
- Ultra: strip conjunctions when cause and effect stay unambiguous.
  One word when one word is enough.
  State each fact once.
- No invented abbreviations (cfg/impl/req/fn) and no arrows: they save no tokens and cost clarity.
  Well-known acronyms (API, DB, HTTP) are fine.
- Never drop not/never/no/only/except.
  Numbers and units exact.
- Never add a word to sound like a caveman.
  If the caveman phrasing is not shorter, write the plain one.
- One idea per sentence, 20 words at most.
  Active voice.
  Instructions in the imperative.
  The same term for the same thing every time.
- Tool calls: fire directly.
  No preamble, plan or progress note before or between calls.
- No decorative tables or emoji.
  No raw log dumps: quote the shortest decisive line.
- Questions to the user: terse but complete - answerable without guessing.
- Language: whatever the skill or the brief already prescribes.
  Lean mode compresses style, never switches language.
  In a language without articles (Polish), cut filler and keep the grammar.
- Pattern: `[thing] [action] [reason]. [next step].`
  Example: "Inline object prop, new reference each render, re-render. Wrap in `useMemo`."

Write normal, complete prose instead, exactly as the skill or brief specifies it:
- Everything persisted outside the chat: report files, spec, plan, checklist, validation and review reports, pull request comments and replies, commit messages, code comments, docs, UI text.
- Security warnings, confirmations of irreversible actions, multi-step sequences whose order could be misread, and any answer when the user asks what you meant.
  Resume ultra afterwards.

Keep byte-exact: code, paths, commands, error strings, API names, every FIXED IDENTIFIER, the effort keywords `think` / `think hard` / `ultrathink`, and every section or field a brief or step requires in a reply - present and complete.

Sub-agents get these rules from the doh SubagentStart hook: never paste them into a brief or a prompt.
When the user says "normal mode" or "stop caveman", your own chat returns to normal prose.

With the headroom proxy, a tool result may arrive compressed.
A compressed result carries a marker with `hash=<hash>`, for example `Retrieve more: hash=<hash>`, and its wording or numbers may differ from the original.
When you need the exact original - to quote it, count from it, match it or edit from it - call `headroom_retrieve` with that hash instead of guessing.
Without that tool, re-read the file or re-run the command with narrower output.
<!-- lean-mode:end -->

## Hard rules

- NEVER paste file contents (spec, plan, code) into your own context — pass **paths** to sub-agents.
- Every sub-agent ends its final message with a single JSON object: `{"type":"question"|"result"|"error", ...}`. Parse it; ignore prose around it.
  An agent that finishes with NO parsable JSON — it crashed, was cut off, or answered in prose — counts
  as `{"type":"error"}` for its step: run the failure protocol with a report saying the agent ended
  without a result. Never wait for a message that is not coming, and never re-read the step as still
  running: a step-5 agent dying this way would otherwise hold the E2E slot for the rest of the run and
  strand every task queued behind validation.
  The one exception is an agent you halted with TaskStop for a Stop: it ends without JSON because
  you stopped it, so that ending moves nothing (see "Stopping a step").
- `{"type":"noted"}` (a FIXED IDENTIFIER) is an agent's answer to a `[Stopped]` or `[Deleted]`
  notice that left it nothing to do: it replied in the transcript and is idle. Nothing moves —
  status, progress and any gate stay as they are, and the next answer for that step goes to
  the same agent. When the step is still `in_progress`, POST
  `{"taskId":"T","step":N,"currentOperation":"Waiting for you","reopenGate":true}`: the panel
  stops claiming work, and a plan, story or mockup gate the user's feedback took off the screen
  comes back, since no revised one is coming (see "A send takes its gate off the screen").
- Spawn sub-agents with the Agent tool (`subagent_type: "general-purpose"`) in the BACKGROUND, on the model and effort step 1 asked for (see "Model and effort"); continue an existing one with SendMessage (its context is preserved).
- The pipeline NEVER commits in the target project. Each task works on its own branch; stage its changes at the very end.
- Update the stepper before and after every phase so the browser always reflects reality.

## The run is an event loop, not a walk

A run holds one or more **tasks**. A task is one feature on one branch with its own eight-step
pipeline, its own `<SESSION>/tasks/<id>/`, its own sub-agents and its own orchestrator, a separate
Claude Code session. Tasks share only the server, the browser page and one Validation & E2E
slot. You orchestrate ONE task, T: `t1` when this session ran Setup, else the one `--attach` named
(see "Attach"). Every other task is another session's — never act on it.

Hold this for T, and nothing more:

    { id, branch, root, step, agentIds{refinement, mockup, story, impl, validation, review, mockoon},
      refinement, mockups, story, revisionCount, mockupRounds, agents, notes }

Then loop until the user shuts the server down:

1. Before ending ANY turn of the loop, run `node "<SKILL_DIR>/scripts/wait-answer.cjs" --port PORT --task T` with
   the Bash tool's `run_in_background: true`, then end your turn. Never wait in the foreground: the
   waiter's exit and each sub-agent's completion are what wake you, and a turn spent on an empty poll
   re-reads the whole conversation for nothing. Starting it when one is already listening is safe —
   the second one exits at once with `WAITER_RUNNING`.
2. The waiter exits → read its output lines (FIXED IDENTIFIERS, never translated):
   - `ANSWER <json>` — one per answer, in arrival order; act on each in that order, then back to 1.
   - `WAIT_TIMEOUT` — 50 minutes passed with nothing: back to 1 (the new waiter is the keep-alive).
   - `WAITER_RUNNING <pid>` — another waiter is still listening: end your turn without a new one.
   - `ORCHESTRATOR_RUNNING <session>` — another session orchestrates T: tell the user, stop looping.
   - `SERVER_GONE`, or `TASK_GONE` (T was removed) — stop looping and end your turn.
3. A sub-agent completion notification arrives → advance T's state machine, then back to 1.
4. `{"kind":"summary","decision":"shutdown"}` → stop looping and end your turn.
5. Once T has had its final summary, a `WAIT_TIMEOUT` ends the loop instead: do not start
   another waiter (see "Final summary", point 7).

Answer kinds and where they belong: `step1` → step 1 (the first one starts T's pipeline, every
later one is a revision); `answer` → the question T's agent asked; `decision` → the plan or story
gate, failure gate or Mockoon gate; `mockup` → the mockup gate; `message` → a line typed on a step's
own composer, for that step's agent (see "Talking to a running agent"); `stop` → the Stop button of
a running step (see "Stopping a step"); `delete` → the × on one of the user's own lines in a step's
transcript (see "Talking to a running agent"); `summary` → the summary screen; `e2e` → the E2E slot
came round to T (see "E2E slot").
Each kind carries its own fields, and they are what you read — never guess a name: `answer` has
`questionId` and `value` (the answer TEXT is `value`, not `text`); `decision` and `mockup` have
`decision` plus a `text` on `feedback`; `message` has `step` and `text`; `stop` has `step`;
`delete` has `step`, the line's `id` and its `text`; `summary` has `decision`; `step1` carries the form as the server normalised it — `refinement`,
`generateMockups` and `storyDescription` are booleans, and `codeReview` is a list of one to three
runs, each `{"flags":[…]}` — and every `step1` after the first adds `revision` (see "Revising
step 1"). An `answer`, a `message`, a `feedback` and a `delete` may also carry `attachments`, the
absolute paths of images the user attached in steps 2, 3 and 8: the key is there only when there
is at least one, and then the text may be empty (see "Talking to a running agent"). An `answer`, a
`decision`, a `mockup`, a `message` or a `delete` for a step the user stopped carries
`afterStop: true` (see "Stopping a step"). Every
one also carries `taskId`, always T's. Reading the wrong name yields `undefined`,
and the run then forwards an empty answer to the agent instead of stopping.
Two server caps bound what a form can carry: a request body over 25 MB is answered with
`413 body over 25 MB`, which the page shows as a rejected send, and any single text field over its cap is stored
cut, with a visible `[…ucięte…]` marker naming the cap it hit — 200 KB for a form field or a
report, 8 KB for one line of a step's transcript, which is a message a human reads and
not a document to paste. A pasted OpenAPI contract can reach that: when you see the
marker in `requirements.md`, say so to the user instead of passing the half document on.

POST `/api/state` takes only the fields listed in its contract, and a body carrying any other name
is answered `400 unknown field(s) <name> - expected one of …` with NOTHING applied. Read that as a
typo in the body you just sent, never as a broken server: a mistyped field used to come back 200
while the panel quietly stopped following the run.

**Which step a user is LOOKING at is never an event.** The stepper's tiles walk them back and forth
over the steps a task has already reached, and the requirements form is one of those tiles. None of
that reaches you, so never expect a "went back" message and never move `activeStep` to follow the
user — `activeStep` says where the PIPELINE is, and the browser decides what it shows.

**A send takes its gate off the screen at once.** The server acts on what the page sends before it
wakes you: an `answer` to the open question clears it (`question` becomes null, and the step logs
`<id>: <answer>` and reads `Processing answer…`), a `feedback` marks the plan, story or mockup gate
`answered` and puts the text in that step's `chat`, an `approve` drops the gate, and a `retry` puts
the failed step back `in_progress`. So the user sees the step at work, never a gate they already
answered — and you never clear a question, a gate or a failure the server already did. A gate
answered with feedback stays off the screen until you POST the agent's next round (a new
`reviewSummary` or `mockupReview` replaces it) or `reopenGate` (see `noted`).
Each gate takes one answer, so what the user thinks of next is a `message` from the step's
composer: SendMessage each to that step's agent as it arrives, in order, and never drop one. An
`answer` or a `feedback` that still arrives for a gate already answered (a page that had not caught
up) is the same kind of afterthought — pass it on, and never read it as a gate decision. Gate
decisions (`approve`, `retry`, `finish`, `mockoon`, `shutdown`) arrive at most once per gate.

**"Wait for T's `kind==X`" below never means blocking.** It means: stay in this loop with the waiter
armed, keep serving whatever else arrives for T, and resume T's step when its `X` shows up.

Other tasks run in sessions of their own, so several sit in steps 2-4, 6 and 8 at once, and one
that fails stops none of the others.

**E2E slot.** Chrome, the Claude in Chrome extension, the Playwright installation and the app's dev
port are single-instance, so only ONE task may be inside step 5 at a time, and the SERVER keeps the
slot, never your memory. POST `/api/e2e` with `{"taskId":"T"}`: `{"granted":true}` → T has it;
`{"granted":false,…}` → the server queued T (first come, first served) and shows its step 5
waiting: wait for T's `kind=="e2e"`. T keeps the slot through step 5 — a Stop and a failure-protocol
retry included — and the server hands it on once step 5 is posted `completed` or T's summary is
set. Never release it yourself.

## Spawning a sub-agent

Every spawn below is the same two moves: render the agent's brief to a file, then spawn an agent
that reads it. You never build the prompt yourself.

1. **Render** (Bash tool), with every placeholder from the table below:

       node "<SKILL_DIR>/../../scripts/render-agent-prompt.cjs" --template="<SKILL_DIR>/references/<name>-agent.md" --out="<SESSION>/prompts/<name>.md" --set=ROOT=<…> --set=PROJECT=<…> --set=SESSION=<…> --set=TASK_ID=<…> --set=PORT=9999 --set=SKILL_DIR=<…> --set=LANGUAGE=<…> --set=EFFORT=<…>

   `<SESSION>` here is the task's own `{{SESSION}}` — the brief lands beside the artifacts of the
   task it belongs to, and the next round of the same agent replaces it. `EFFORT` is often empty:
   pass `--set=EFFORT=` and the paragraph disappears. `errors[]` non-empty → do NOT spawn: the
   message names the placeholder nobody filled, and the fix is the missing `--set`.

2. **Spawn** with the Agent tool, `model` from `agents(T)` (omit it when empty), prompt:

       Your complete instructions are in the file <out>. Read it in full with the Read tool
       before doing anything else, then follow it exactly. It is already resolved: every path,
       port and id it names is final. You are the <step name> agent of task <TASK_ID>, and you
       end with the single JSON object it specifies.

   Whatever THIS spawn has to add — the failure report of a previous attempt, what the user wrote
   to that step's transcript while it had no agent, a revision paragraph — goes in that prompt,
   under its own heading, after the pointer. It never goes into the rendered file.

**Never paste an agent file into a prompt yourself.** Reading it in and writing it back out costs
that file twice per spawn, six times per pipeline and again on every retry — tens of thousands of
tokens of the context this orchestrator exists to keep clean. The renderer also refuses a brief
that still holds a placeholder; a hand-made one hands `{{ROOT}}` to the agent as if it were a path.

## Placeholders passed to every sub-agent

| Placeholder | Value |
|---|---|
| `{{SESSION}}` | `<SESSION>/tasks/<taskId>` — the task's own artifacts, not the run root |
| `{{TASK_ID}}` | `t1`, `t2`, … — MANDATORY in every `/api/state` body the agent posts |
| `{{ROOT}}` | the task's working directory. Before step 4 it is `PROJECT`; step 4 fixes it to `PROJECT` or to the task's worktree |
| `{{PORT}}`, `{{PROJECT}}`, `{{SKILL_DIR}}` | the values from Setup (points 3 and 1) |
| `{{EFFORT}}` | the thinking directive for THIS step, from the table in "Model and effort" — often the empty string, which makes the paragraph disappear |
| `{{LANGUAGE}}` | the language THIS conversation is being held in, named plainly (`Polish`, `English`, …) — never a locale code, never "the user's language" left unresolved. It decides every user-facing string an agent writes: questions, reports, summaries, `currentOperation` — all but `story.md`, which the story agent writes in English whatever it is. Substitute it like any other placeholder; an agent that receives it unresolved has nothing to fall back on |

## Model and effort

Step 1 carries `agents`: which model this task's sub-agents run on and how hard they are told to
think. Keep it as `agents(T)` and read it at every spawn.

    { model, effort, steps: { "2": {model, effort}, "3": …, "4": …, "5": …, "6": …, "7": …, "8": … } }

Every field is `""` when the user left it on Inherit. A step reads its own override first and
falls back to the task-wide pair — `model = agents.steps[N].model || agents.model`, same for
`effort`. Step 1 has no entry: the form is step 1.

- **Model** goes to the Agent tool's `model` parameter as is: one of the `value`s you wrote to
  `models.json` in Setup step 3.
  Empty → omit the parameter entirely and let the session's default stand. Never invent a value;
  the server already refuses anything outside that list, so an empty string means inherit, not
  "ask the user".
  One exception: step 7 (Mockoon) resolves an empty model — both its own and the task-wide one —
  to `sonnet` when `models.json` lists it, not to the session's default. The step transcribes
  contracts and code the task already has into one JSON environment, work Sonnet does as well as
  Opus at a fraction of the tokens. Without `sonnet` on the list the step inherits like any other.
  A model the user picked for step 7, or task-wide, always wins.
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
- **The step failed** → its agent is gone. Remember nothing: the server already put the line in
  that step's `chat` with a `time`, and your own memory of a long run is summarised away long
  before the user gets round to clicking retry. POST
  `{"taskId":"T","step":N,"logEntry":"Message kept for the retry"}` so the user can see it landed
  somewhere. On `retry`, re-read the step from `/api/state` and hand the fresh agent every `user`
  entry of its `chat` whose `time` is later than that step's failure — the `log` entry you wrote
  when it failed — under a `## What the user added after the failure` heading.
- **The step has no agent yet** (the user wrote ahead of the pipeline) → the same, and simpler:
  nothing in that step's `chat` predates a failure, so when you spawn it, put every `user` entry
  of the transcript into that step's prompt.

Messages never queue and never lock the panel, so several may arrive in a row: forward each in
order and drop none. The agent answers in the step's transcript by POSTing `chat` itself, so its
replies never pass through you — which is what keeps a long conversation out of your context.
Steps 2, 3 and 8 keep their own fields for their own purposes: a question is still answered with
`answer`, plan and story feedback is still `decision`, mockup feedback is still `mockup`. A
`message` on those steps is an aside to the same agent and is forwarded exactly like any other.

**Attached images.** Wherever this file says to SendMessage what the user wrote — an `answer`, a
`feedback`, a `message` — and it carries `attachments`, end the forwarded text with one more line,
which is the whole message when the text is empty:
`Attached images (Read each one): <path>, <path>` — a FIXED IDENTIFIER, English verbatim, because
the agent briefs look for it. Never Read the images yourself: the agent that acts on them does, and
an image in your context is paid for on every turn after it. A step's `chat` keeps them on the
`user` entry as bare file names in `attachments`; when you hand such entries to a fresh agent (a
retry, or a spawn after the user wrote ahead), turn each name into
`<SESSION>/tasks/T/attachments/<name>` and put the same line under the entry.
The same line ends the `## Task description` of `requirements.md` when the form carries `images`,
the pictures the user attached to the description (step 1, point 3): every agent that reads the
description reads them with it — and you still never do.

**Deleted lines.** The × on one of the user's own lines in a step's transcript — a composer
message, or mockup feedback — reaches you as
`{"kind":"delete","taskId":"T","step":N,"id":…,"text":"…"}` once the server has taken the line
out of that step's `chat`. Like a message, it is never a decision and moves nothing:

- **That step's agent is alive** — working, waiting at a gate, or stopped → SendMessage
  `[Deleted] The user deleted their message: "<text>"` (a FIXED IDENTIFIER, English verbatim),
  plus, when it carries `attachments`, the line `Its images: <path>, <path>` — never the
  `Attached images` line, which would have the agent Read them again. The agent drops what that
  line asked for, then carries on or ends with `noted` (see "Hard rules").
- **The step failed, or has no agent yet** → POST
  `{"taskId":"T","step":N,"logEntry":"Message deleted; the retry will not get it"}` and nothing
  else: a retry or a first spawn reads the step's `chat` afresh, and the line is no longer in it.

## Stopping a step

Every running step's panel has a Stop button. It halts what the step's agent is doing and nothing
else: the step stays `in_progress`, an open question, plan, story or mockup gate stays open, and
the panel only notes that the agent was stopped. It reaches you as
`{"kind":"stop","taskId":"T","step":N}` once the server has flagged the step `stopped` and logged
`Stopped by the user`. Your part:

1. Stop step N's agent with the TaskStop tool (the id from `agentIds(T)`) and KEEP the id: the
   user's next word goes to the same agent, which resumes with its context. Its ending carries no
   JSON and moves nothing (see "Hard rules"). An agent idle at a gate has nothing to halt, and the
   call changes nothing.
2. A result that beat the stop, or still arrives from the agent, is handled as usual: it moves the
   step on, and the server drops the flag once the step leaves `in_progress` or opens a gate.
3. Whatever the user sends the stopped step next arrives with `afterStop: true`. Forward it as
   its kind says, with `[Stopped] The user stopped you mid-work; what follows is what they sent next.`
   (a FIXED IDENTIFIER, English verbatim) on its own line first. Every kind but `delete` also ends
   the stop on the server, so the answers after it come without the marker. Two cases differ:
   - `approve` at step 2 or 8 normally needs no agent, but a stopped one may have half-rewritten
     the plan or the story the user approved. SendMessage
     `[Stopped] APPROVED AS SHOWN — undo whatever you changed after your last result, then reply with that result JSON again.`
     (a FIXED IDENTIFIER) and, when that result arrives, POST the gate's `approve` body (step 2
     point 4, step 8 point 3) instead of opening the gate again.
   - `approve` at step 3 is the usual `APPROVED — …` text after the `[Stopped]` line: the mockup
     brief puts the round on screen back before recording it.
   The agent then answers with its usual JSON, or with `noted` when the user only asked or
   remarked something.
4. When SendMessage cannot reach the agent any more, spawn a fresh one for the step, per
   "Spawning a sub-agent", with every `user` entry of the step's `chat` under `## What the user
   said in this step` and the forwarded text last.
5. A stopped step 5 keeps the E2E slot. To abandon a stopped step, the user tells its agent
   to give up: it ends with its error JSON, and the failure protocol takes it from there.

## Server helpers (use exactly these shapes)

- Update state:
  `curl -s -X POST http://127.0.0.1:PORT/api/state -H "content-type: application/json" -d "<json>"`
  Every body MUST carry `"taskId":"<id>"`; without it the server answers 400. Fields:
  `{"taskId":"t1","step":N,"status":"waiting|in_progress|completed|failed","enabled":true|false,"progress":0-100,"currentOperation":"...","report":"...","logEntry":"...","activeStep":N,"branch":"...","root":"...","question":{...}|null,"reviewSummary":{...}|null,"mockupReview":{...}|null,"reopenGate":true,"chat":{"role":"agent|user","text":"..."},"mockupChat":{"role":"agent|user","text":"..."},"summary":{...}}`
  `reopenGate` puts a plan, story or mockup gate the user answered with feedback back on screen
  as it was (see `noted` in "Hard rules"); with no such gate it changes nothing.
  `chat` appends to the transcript of the step named in the same body — every step has one, and
  it is what the panel's composer writes into and reads back. A body carrying `chat` without
  `step` is answered 400: the line would have nowhere to go. `mockupChat` is the same thing
  under the step-3 composer's own name, kept so the mockup agent needs no step number.
  Both carry the AGENT's lines only — the server records the user's own the moment the
  browser sends them, so a copy from you would show the same message twice.
  Step ids are fixed (1 Requirements, 2 Feature Refinement, 3 Mockups, 4 Implementation,
  5 Validation & E2E, 6 Code Review, 7 Mockoon Mocks, 8 Story Description). The id is a name, not a
  position: the stepper shows step 8 between 3 and 4, in the order the pipeline runs them. Steps 2,
  3 and 8 are optional, and the SERVER sets their `enabled` from the switches of every `step1`
  answer before you see it — never POST `enabled` for them yourself. The stepper hides a disabled
  step and numbers the tiles it shows, so a task with only refinement shows five tiles numbered
  1-5 plus the Mockoon one. Step 7 is always visible and stays `waiting` through the whole run — it
  only moves when the user asks for mocks on the summary screen.
  A body binds to ONE task and its step fields bind to ONE step, so merge consecutive updates into
  ONE POST only when they share both and nothing (user interaction, agent work) happens between them
  — e.g. completing a step and activating the next in the same task is a single body.
- Wait for a user answer: only through the background waiter of the event loop (point 1), which
  long-polls `/api/answer?taskId=T&session=<this session's id>&wait=290` →
  `{"answer":{...,"taskId":"T"}|null}` for you. Never curl `/api/answer` yourself: two pollers split
  the answers between them, and a poll without `taskId` takes other tasks' answers from their own
  orchestrators. The `session` is the claim: the first session to poll a task orchestrates it while
  it is alive, and the server answers any other one `409` (the waiter's `ORCHESTRATOR_RUNNING`).
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
while still writing task 2. A task's first submission is also what gives it an orchestrator: the
server opens a new terminal in `PROJECT` running
`claude "/doh:implementNewFeature --attach <id> --port PORT"`, and that session runs the task (see
"Attach"). Nothing about it is yours: a `step1` reaches you for T only. When no terminal opens, the
stepper's top-right corner shows the task's orchestrator `closed` with an "Open session" button
that offers the command to run by hand.

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
   <"Attached images (Read each one): " and the absolute path of every entry of images, under <SESSION>/tasks/T/images/, joined by ", " — the line only when images is not empty>

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

   ## Pipeline steps
   Refinement: <"on" if refinement, else "off">  |  Mockups: <"on" if generateMockups, else "off">  |  Story: <"on" if storyDescription, else "off">

   ## Code review
   Run 1: <the run's flags separated by spaces, or "—" when it has none>
   <one such line per entry of codeReview, numbered from 1>

   ## Agent settings
   Model: <agents.model or "inherit">  |  Effort: <agents.effort or "default">
   Overrides: <"step N: model/effort" for every step that has one, or "—">
   ```

   The last three sections are records for the user and for the revision diff, not instructions:
   nothing in them is scope. The one exception is `## Code review`, which the review agent reads
   in step 6 to know which `doh:codeReview` runs to make, so that heading and the `Run <n>: `
   prefix are FIXED IDENTIFIERS — English verbatim, whatever `{{LANGUAGE}}` is — and the flags go in
   exactly as the answer spells them.

   (Uploads already sit in `<SESSION>/tasks/T/mockups/`, `contracts/` and `hints/`.)
4. Remember `REFINEMENT(T) = answer.refinement`, `MOCKUPS(T) = answer.generateMockups` and
   `STORY(T) = answer.storyDescription`. They shape **the route**: after step 1 a task runs
   2 → 3 → 8 → 4 → 5 → 6, skipping each of 2, 3 and 8 whose switch is off. "The next step" below
   always means the next one on that route. The server has already set the three steps' `enabled`
   from this answer, so post nothing for that.
5. POST `{"taskId":"T","step":1,"status":"completed","activeStep":<the next step>}` and start that
   step for T. With all three switches off that is step 4, so from then on only the settings can change.

## Revising step 1 (a later `step1` answer)

Walking back to the requirements form costs nothing: its tile is always there, and reading the form
changes no state. What reaches you is the RESUBMISSION, and the browser only offers that button once
a field, a file, a switch, a review run, the agent settings or the credentials actually differ from
the last submission — so every later `step1` answer carries a real change, which the server has
already measured in its `revision`:

    {"changed":["description","codeReview"],"restartAt":2,"switchedOn":[],"switchedOff":[3],
     "files":[{"category":"hints","name":"flow.png","change":"added"}]}

- `changed` lists the groups that differ, by the server's names — FIXED IDENTIFIERS. The FLOW
  groups are what the steps before implementation read: `description` (the text or its images),
  `branch`, `steps` (a switch), `materials` (hint files or the note), `mockups` (uploaded mockups)
  and `contracts` (files or pasted text). The SETTINGS are read only when something starts:
  `codeReview`, `agents` and `authorization`.
- `restartAt` is the step the pipeline goes back to, or `null` when nothing that already ran read
  what changed. A change to the description, materials, mockups or contracts repeats the first step
  of the route that has started; a step switched on repeats itself when a later step already ran
  without it; a step switched off repeats every started step that read its output, and hands over
  to the next step of the route when the pipeline was sitting on it. The branch alone and every
  setting give `null`: nothing before implementation reads them.
- `switchedOn` and `switchedOff` are step ids. `files` names every upload added, removed or
  replaced since the last submission; its `category` is `images`, `hints`, `mockups` or
  `contracts`.

The server has ALREADY moved the pipeline when the answer reaches you, because the page sends the
user to `restartAt` at once and has to find it working: that step is `in_progress` with the log
entry `Requirements changed (…) - the pipeline continues from here`, `activeStep` points at it,
every later step and every switched-off one is back to `waiting`, and the question, the plan or
story gate and the mockup gate are closed. Do not post any of that again. Step 1 stays `completed`: never send
it back to `in_progress`, and never POST `activeStep:1` — only the user walked back.

The flow groups can change until step 4 starts and the settings until the task's final summary;
the server refuses anything else with a 409, and the page never offers it. A revision can
therefore arrive at any moment — while an agent is thinking, while its question is on screen,
while a gate is open, during implementation, validation or the review. Take it whatever T was
doing, in this order:

1. Write the requirement files:
   - **settings only** (`changed` holds no flow group) → write the new `requirements.md`, and that
     is all: no `revisionCount`, no `requirements-changes.md`;
   - **any flow group** → `revisionCount(T)++`, copy `requirements.md` to `requirements-prev.md`,
     write the new `requirements.md`, then write `requirements-changes.md`: a `## Revision <n>`
     heading and a bullet list naming the changed groups, every entry of `files` with its change
     (added, removed or replaced), and any change to the branch, a switch, the review runs or the
     agent settings. Name the changes; do NOT copy the field bodies — they are already in the two
     files.
2. Remember the new `branch`, `REFINEMENT(T)`, `MOCKUPS(T)`, `STORY(T)` and `agents(T)`. When
   `authProvided` turned false, delete `<SESSION>/tasks/T/auth.json`, so no later step logs in with
   credentials the user took back. Each setting is read where it is used, so none needs a message:
   - `agents` at the next spawn ("Model and effort") — never by an agent already running, or one a
     revision continues by SendMessage; say so in the terminal if the user asks why a step still
     runs on the old model;
   - `## Code review` by the review agent before EACH of its runs: the run in progress finishes as
     it started, and the next one follows the new list, so fewer runs end the review sooner;
   - the credentials when step 5 starts, a retry included.
3. Drop every step in `switchedOff`, whatever it was doing — nothing it left behind may reach a
   later step:
   - its agent, when still running → stop it with the TaskStop tool (the id from `agentIds(T)`) and
     forget the id; a result or a completion notice that still arrives from it belongs to no step,
     so ignore it;
   - delete its artifacts in `<SESSION>/tasks/T`: refinement → `spec.md`, `plan.md`,
     `checklist.md`; mockups → `generated-mockups/`, `mockup-screenshots/` and `ui-design.md`;
     story → `story.md`;
   - POST `{"taskId":"T","step":<N>,"status":"waiting","progress":null,"currentOperation":""}`, so
     the tile starts clean if a later revision turns it back on — the server has usually done it
     already, and once more costs nothing.
4. `restartAt` is `null` → nothing repeats. Whatever was running carries on, and each step the
   route has not reached yet reads the new `requirements.md` when it starts. Back to the loop.
5. Otherwise every step from `restartAt` on takes the change when the route reaches it —
   `restartAt` now, each later one when the step before it completes, as on the first pass:
   - **Refinement that was already on** → REDUCED SCOPE. `SendMessage` the EXISTING refinement
     agent — do not re-spawn it: its project exploration, spec, plan and whole Q&A ARE the reduced
     scope.

         Requirements changed. Read <SESSION>/tasks/T/requirements-changes.md, then requirements.md
         and requirements-prev.md, then every file it names as ADDED or REPLACED under images/,
         hints/, contracts/ and mockups/. Revision mode: patch spec.md, plan.md and checklist.md
         only where the change lands, ask only what the change opens, do not re-explore the
         project, and keep the ## UI design section. Reply with the result JSON.

     When this revision turned Mockups OFF, append: `The mockups toggle was turned OFF — remove the
     ## UI design section and the verify: visual checklist lines.`
     If SendMessage cannot reach it, spawn a fresh refinement agent — render the brief again and
     put that paragraph in the spawn prompt. Then continue at step 2's gate as usual.
   - **Mockups whose screens are on disk** (`generated-mockups/manifest.json` exists) → POST step
     3's point 1, then `SendMessage` the EXISTING mockup agent instead of spawning one:

         Requirements changed. Read <SESSION>/tasks/T/requirements-changes.md, then requirements.md
         and requirements-prev.md, and revise the screens as your brief's Revision mode says.

     Then loop on its JSON from step 3's point 3. If SendMessage cannot reach it, spawn a fresh
     mockup agent with that paragraph in the prompt.
   - **Implementation** → step 4 from its point 1.
   - **Anything else** — a step this revision switched ON, mockups with no screens yet, and the
     story always — runs from its point 1 with a fresh agent: the first two have nothing to revise,
     and a story has no conversation worth keeping. An agent of that step still running from
     before is stopped with TaskStop first.
6. While an earlier step repeats, an agent of a later one can still be busy with the old
   requirements, and the server has already put its step back to `waiting`. Stop a story agent
   with TaskStop — it restarts fresh anyway. Keep a mockup agent for its conversation, but ignore
   whatever it returns before the route reaches step 3 again; the message above carries the change
   then.

## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"taskId":"T","step":2,"status":"in_progress","activeStep":2,"progress":5,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent from `references/refinement-agent.md`, per "Spawning a sub-agent".
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"taskId":"T","question":{...}}`, wait for
     T's `kind=="answer"`. The server has already taken the question down and logged the answer
     (see "A send takes its gate off the screen"), so POST only
     `{"taskId":"T","step":2,"progress":<min(60, 20+5×answers so far)>}`, then SendMessage the
     answer text to the agent. You own the Q&A progress — the agent does not report between
     questions. A `message` for step 2 before its next JSON is the user adding to what they just
     said: SendMessage it to the same agent and keep waiting for that JSON.
   - `{"type":"result","summary","critical"}` → spec/plan/checklist now exist in `<SESSION>/tasks/T`. Go to 4.
   - `{"type":"error","report"}` → failure protocol (below) for step 2.
4. Gate: POST `{"taskId":"T","reviewSummary":{"text":"<summary>","critical":[…]}}`, with `critical`
   copied from the result as it came (`[]` when it has none): the panel lists it as "Critical
   information" above the summary, where approving cannot pass it by. Wait for T's `kind=="decision"`:
   - `approve` → POST `{"taskId":"T","reviewSummary":null,"step":2,"status":"completed","activeStep":<the next step>}`; continue there.
     With `afterStop`, the agent first restores the plan it showed ("Stopping a step", point 3).
   - `feedback` → SendMessage the feedback to the agent; back to 3. The gate is off the screen
     already, and the agent's next result puts the revised plan up in its place.

## Step 3 — Mockups (interactive, conditional)

Runs ONLY when `MOCKUPS(T)`. Otherwise skip the whole step: it stays `enabled:false` / `waiting`, the
stepper never shows it, and the step before it already moved `activeStep` past it.

The agent designs from what refinement settled when step 2 ran, and from the requirements form
alone when it did not — its brief tells the two apart by whether `spec.md` exists, so nothing
about it reaches the prompt.

1. POST `{"taskId":"T","step":3,"status":"in_progress","activeStep":3,"progress":5,"currentOperation":"Designing screens"}`.
2. Spawn the mockup agent from `references/mockup-agent.md`, per "Spawning a sub-agent".
3. Keep only `mockupRounds(T)`, for the progress bar. The chat transcript and the `rev` the UI
   re-renders on are the SERVER's — never hold either in your context. Loop on the agent's final JSON:
   - `{"type":"mockup","summary","screens":[{"id","view","title","file"}]}` → `mockupRounds(T)++`,
     take the round's screenshots (below), then POST
     `{"taskId":"T","step":3,"progress":<min(90, 20+10×mockupRounds)>,"currentOperation":"Waiting for your review","mockupReview":{"text":"<summary>","screens":[…]},"mockupChat":{"role":"agent","text":"<summary>"}}`.
     Omit `rev`: the server stamps the next one itself, so a round can never reuse a number and
     leave the panel locked. The chat is not part of the round at all — it belongs to step 3 and
     the server appends `mockupChat` to it, which is why clearing `mockupReview` never erases the
     conversation.
     Take the screenshots with `node "<SKILL_DIR>/scripts/screenshot-mockups.cjs" "<SESSION>/tasks/T"`.
     It refills `<SESSION>/tasks/T/mockup-screenshots/` with one full-page PNG per manifest entry —
     every state of every view, each loaded through its `#<id>` fragment — at desktop width
     (1280 px), named `<id> <view> - <title>.png`, the id numbered `{0-9}.{0-99}` (view, then
     state, both from 0); the panel's "Open screenshots folder"
     button opens that folder for the user. It prints one line, a FIXED IDENTIFIER:
     `SCREENSHOTS <count> <dir>`, or `SCREENSHOTS_FAILED <reason>` — then post the round anyway,
     with `Screenshots could not be taken: <reason>` at the end of the `mockupChat` text. The first
     time the reason says the skill's Playwright is not installed or Chromium did not start, run
     `npm --prefix "<SKILL_DIR>" install` and
     `node "<SKILL_DIR>/node_modules/@playwright/test/cli.js" install chromium`, then try once more.
     Never Read the screenshots: they are for the user.
     Then wait for T's `kind=="mockup"`:
     - `decision=="feedback"` → SendMessage the feedback text to the agent, and post nothing: the
       server already took the round off the screen, put the step at `Reworking the mockups…` and
       appended the line to the transcript — a `mockupChat` copy would show it twice. What the user
       adds while the agent reworks comes from the step's composer as `message`: SendMessage each
       one as it comes, in order, and keep waiting for the round. Back to 3.
     - `decision=="approve"` → SendMessage exactly (a FIXED IDENTIFIER — English verbatim):
       `APPROVED — record the approved design as your brief's Approval section says, then reply
       with the result JSON.` Back to 3.
   - `{"type":"result","summary","screens":[…]}` (only ever arrives after the approval message) →
     POST `{"taskId":"T","step":3,"status":"completed","progress":100,"mockupReview":null,"activeStep":<the next step>}`
     and continue there. Keep the screen count and the summary only — never the mockup markup.
   - `{"type":"error","report"}` → failure protocol for step 3.

## Step 8 — Story Description (interactive, conditional)

Runs ONLY when `STORY(T)`, as the last step before implementation. Its id is 8 only because ids
are never renumbered; the stepper shows its tile between Mockups and Implementation. Otherwise
skip it like step 3.

1. POST `{"taskId":"T","step":8,"status":"in_progress","activeStep":8,"progress":5,"currentOperation":"Writing the story"}`.
2. Spawn the story agent from `references/story-agent.md`, per "Spawning a sub-agent". It picks its
   sources from what exists — the refinement and mockup results when those steps ran, the task
   description and the uploaded mockups when they did not — so nothing about the switches goes
   into the prompt.
3. Loop on the agent's final JSON:
   - `{"type":"result","criteria":N,"summary"}` → `<SESSION>/tasks/T/story.md` exists. Keep the
     count and the summary only: the browser fetches the story itself from
     `/api/story?taskId=T`, so NEVER read story.md, and never paste it into a message or into
     `/api/state`. Open the gate — the plan gate's `reviewSummary`, whose `rev` the server stamps
     the same way — with
     `{"taskId":"T","step":8,"progress":90,"currentOperation":"Waiting for your review","reviewSummary":{"text":"<summary>"},"logEntry":"Story written: <N> acceptance criteria"}`,
     then wait for T's `kind=="decision"`:
     - `feedback` → SendMessage the feedback text to the agent, with its attachments line, and
       post nothing: the server already took the gate off the screen, put the step at `Reworking
       the story…` and put the feedback in its transcript. What the user adds while the agent
       reworks comes from the step's composer as `message`: SendMessage each one as it comes, in
       order. Back to 3 — every result opens the gate again, and its new `rev` puts the revised
       story on screen.
     - `approve` → POST
       `{"taskId":"T","reviewSummary":null,"step":8,"status":"completed","progress":100,"activeStep":4}`
       and start step 4 — with `afterStop`, only once the agent has restored the story it
       showed ("Stopping a step", point 3). When a feedback you forwarded has no result yet, wait for the agent's
       next result first and post this instead of a new gate: the user approved with the change
       on its way, and implementation must not start on a story that is being rewritten.
   - `{"type":"error","report"}` → failure protocol for step 8.
4. A result that arrives after step 8 completed means the agent was still busy with something the
   user sent — a second feedback, or a line typed before the gate opened — and story.md was
   rewritten: POST only `{"taskId":"T","step":8,"logEntry":"Story updated"}`. The steps already
   past it read the file when they start, so say so in the terminal if the user asks why a running
   step missed the edit.

## Step 4 — Implementation (view-only)

1. Pick this task's working directory `ROOT`, once, here. A new branch starts from the
   repository's main branch `BASE`, never from whatever happens to be checked out — unless the user
   asked for another start (a branch they named, or the current one) in the requirements or since,
   and then from that. `BASE` is the first that `git -C "<PROJECT>" rev-parse --verify --quiet <name>`
   finds of: the name `git -C "<PROJECT>" symbolic-ref --short refs/remotes/origin/HEAD` gives
   without its `origin/`, `main`, `master`, then the same three under `origin/`. A branch that
   already exists is checked out as it is, with its own commits.
   Every task's orchestrator picks on its own, so the project's checkout is the server's to hand
   out: POST `{"taskId":"T","root":"<PROJECT>"}` first.
   - `200` → `ROOT = PROJECT`, T's for the rest of the run, and
     `git -C "<ROOT>" checkout -b <branch> <BASE>` (or `checkout <branch>` when it already exists).
     When git refuses because of local changes, go to
     the failure protocol with its message — never stash, reset or discard the user's work.
   - `409` (`root … is task tN's`: another task has it) →
     `ROOT = <parent of PROJECT>/<basename of PROJECT>-worktrees/<slug>-<taskId>`,
     where `<slug>` is the branch with `/` and non-ASCII replaced by `-`. The task id is what keeps
     the path unique: two different branches can slugify to the same string, and `worktree add`
     would then fail on an existing directory. Create it with
     `git -C "<PROJECT>" worktree add "<ROOT>" -b <branch> <BASE>`.
     When the branch already exists and is not checked out anywhere, use
     `git -C "<PROJECT>" worktree add "<ROOT>" <branch>`. When it IS checked out elsewhere, go to
     the failure protocol with a report naming the conflict.
   A fresh worktree has neither `node_modules` nor the untracked local config the app needs. Bootstrap it before spawning anything, with ONE call (Bash tool):

       node "<SKILL_DIR>/scripts/bootstrap-worktree.cjs" --root="<ROOT>" --project="<PROJECT>"

   It installs from whatever lockfile the project committed and copies every `.env*` across at
   the same path relative to the root — they are gitignored, so a fresh worktree has none of them,
   and one nested in a workspace package is the one whose absence looks like an application bug in
   step 5 rather than a missing file. Do NOT do either by hand: the copier skips `node_modules`,
   build output and the run's own `.claude` folder, and a hand-rolled walk of the project finds a
   dependency's `.env.example` long before it finds the project's own.
   `errors[]` non-empty → failure protocol for step 4. `warnings[]` is not a failure: a failed or
   skipped install means step 5 cannot run the suites, and it is reported, not retried. Keep
   `installed` and say so in the summary. When `ROOT` is `PROJECT` the call is a no-op that says so —
   that checkout already has both. Playwright is unaffected either way: the pipeline keeps using
   the plugin's own installation in `SKILL_DIR`.
   POST `{"taskId":"T","root":"<ROOT>"}` so the summary can name it.
2. POST `{"taskId":"T","step":4,"status":"in_progress","activeStep":4,"progress":0}`.
3. Spawn the implementation agent from `references/implementation-agent.md`, per "Spawning a
   sub-agent" (`ROOT` is the one step 4 just fixed). It reports progress itself via POST /api/state and writes code
   against the `doh:codeReview` checklist of each file's kind (its "Coding rulebook" section).
   It builds from what the optional steps left — spec and plan, the approved mockups, the story —
   and falls back to the requirements form for each one that did not run; its brief tells them
   apart by which files exist, so nothing about the switches goes into the prompt.
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

Take the E2E slot first (see "E2E slot"): POST `/api/e2e` with `{"taskId":"T"}`, and on
`{"granted":false,…}` wait for T's `kind=="e2e"` before point 1.

1. POST `{"taskId":"T","step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`, per "Spawning a sub-agent". It runs the task's own unit
   suite, then writes and runs the E2E suite on the plugin's own Playwright, and uses the user's
   Chrome (Claude in Chrome extension) for discovery, failure debugging and a UX pass — expect a
   tab to open there during this step. Endpoints the backend does not serve yet are faked in the
   app's code for the length of the step and removed before it ends (archived to
   `<SESSION>/tasks/T/mocks/`), so step 6 and the commit never see them. Without refinement there
   is no `checklist.md`: the agent writes one from the task description, the story and the approved
   screens before it tests anything, as its brief says — nothing about it goes into the prompt.
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the extension is unavailable, and it is
     REQUIRED: the agent is blocked until the user installs/enables it. POST `{"taskId":"T","question":{...}}`,
     wait for T's `kind=="answer"` — the server has already taken the question down and logged
     the answer — then POST `{"taskId":"T","step":5,"currentOperation":"Retrying the Chrome extension…"}`
     and SendMessage the answer text to the agent. Never tell it to continue without the
     extension, and never re-spawn it with that requirement waived.
   - `{"type":"result","compliance":NN,"testsSummary","unitSummary","mockupSummary","uxSummary","apiMockSummary"}`
     with `compliance>=99` → POST completed (the server hands the slot on). Keep `apiMockSummary` for the
     final summary — it says which endpoints were faked, so the user knows what was never proven
     against a real API.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit suite that stayed red, or an
     extension that never became available) → failure protocol. T keeps the slot across a
     `retry`, because the retry is still T inside step 5; a `finish` frees it with the summary.

## Step 6 — Code Review (view-only)

1. POST `{"taskId":"T","step":6,"status":"in_progress","activeStep":6,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent" (it reviews exclusively via the `doh:codeReview` skill — no other review method, pointed at this task's `ROOT`. It makes the runs the form set, one to three, read from `requirements.md`'s `## Code review` with exactly the flags listed there, re-reading that section before every run so a revision made during the review reaches only the runs not yet started, and stops early when a run finds nothing, or when a `--since-last` run would only re-check a run that fixed nothing; it fixes every finding except the ones that would break functionality, contradict the requirements or leave the mockups).
3. `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` → delete `<SESSION>/tasks/T/auth.json` if it exists
   (step 6's regression run is its last consumer, so the credentials die with the step, not with the
   pipeline), then POST completed. `error` → failure protocol.

## Step 7 — Mockoon mocks (on demand, view-only, per task)

Never part of a task's run: the tile waits until the user clicks "Generate Mockoon mocks" on that
task's summary screen, which reaches you as `{"kind":"summary","decision":"mockoon","taskId":"T"}`.
It can run any number of times ("Regenerate" is the same step over the same file).

1. POST `{"taskId":"T","step":7,"status":"in_progress","activeStep":7,"progress":0}` — this also
   pulls the browser off the summary and onto the step's panel.
2. Spawn the mockoon agent from `references/mockoon-agent.md`, per "Spawning a sub-agent". It
   reads spec/plan (the task description and the story when refinement did not run), the contracts
   and the implemented code, and writes `<SESSION>/tasks/T/mockoon.json`
   (one environment on `localhost:3000`). The browser fetches that file itself from
   `/api/mockoon?taskId=T` — NEVER read it, never paste it into a message or into `/api/state`.
3. `{"type":"result","routes":N,"summary"}` → POST `{"taskId":"T","step":7,"status":"completed","progress":100}`;
   the panel then shows the JSON with a Copy button. Keep the route count and the summary only.
4. `{"type":"error","report"}` → POST `{"taskId":"T","step":7,"status":"failed","report":"<report>"}`, then wait
   for T's `kind=="decision"`: `retry` → the server has already put step 7 back
   `in_progress`, so just re-spawn the agent **fresh**; `finish` → the user went back to the summary, so leave the step
   failed and keep looping.

## Failure protocol (any step, any task)

1. POST `{"taskId":"T","step":N,"status":"failed","report":"<report>","question":null}` — clearing
   the question matters: a step that failed while waiting for an answer would otherwise re-show that
   stale question the moment a retry flips the status back to in_progress.
2. Wait for T's `kind=="decision"`:
   - `retry` → the server has already put the step back `in_progress` and cleared its `report`
     (post neither); re-spawn that step's agent **fresh**: render its brief again, then a new Agent call whose prompt carries the
     pointer plus a note about the previous failure report path plus every `user` entry of that
     step's `chat` later than its failure log entry, under `## What the user added after the
     failure`. Read them back from `/api/state` rather than from memory: on a long run yours has
     been summarised since. The re-spawn reads `agents(T)` again, so a model changed since the
     failure takes effect here.
   - `finish` → write that task's final summary (below, including the `auth.json` cleanup) with
     `finalStatus:"Failed at <step name>"` — the NAME (`Implementation`, `Validation & E2E`), never
     the id. The stepper numbers the tiles it shows, in pipeline order, so with only refinement on
     step 4 is the tile labelled 3 and with a story it is not even the next id: an id quoted at the
     user points them at the wrong tile. Names never drift.
3. The E2E slot needs nothing from you: a `finish` sets T's summary, and that frees the slot for
   the next task in the queue.
4. A failed task does not end the run: the other tasks go on in their own sessions.

## Final summary (per task)

1. Delete `<SESSION>/tasks/T/auth.json` if it still exists — step 6 normally already did, so this is
   the backstop for tasks that never got there (the server also wipes every task's on shutdown). Do
   this on BOTH outcomes — success and `finish` after a failure.
2. Collect from step results only (no file contents): changes, features, tests (E2E suite + the project's unit suite), API mocks, mockup comparison, UX findings, review results, and step 4's deviations when it reported any — they belong at the end of `changes`, prefixed so a reader sees at once that the run departed from the plan.
3. POST `{"taskId":"T","summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","apiMocks":"...","mockupComparison":"...","uxReview":"...","codeReview":"..."}}` (`tests` = the validation agent's `testsSummary` and `unitSummary`; `apiMocks` = its `apiMockSummary`; `mockupComparison` = its `mockupSummary` - every renamed field is listed here, so a missing line reads as "no source" and the section lands empty even when the step did the work; `uxReview` = its `uxSummary`; `codeReview` = the review agent's `reviewSummary`, which also names every finding it rejected and on what ground). Put the task's branch and `ROOT` at the top of `changes` so the user can find the work.
4. Stage that task's changes: `git -C "<ROOT>" add -A` (already done by its step-6 agent; verify with
   `git -C "<ROOT>" status --short`). Worktrees have their own index, so tasks never stage into each other.
5. Print T's summary in the terminal (user's language): its branch, working directory and final
   status, then the details. Every other task's orchestrator prints its own.
6. Suggest `superpowers:finishing-a-development-branch` for T's branch, and — when T got a
   worktree — `git worktree remove <ROOT>` AFTERWARDS, in that order. The order is not a preference:
   the pipeline deliberately ends with the work staged and uncommitted, and `git worktree remove`
   refuses a worktree in that state (`fatal: ... contains modified or untracked files`). Say so when
   you suggest it, and say plainly that `--force` is NOT the way around it — it would delete the
   feature the run just built. Finish the branch first (commit, merge or PR), then remove the
   worktree; the pipeline never removes one itself, and it holds copies of the project's `.env*`
   files, so an abandoned worktree leaves those sitting outside the project.
7. Leave the server running — other tasks may still be on it. Do NOT kill the PID yourself. After
   the summary, keep T's waiter listening (start it if none is) and serve what it brings — a
   "Generate Mockoon mocks" press arrives this way — but when it ends in `WAIT_TIMEOUT`, end your
   turn WITHOUT starting another. Tell the user, in the summary, that a button pressed after that
   waits in the server until they type anything in this terminal, or until "Open session" in the
   stepper's corner opens a new one for T; then drain the queue with
   `node "<SKILL_DIR>/scripts/wait-answer.cjs" --port PORT --task T --minutes 0` in the foreground,
   act on each `ANSWER`, and go back to the event loop. The run ends when the user presses "Shut
   down server" — it stops every task's run, so they press it once the others are done too — or
   the server dies. Point them at the button rather
   than letting them close the terminal: pressing it is also what wipes every task's `auth.json`, so a
   run killed any other way leaves the credentials they typed sitting in the session directory
   (git-ignored, but still on disk) until they delete them by hand. The browser keeps its own copy
   when "Remember on this browser" was left ticked on the step-1 form — that one is the user's to
   clear, by unticking it, and no shutdown touches it. Say so if they ask where their password lives.

<!-- one-time:start -->
<!-- What follows runs once per run (Setup): it sits last, outside the head a compaction re-attaches. -->

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
3. Write `<SESSION>/models.json` with the Write tool, BEFORE the server starts (it reads the file
   once, at startup). It lists the models step 1 offers:
   `[{"value":"opus","label":"Opus 5.5"},{"value":"sonnet","label":"Sonnet 5"}, …]`
   - `value`: every value the Agent tool's `model` parameter accepts, copied from the tool's own
     schema exactly as it stands there: it goes to the spawn as is, so a value the schema does not
     list would only fail at that step's spawn.
   - `label`: the name and version this session's environment information gives for the model
     that value selects (e.g. `Opus 5.5`); the bare value when it names none.
   - `value` and `label` are FIXED IDENTIFIERS — the server reads them, whatever `{{LANGUAGE}}` is.
   A missing or unreadable file does not stop the run: the form then offers `opus`, `sonnet`,
   `haiku` and `fable` without versions.
4. Start the server (pick the script for the OS):
   - Windows: `powershell -NoProfile -File "<SKILL_DIR>/scripts/start-server.ps1" -SessionDir "<SESSION>" -ProjectDir "<PROJECT>" -Open`
   - POSIX: `bash "<SKILL_DIR>/scripts/start-server.sh" --session-dir "<SESSION>" --project-dir "<PROJECT>" --open`
   - `PORT` is **9999**, always. stdout is `{"port":9999}` — read it to confirm the server came
     up, not to learn a number. Tell the user the stepper is open at `http://127.0.0.1:9999/`.
     The port is fixed because the browser remembers things per origin: the stepper's tab, the
     agent model and effort from the last run, and the E2E credentials all hang off that one URL.
   - The launcher exits non-zero when something else holds 9999 — usually another run the user
     never shut down. Do NOT look for a free port and do NOT start the pipeline anyway: show the
     launcher's message, tell the user to close the other stepper with its "Shut down server"
     button, and stop your turn there.
   - The page's top-right corner shows THIS session's tokens, its 5-hour and weekly limits, your
     model, effort and context in use. Only Claude Code's status line receives those, so the
     server reads the snapshot `scripts/statusline-relay.cjs` keeps of it, per session id. Until
     the user's `statusLine` command runs through the relay
     (`node "<SKILL_DIR>/scripts/statusline-relay.cjs" <their command>`), the corner says so and
     names the script. Never edit the user's settings for it yourself, and never open their
     credentials to fill it in.
5. A run starts with one task, `t1`, and this session is its orchestrator: `T = t1`. POST
   `{"taskId":"t1","step":1,"status":"in_progress","activeStep":1}` and enter the event loop.

## Attach

`--attach <taskId> --port <n>` in the arguments means the stepper opened this session for ONE task
of a run that is already up — on that task's first submitted form, or from "Open session" in the
page's corner. The terminal runs `claude`, or what `DOH_CLAUDE_COMMAND` in the server's environment
names instead (e.g. `claude --permission-mode acceptEdits`). Do this instead of Setup:

1. `T` = the task id, `PORT` = the port, `SKILL_DIR` as in Setup point 1. Read
   `curl -s "http://127.0.0.1:PORT/api/orchestrator?taskId=T"`: `SESSION` = its `sessionDir`,
   `PROJECT` = its `projectDir`. The server and `models.json` are the run's: start or write
   neither. No reply means the run is over — say so and stop.
2. Take T over and drain what already waits for it, in the foreground:
   `node "<SKILL_DIR>/scripts/wait-answer.cjs" --port PORT --task T --minutes 0`.
   `ORCHESTRATOR_RUNNING <session>` → another session still runs T: tell the user and stop.
   `TASK_GONE` → stop.
3. Read T's entry of `/api/state` (its `branch` and `root` too) and go on from the first that fits:
   - a drained `step1` → "Step 1", as for any `step1`; step 1 never sent → the event loop, where
     the form arrives as one.
   - a summary → "Final summary", point 7.
   - a drained `e2e` → step 5 from point 1: the slot is T's. Step 5 `Waiting for the E2E slot` →
     POST `/api/e2e` again (the server keeps T's place) and wait for `kind=="e2e"`.
   - a step `failed` → "Failure protocol" from point 2.
   - a step after 1 `in_progress` with no question or gate on screen → its agent ended with the
     session that ran it: POST `{"taskId":"T","step":N,"currentOperation":"Resuming in a new session"}`
     and re-spawn it **fresh**, as a `retry` does, with "the session orchestrating T ended" in
     place of the failure report.
   Act on every other drained `ANSWER` as usual. Whatever would go to an agent of the old session
   goes to a fresh one, as "Stopping a step" point 4 says. Then enter the event loop.
