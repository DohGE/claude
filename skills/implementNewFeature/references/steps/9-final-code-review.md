## Step 9 — Final Code Review (view-only, after validation)

Runs ONLY when `FINAL(T)` and T's route holds step 9. Otherwise skip it like step 3: the step
before it ends the pipeline, and the final summary follows.

Validation fixed application code on its way to green — bugs the suite found, UI against the
baseline, test hooks — and nothing reviewed those lines. This step reviews what changed since step
6 with the runs the form set under `## Final code review` (by default one `--since-last` run),
fixes what it finds, and proves the fixes with the unit suite and, in the E2E slot, the E2E suite.

1. POST `{"taskId":"T","step":9,"status":"in_progress","activeStep":9,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent", with:
   `--set=STEP=9 "--set=STEP_NAME=Final Code Review" "--set=REVIEW_SECTION=Final code review" --set=REPORT_FILE=final-review-report.md`
   `"--set=DEFAULT_RUNS=one run with --since-last"`
   `"--set=WALKER_FLAGS=<walker flags of finalWalker>"` and
   `--set=FIXER_MODEL=<model of finalFixer> "--set=FIXER_EFFORT=<the directive of its effort>"`.
3. Route its JSON:
   - `{"type":"e2e"}` → its fixes changed code and the unit suite is green; the E2E suite needs the
     slot. POST `/api/e2e` with `{"taskId":"T","step":9}`: `{"granted":true}` → SendMessage
     `E2E slot granted` (a FIXED IDENTIFIER, English verbatim); `{"granted":false,…}` → the server
     queued T and shows step 9 waiting for the slot: wait for T's `kind=="e2e"`, then send the same
     line. Keep serving T's other answers meanwhile.
   - `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` → delete
     `<SESSION>/tasks/T/auth.json` if it exists (the regression run was its last consumer, so the
     credentials die with the step, not with the pipeline), then POST
     `{"taskId":"T","step":9,"status":"completed","progress":100}` — the server hands the E2E slot
     on — and go to the final summary.
   - `{"type":"error","report"}` → failure protocol for step 9. T keeps the slot across a `retry`.
4. Stop what the step left running: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
