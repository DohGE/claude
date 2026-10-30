## Step 1 — Requirements (interactive, per task, repeatable)

The sidebar offers two ways to spin off a task: "Copy of current task" (the server creates it and
copies the open task step 1 form and its uploaded files) and "New empty task" (a blank form). Both
work from whatever step that task is on. Either way the browser switches to the new task and puts
it into its own step 1. There is NO barrier —
each task starts its own pipeline the moment ITS form is submitted, so the user can launch task 1
while still writing task 2. A task's first submission is also what gives it an orchestrator: the
server opens a new terminal in `PROJECT` running
`claude "/doh:implementNewFeature --attach <id> --port PORT"`, and that session runs the task (see
"Attach" in SKILL.md). Nothing about it is yours: a `step1` reaches you for T only. When no terminal
opens, the stepper's sidebar shows the task's orchestrator `closed` with an "Open session"
button that offers the command to run by hand.

On a `step1` answer for task T:

1. When `authProvided` is true, the browser has already written login+password for E2E tests to
   `<SESSION>/tasks/T/auth.json` — NEVER read, quote or copy that file; only the validation agent
   and the final review's regression run use it.
2. `branch` is the branch this task will be implemented on. Keep it; step 4 uses it verbatim.
   `commitMessage` is the message of the one commit "Create pull request" makes
   ("final-summary.md"); the page requires it, and an older form without one falls back to the
   branch name there. `agents` is the model and effort of every sub-agent of this task — the
   steps' agents and the helpers they spawn — keep it as `agents(T)` and read it at every spawn
   ("Model and effort").
3. Write `<SESSION>/tasks/T/requirements.md`:

   ```markdown
   # Requirements

   ## Task description
   <taskDescription>
   <"Attached images (Read each one): " and the absolute path of every entry of images, under <SESSION>/tasks/T/images/, joined by ", " — the line only when images is not empty>

   ## Branch
   <branch>

   ## Commit message
   <commitMessage or "—">

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
   Refinement: <"on" if refinement, else "off">  |  Mockups: <"on" if generateMockups, else "off">  |  Dark mockups: <"off" if darkMockups is false, else "on">  |  Story: <"on" if storyDescription, else "off">  |  Final review: <"on" if finalReview, else "off">

   ## Code review
   Run 1: <the run's flags separated by spaces, or "—" when it has none>
   <one such line per entry of codeReview, numbered from 1>

   ## Final code review
   Run 1: <the run's flags, or "—">
   <one such line per entry of finalCodeReview, numbered from 1; the single line "Off" when finalReview is false>

   ## Agent settings
   Model: <agents.model or "inherit">  |  Effort: <agents.effort or "default">
   Overrides: <"step N: model/effort" for every step that has one, and "<role>: model/effort" for every role that has one, or "—">
   ```

   The sections from `## Pipeline steps` on are records for the user and for the revision diff,
   not instructions: nothing in them is scope. The exceptions are `## Code review` and
   `## Final code review`, which the review agents read in steps 6 and 9 to know which
   `doh:codeReview` runs to make, so those headings and the `Run <n>: ` prefix are FIXED
   IDENTIFIERS — English verbatim, whatever `{{LANGUAGE}}` is — and the flags go in exactly as the
   answer spells them.

   (Uploads already sit in `<SESSION>/tasks/T/mockups/`, `contracts/` and `hints/`.)
4. Remember `REFINEMENT(T) = answer.refinement`, `MOCKUPS(T) = answer.generateMockups`,
   `STORY(T) = answer.storyDescription` and `FINAL(T) = answer.finalReview`. They shape **the
   route**: T's `route` in `/api/state` is the order, `2 → 3 → 8 → 4 → 6 → 5 → 9`, and the steps
   whose switch is off (`enabled:false` — the server sets it from this answer) are skipped. A task
   resumed from a run started before the final review existed has the route `… → 4 → 5 → 6` and
   no step 9. "The next step" always means the next enabled one on T's route.
5. POST `{"taskId":"T","step":1,"status":"completed","activeStep":<the next step>}` and start that
   step for T. With the three switches before implementation off that is step 4, so from then on
   only the settings can change.

## Revising step 1 (a later `step1` answer)

Walking back to the requirements form costs nothing: its tile is always there, and reading the form
changes no state. What reaches you is the RESUBMISSION, and the browser only offers that button once
a field, a file, a switch, a review run, the agent settings, the commit message or the credentials
actually differ from the last submission — so every later `step1` answer carries a real change,
which the server has already measured in its `revision`:

    {"changed":["description","codeReview"],"restartAt":2,"switchedOn":[],"switchedOff":[3],
     "files":[{"category":"hints","name":"flow.png","change":"added"}]}

- `changed` lists the groups that differ, by the server's names — FIXED IDENTIFIERS. The FLOW
  groups are what the steps before implementation read: `description` (the text or its images),
  `branch`, `steps` (a switch before implementation), `materials` (hint files or the note),
  `mockups` (uploaded mockups) and `contracts` (files or pasted text). The SETTINGS are read only
  when something starts: `codeReview`, `finalCodeReview` (its switch or its runs), `agents`,
  `authorization` and `commit` (the commit message).
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
while a gate is open, during implementation, validation or a review. Take it whatever T was
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
2. Remember the new `branch`, `REFINEMENT(T)`, `MOCKUPS(T)`, `STORY(T)`, `FINAL(T)` and `agents(T)`.
   When `authProvided` turned false, delete `<SESSION>/tasks/T/auth.json`, so no later step logs in
   with credentials the user took back. Each setting is read where it is used, so none needs a message:
   - `agents` at the next spawn ("Model and effort") — never by an agent already running, or one a
     revision continues by SendMessage; say so in the terminal if the user asks why a step still
     runs on the old model;
   - `## Code review` and `## Final code review` by their review agent before EACH of its runs: the
     run in progress finishes as it started, and the next one follows the new list, so fewer runs
     end the review sooner; a final review switched off while step 9 runs finishes that run and stops;
   - the credentials when step 5 or step 9's regression run starts, a retry included;
   - the commit message when "Create pull request" is pressed.
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
     agent — its project exploration, spec, plan and whole Q&A ARE the reduced scope:

         Requirements changed. Read <SESSION>/tasks/T/requirements-changes.md, then requirements.md
         and requirements-prev.md, then every file it names as ADDED or REPLACED under images/,
         hints/, contracts/ and mockups/. Revision mode: patch spec.md, plan.md and checklist.md
         only where the change lands, ask only what the change opens, do not re-explore the
         project, and keep the ## UI design section. Reply with the result JSON.

     When this revision turned Mockups OFF, append: `The mockups toggle was turned OFF — remove the
     ## UI design section and the verify: visual checklist lines.`
     **A cold agent is spawned fresh instead.** When the step's last log entry or chat line in
     `/api/state` is more than 55 minutes old, the agent's prompt cache has expired, and a
     SendMessage re-writes its whole context — measured: 440–512k tokens per revision of one
     refinement agent, six revisions in one run. Render the brief again and spawn a fresh
     refinement agent with that paragraph in the spawn prompt, plus: `You start fresh: spec.md,
     plan.md and checklist.md in <SESSION>/tasks/T are your earlier work, and the step's transcript
     in /api/state holds the questions answered so far — read them instead of exploring the
     project again.` The same holds when SendMessage cannot reach the agent. Then continue at
     step 2's gate as usual.
   - **Mockups whose screens are on disk** (`generated-mockups/manifest.json` exists) → POST step
     3's point 1, then `SendMessage` the EXISTING mockup agent instead of spawning one:

         Requirements changed. Read <SESSION>/tasks/T/requirements-changes.md, then requirements.md
         and requirements-prev.md, and revise the screens as your brief's Revision mode says.

     Then loop on its JSON from step 3's point 3. A cold mockup agent (the same 55 minutes), or one
     SendMessage cannot reach, is spawned fresh with that paragraph in the prompt.
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
