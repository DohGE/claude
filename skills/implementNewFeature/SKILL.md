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
2. Pick the session root by whether the project already has a `.claude/` folder:
   - `PROJECT/.claude/` exists → `SESSION = <PROJECT>/.claude/doh/<yyyyMMdd-HHmmss>`, and ensure
     `<PROJECT>/.claude/doh/.gitignore` exists holding a single `*` line, so the run's artifacts
     (reports, plan, screenshots, `auth.json`, `pipeline-state.json`) stay out of git and the final
     `git add -A` never stages them.
   - otherwise → `SESSION = <SKILL_DIR>/.implementNewFeature/<yyyyMMdd-HHmmss>` (the skill's own
     `.gitignore` already covers it).
   Create `SESSION`. Either way `node_modules` and the Playwright config stay inside `SKILL_DIR`,
   never in the target project.
3. Start the server (pick the script for the OS) and capture the port:
   - Windows: `powershell -NoProfile -File "<SKILL_DIR>/scripts/start-server.ps1" -SessionDir "<SESSION>" -Open`
   - POSIX: `bash "<SKILL_DIR>/scripts/start-server.sh" --session-dir "<SESSION>" --open`
   - stdout is `{"port":N}`; remember `PORT`. Tell the user the stepper is open at `http://127.0.0.1:PORT/`.

## Server helpers (use exactly these shapes)

- Update state:
  `curl -s -X POST http://127.0.0.1:PORT/api/state -H "content-type: application/json" -d "<json>"`
  Fields: `{"step":N,"status":"waiting|in_progress|completed|failed","progress":0-100,"currentOperation":"...","report":"...","logEntry":"...","activeStep":N,"question":{...}|null,"reviewSummary":{...}|null,"summary":{...}}`
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

   ## Contracts (pasted)
   <contractsText or "—">

   ## Uploaded files
   Mockups: <mockups list or "—">  |  Contracts: <contracts list or "—">

   ## Authorization
   <"Provided — credentials in auth.json (session dir); never copy them into spec/plan/tests" if authProvided, else "—">
   ```

   (Uploads already sit in `<SESSION>/mockups/` and `<SESSION>/contracts/`.)
4. POST `{"step":1,"status":"completed","activeStep":2}` (one call).

## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"step":2,"status":"in_progress","activeStep":2,"progress":5,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent: prompt = contents of `<SKILL_DIR>/references/refinement-agent.md` with placeholders `{{SESSION}}`, `{{PORT}}`, `{{PROJECT}}`, `{{SKILL_DIR}}`, `{{LANGUAGE}}` substituted.
3. Loop on the agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"question":{...}}`, poll answers until `kind=="answer"`, then **immediately** (before contacting the agent) POST `{"question":null,"step":2,"progress":<min(60, 20+5×answers so far)>,"currentOperation":"Processing answer…","logEntry":"<id>: <answer, shortened>"}` so the UI reacts to the click at once, then SendMessage the answer text to the agent. You own the Q&A progress — the agent does not report between questions.
   - `{"type":"result","summary"}` → spec/plan/checklist now exist in `<SESSION>`. Go to 4.
   - `{"type":"error","report"}` → failure protocol (below) for step 2.
4. Gate: POST `{"reviewSummary":{"text":"<summary>"}}`; poll answers until `kind=="decision"`:
   - `approve` → POST `{"reviewSummary":null,"step":2,"status":"completed"}`; continue.
   - `feedback` → SendMessage the feedback to the agent; back to 3.

## Step 3 — Implementation (view-only)

1. Derive `SLUG` from the feature title (first line of `<SESSION>/spec.md`): lowercase, ASCII, spaces→`-`, strip other chars, max 40 chars. `git checkout -b feature/<SLUG>`; if the branch already exists (e.g. a retry of this step), `git checkout feature/<SLUG>` instead.
2. POST `{"step":3,"status":"in_progress","activeStep":3,"progress":0}`.
3. Spawn the implementation agent from `references/implementation-agent.md` (same placeholder substitution). It reports progress itself via POST /api/state and writes code against the `doh:codeReview` instruction checklists (its "Coding rulebook" section).
4. Final JSON `{"type":"result","filesChanged":[...],"summary"}` → POST `{"step":3,"status":"completed","progress":100}`. Keep `filesChanged` count and summary only. `error` → failure protocol.

## Step 4 — Validation & E2E (view-only)

1. POST `{"step":4,"status":"in_progress","activeStep":4,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`.
3. `{"type":"result","compliance":NN,"testsSummary","mockupSummary"}` with `compliance>=99` → POST completed. `{"type":"error","report"}` (e.g. <99% after 3 cycles) → failure protocol.

## Step 5 — Code Review (view-only)

1. POST `{"step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md` (it reviews exclusively via the `doh:codeReview` skill — no other review method).
3. `{"type":"result","findingsFixed":N,"reviewSummary"}` → POST completed. `error` → failure protocol.

## Failure protocol (any step)

1. POST `{"step":N,"status":"failed","report":"<report>"}`.
2. Poll answers until `kind=="decision"`:
   - `retry` → POST `{"step":N,"status":"in_progress","report":null}`; re-spawn that step's agent **fresh** (new Agent call, same prompt + note about the previous failure report path).
   - `finish` → write the final summary (below, including the `auth.json` cleanup) with
     `finalStatus:"Failed at step N"`, then stop.

## Final summary

1. Delete `<SESSION>/auth.json` if it exists (credentials must not outlive the pipeline; the
   server also wipes it on shutdown as a backstop). Do this on BOTH outcomes — success and
   `finish` after a failure.
2. Collect from step results only (no file contents): changes, features, tests, mockup comparison, review results.
3. POST `{"summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","mockupComparison":"...","codeReview":"..."}}`.
4. Print the same summary in the terminal (user's language).
5. Stage everything: `git add -A` (already done by step 5 agent; verify with `git status --short`).
6. Suggest `superpowers:finishing-a-development-branch` for commit/merge/PR.
7. Leave the server running — the summary screen shows a "Shut down server" button; the user stops the server by clicking it (POST `/api/shutdown`). Do NOT kill the PID yourself.
