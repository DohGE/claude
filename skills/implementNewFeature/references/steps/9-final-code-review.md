## Step 9 — Final Code Review (view-only, after validation)

Runs ONLY when `FINAL(T)` and T's route holds step 9. Otherwise skip it like step 3: the step
before it ends the pipeline, and the final summary follows.

Validation fixed application code on its way to green — bugs the suite found, UI against the
baseline, test hooks — and nothing reviewed those lines. This step reviews what changed since step
6 with the runs the form set under `## Final code review` (by default one `--since-last` run),
fixes what it finds, proves the fixes with the task's one full unit-suite run and the E2E suite,
and ends with the project's own pre-commit gate green, so "Create pull request" commits at the
first try. Like validation, it runs its E2E suite on a dev server of its own: no task waits for
another.

1. POST `{"taskId":"T","step":9,"status":"in_progress","activeStep":9,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent"
   (`task-info.cjs --step=9 --render` fills `STEP=9`, `STEP_NAME`, `REVIEW_SECTION`,
   `REPORT_FILE=final-review-report.md`, `DEFAULT_RUNS=one run with --since-last`, the walker flags
   of finalWalker and the model and effort of finalFixer).
3. Route its JSON:
   - `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` → delete
     `<SESSION>/tasks/T/auth.json` if it exists (the regression run was its last consumer, so the
     credentials die with the step, not with the pipeline), then POST
     `{"taskId":"T","step":9,"status":"completed","progress":100}`, run
     `node "<SKILL_DIR>/scripts/checkpoint.cjs" --root=<ROOT> --task=T --step=9`, and go to the
     final summary.
   - `{"type":"error","report"}` → failure protocol for step 9.
4. Stop what the step left running: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
