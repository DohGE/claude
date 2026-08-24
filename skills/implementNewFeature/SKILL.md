---
name: implementNewFeature
description: Use when the user wants a complete feature implemented end-to-end - runs a 5-step pipeline (Requirements, Feature Refinement, Implementation, Validation & E2E, Code Review) plus an optional Mockups step and an on-demand Mockoon mocks step, with a browser stepper UI; the orchestrator coordinates sub-agents and keeps the main context clean
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
2. Pick the session root by whether the project already has a `.claude/` folder:
   - `PROJECT/.claude/` exists → `SESSION = <PROJECT>/.claude/doh/<yyyyMMdd-HHmmss>`, and ensure
     `<PROJECT>/.claude/doh/.gitignore` exists holding `*`, `!.gitignore`, `!instructions/` and
     `!instructions/**`, so the run's artifacts (reports, plan, screenshots, `auth.json`,
     `pipeline-state.json`) stay out of git and the final `git add -A` never stages them, while the
     project's own `doh/instructions/` rulebook stays committable.
   - otherwise → `SESSION = <SKILL_DIR>/.implementNewFeature/<yyyyMMdd-HHmmss>` (the skill's own
     `.gitignore` already covers it).
   Create `SESSION`. Either way `node_modules` and the Playwright config stay inside `SKILL_DIR`:
   the `doh` plugin's own Playwright is the only runner the pipeline ever uses — never the
   project's copy, never a fresh install in the target project.
3. Start the server (pick the script for the OS) and capture the port:
   - Windows: `powershell -NoProfile -File "<SKILL_DIR>/scripts/start-server.ps1" -SessionDir "<SESSION>" -Open`
   - POSIX: `bash "<SKILL_DIR>/scripts/start-server.sh" --session-dir "<SESSION>" --open`
   - stdout is `{"port":N}`; remember `PORT`. Tell the user the stepper is open at `http://127.0.0.1:PORT/`.

## Server helpers (use exactly these shapes)

- Update state:
  `curl -s -X POST http://127.0.0.1:PORT/api/state -H "content-type: application/json" -d "<json>"`
  Fields: `{"step":N,"status":"waiting|in_progress|completed|failed","enabled":true|false,"progress":0-100,"currentOperation":"...","report":"...","logEntry":"...","activeStep":N,"question":{...}|null,"reviewSummary":{...}|null,"mockupReview":{...}|null,"summary":{...}}`
  Step ids are fixed (1 Requirements, 2 Feature Refinement, 3 Mockups, 4 Implementation,
  5 Validation & E2E, 6 Code Review, 7 Mockoon Mocks). Step 3 ships `enabled:false` and the stepper
  hides it, so a run without mockups shows five tiles numbered 1-5 plus the Mockoon one. Step 7 is
  always visible and stays `waiting` through the whole run — it only moves when the user asks for
  mocks on the summary screen.
  Merge consecutive updates into ONE POST whenever nothing (user interaction, agent work) happens
  between them — e.g. completing a step and activating the next is a single body, never two calls.
- Wait for a user answer (long-poll, repeat until non-null):
  `curl -s "http://127.0.0.1:PORT/api/answer?wait=290"` → `{"answer":{...}|null}`
  ALWAYS pass `timeout: 320000` to the Bash tool for this call — the default 120 s tool timeout
  would kill the poll mid-wait. The poll returns instantly once the user answers; the long wait
  only spares empty polls. Repeat the call in a loop while `answer` is null. If curl cannot
  connect, the server died: re-run the launcher (state reloads from `pipeline-state.json`) and continue.
- **Encoding (MANDATORY, also for every sub-agent):** bodies contain non-ASCII text (e.g. Polish).
  Always run curl from a POSIX shell (Bash tool) where inline UTF-8 JSON is safe.
  Never pass non-ASCII JSON inline through PowerShell — it re-encodes to the system codepage and
  the UI shows `�`. If PowerShell is unavoidable, write the JSON to a temp file as UTF-8
  **without BOM** and send it with `--data-binary "@file"`.

## Step 1 — Requirements (interactive)

1. POST `{"step":1,"status":"in_progress","activeStep":1}`.
2. Poll answers until `kind=="step1"`. When the answer has `authProvided:true`, the browser has
   already written login+password for E2E tests to `<SESSION>/auth.json` — NEVER read, quote or
   copy that file; only the validation agent uses it.
3. Write `<SESSION>/requirements.md`:

   ```markdown
   # Requirements

   ## Task description
   <taskDescription>

   ## Business requirements
   <businessRequirements>

   ## Additional materials (hints for refinement and mockups)
   Files: <hints list or "—">
   Note: <hintsNote or "—">

   ## Contracts (pasted)
   <contractsText or "—">

   ## Uploaded files
   Mockups: <mockups list or "—">  |  Contracts: <contracts list or "—">

   ## Authorization
   <"Provided — credentials in auth.json (session dir); never copy them into spec/plan/tests" if authProvided, else "—">

   ## Mockup generation
   <"Enabled — step 3 designs the screens" if generateMockups, else "Disabled">
   ```

   (Uploads already sit in `<SESSION>/mockups/`, `<SESSION>/contracts/` and `<SESSION>/hints/`.)
4. Remember `MOCKUPS = answer.generateMockups` — it decides whether step 3 runs after step 2.
   When `MOCKUPS`, POST `{"step":3,"enabled":true}` first (`enabled` binds to the body's `step`,
   so it cannot ride along with the step-1 update).
5. POST `{"step":1,"status":"completed","activeStep":2}`.

## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"step":2,"status":"in_progress","activeStep":2,"progress":5,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent: prompt = contents of `<SKILL_DIR>/references/refinement-agent.md` with placeholders `{{SESSION}}`, `{{PORT}}`, `{{PROJECT}}`, `{{SKILL_DIR}}`, `{{LANGUAGE}}` substituted.
3. Loop on the agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"question":{...}}`, poll answers until `kind=="answer"`, then **immediately** (before contacting the agent) POST `{"question":null,"step":2,"progress":<min(60, 20+5×answers so far)>,"currentOperation":"Processing answer…","logEntry":"<id>: <answer, shortened>"}` so the UI reacts to the click at once, then SendMessage the answer text to the agent. You own the Q&A progress — the agent does not report between questions.
   - `{"type":"result","summary"}` → spec/plan/checklist now exist in `<SESSION>`. Go to 4.
   - `{"type":"error","report"}` → failure protocol (below) for step 2.
4. Gate: POST `{"reviewSummary":{"text":"<summary>"}}`; poll answers until `kind=="decision"`:
   - `approve` → POST `{"reviewSummary":null,"step":2,"status":"completed","activeStep":<3 if MOCKUPS else 4>}`; continue.
   - `feedback` → SendMessage the feedback to the agent; back to 3.

## Step 3 — Mockups (interactive, conditional)

Runs ONLY when `MOCKUPS`. Otherwise skip the whole step: it stays `enabled:false` / `waiting`, the
stepper never shows it, and step 2's gate already moved `activeStep` straight to 4.

1. POST `{"step":3,"status":"in_progress","activeStep":3,"progress":5,"currentOperation":"Designing screens"}`.
2. Spawn the mockup agent: prompt = contents of `<SKILL_DIR>/references/mockup-agent.md` with the
   usual placeholders substituted.
3. Keep `REV = 0` and a `CHAT` array of `{"role":"agent"|"user","text":"…"}`. Loop on the agent's final JSON:
   - `{"type":"mockup","summary","screens":[{"id","title","file"}]}` → append `{"role":"agent","text":summary}`
     to `CHAT`, `REV++`, and POST
     `{"step":3,"progress":<min(90, 20+10×REV)>,"currentOperation":"Waiting for your review","mockupReview":{"rev":REV,"text":"<summary>","screens":[…],"chat":CHAT}}`.
     Then poll answers until `kind=="mockup"`:
     - `decision=="feedback"` → append `{"role":"user","text":<text>}` to `CHAT`, then **immediately**
       (before contacting the agent) POST `{"step":3,"currentOperation":"Reworking the mockup…","logEntry":"Feedback: <shortened>"}`
       so the UI reacts to the click at once, then SendMessage the feedback text to the agent. Back to 3.
     - `decision=="approve"` → SendMessage exactly: `APPROVED — update spec.md, plan.md and
       checklist.md to match the approved mockups, then reply with the result JSON.` Back to 3.
   - `{"type":"result","summary","screens":[…]}` (only ever arrives after the approval message) →
     POST `{"step":3,"status":"completed","progress":100,"mockupReview":null,"activeStep":4}`.
     Keep the screen count and the summary only — never the mockup markup.
   - `{"type":"error","report"}` → failure protocol for step 3.

`rev` must increase on every agent round: the UI keys its re-render on it, so a repeated value
leaves the panel locked on the previous answer.

## Step 4 — Implementation (view-only)

1. Derive `SLUG` from the feature title (first line of `<SESSION>/spec.md`): lowercase, ASCII, spaces→`-`, strip other chars, max 40 chars. `git checkout -b feature/<SLUG>`; if the branch already exists (e.g. a retry of this step), `git checkout feature/<SLUG>` instead.
2. POST `{"step":4,"status":"in_progress","activeStep":4,"progress":0}`.
3. Spawn the implementation agent from `references/implementation-agent.md` (same placeholder substitution). It reports progress itself via POST /api/state and writes code against the `doh:codeReview` instruction checklists (its "Coding rulebook" section).
4. Final JSON `{"type":"result","filesChanged":[...],"summary"}` → POST `{"step":4,"status":"completed","progress":100}`. Keep `filesChanged` count and summary only. `error` → failure protocol.

## Step 5 — Validation & E2E (view-only, except the Chrome-extension prompt)

1. POST `{"step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`. It runs the project's own unit
   suite, then writes and runs the E2E suite on the plugin's own Playwright, and uses the user's
   Chrome (Claude in Chrome extension) for discovery, failure debugging and a UX pass — expect a
   tab to open there during this step. Endpoints the backend does not serve yet are faked in the
   app's code for the length of the step and removed before it ends (archived to `<SESSION>/mocks/`),
   so step 6 and the commit never see them.
3. Loop on the agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the extension is unavailable, and it is
     REQUIRED: the agent is blocked until the user installs/enables it. POST `{"question":{...}}`,
     poll answers until `kind=="answer"`, then **immediately** (before contacting the agent) POST
     `{"question":null,"step":5,"currentOperation":"Retrying the Chrome extension…","logEntry":"<id>: <answer, shortened>"}`
     so the UI reacts to the click at once, then SendMessage the answer text to the agent. Never
     tell it to continue without the extension, and never re-spawn it with that requirement waived.
   - `{"type":"result","compliance":NN,"testsSummary","unitSummary","mockupSummary","uxSummary","apiMockSummary"}`
     with `compliance>=99` → POST completed. Keep `apiMockSummary` for the final summary — it says
     which endpoints were faked, so the user knows what was never proven against a real API.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit suite that stayed red, or an
     extension that never became available) → failure protocol.

## Step 6 — Code Review (view-only)

1. POST `{"step":6,"status":"in_progress","activeStep":6,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md` (it reviews exclusively via the `doh:codeReview` skill — no other review method).
3. `{"type":"result","findingsFixed":N,"reviewSummary"}` → delete `<SESSION>/auth.json` if it exists
   (step 6's regression run is its last consumer, so the credentials die with the step, not with the
   pipeline), then POST completed. `error` → failure protocol.

## Step 7 — Mockoon mocks (on demand, view-only)

Never part of the pipeline run: the tile waits until the user clicks "Generate Mockoon mocks" on the
summary screen, which reaches you through the wait loop below. It can run any number of times
("Regenerate" is the same step over the same file).

1. POST `{"step":7,"status":"in_progress","activeStep":7,"progress":0}` — this also pulls the browser
   off the summary and onto the step's panel.
2. Spawn the mockoon agent from `references/mockoon-agent.md` (same placeholder substitution). It
   reads spec/plan, the contracts and the implemented code, and writes `<SESSION>/mockoon.json`
   (one environment on `localhost:3000`). The browser fetches that file itself from `/api/mockoon` —
   NEVER read it, never paste it into a message or into `/api/state`.
3. `{"type":"result","routes":N,"summary"}` → POST `{"step":7,"status":"completed","progress":100}`;
   the panel then shows the JSON with a Copy button. Keep the route count and the summary only.
4. `{"type":"error","report"}` → POST `{"step":7,"status":"failed","report":"<report>"}`, then poll
   answers until `kind=="decision"`: `retry` → POST `{"step":7,"status":"in_progress","report":null}`
   and re-spawn the agent **fresh**; `finish` → the user went back to the summary, so leave the step
   failed and return to the wait loop.

## Failure protocol (any step)

1. POST `{"step":N,"status":"failed","report":"<report>","question":null}` — clearing the question
   matters: a step that failed while waiting for an answer would otherwise re-show that stale
   question the moment a retry flips the status back to in_progress.
2. Poll answers until `kind=="decision"`:
   - `retry` → POST `{"step":N,"status":"in_progress","report":null}`; re-spawn that step's agent **fresh** (new Agent call, same prompt + note about the previous failure report path).
   - `finish` → write the final summary (below, including the `auth.json` cleanup) with
     `finalStatus:"Failed at step N"`, then stop.

## Final summary

1. Delete `<SESSION>/auth.json` if it still exists — step 6 normally already did, so this is the
   backstop for runs that never got there (the server also wipes it on shutdown). Do this on BOTH
   outcomes — success and `finish` after a failure.
2. Collect from step results only (no file contents): changes, features, tests (E2E suite + the project's unit suite), API mocks, mockup comparison, UX findings, review results.
3. POST `{"summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","apiMocks":"...","mockupComparison":"...","uxReview":"...","codeReview":"..."}}` (`tests` = the validation agent's `testsSummary` and `unitSummary`; `apiMocks` = its `apiMockSummary`; `uxReview` = its `uxSummary`).
4. Print the same summary in the terminal (user's language).
5. Stage everything: `git add -A` (already done by the step-6 agent; verify with `git status --short`).
6. Suggest `superpowers:finishing-a-development-branch` for commit/merge/PR.
7. Leave the server running and enter the wait loop below. Do NOT kill the PID yourself.

## After the summary (wait loop)

The pipeline is done, but the summary screen still offers "Generate Mockoon mocks", so the run ends
only when the user says so. Loop:

1. Poll `curl -s "http://127.0.0.1:PORT/api/answer?wait=290"` (Bash tool `timeout: 320000`), repeating
   while `answer` is null.
2. `{"kind":"summary","decision":"mockoon"}` → run step 7 above, then keep looping.
3. `{"kind":"summary","decision":"shutdown"}` → the user pressed "Shut down server": stop looping and
   end your turn.
4. curl cannot connect → the server is already gone: stop looping and end your turn.
