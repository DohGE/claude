## Step 9 — Final Code Review (view-only, after validation)

Runs ONLY when `FINAL(T)` and T's route holds step 9. Otherwise skip it like step 3: the step
before it ends the pipeline, and the final summary follows.

Validation fixed application code on its way to green — bugs the suite found, UI against the
baseline, test hooks — and nothing reviewed those lines. This step reviews what changed since step
6 with the runs the form set under `## Final code review` (by default one `--since-last` run) and
fixes what it finds. Then the task's regression runs — the one full unit-suite run, the E2E suite
on a dev server of its own, the project's pre-commit gate — so "Create pull request" commits at
the first try.

The regression is a script YOU run in the background (`regression.cjs`), not the review agent's
work. An agent waiting for a suite re-reads its whole conversation on every slice of the wait:
on a two-file diff that was 0.9M input-equivalent tokens and 19 of the step's 36 minutes, for a
run that was green. A script costs nothing while it runs; an agent is spawned only for a red line.

1. POST `{"taskId":"T","step":9,"status":"in_progress","activeStep":9,"progress":0}`.
   A split task (`task-info.cjs` → `split` not null): run `split.commands.stageAll` first →
   `STAGED_ALL <files>`, so the review sees the whole feature as one staged change
   (`FIXUPS_KEPT <reason>` → failure protocol). Without it `doh:codeReview staged` sees only what
   sits over the last part.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent"
   (`task-info.cjs --step=9 --render` fills `STEP=9`, `STEP_NAME`, `REVIEW_SECTION`,
   `REPORT_FILE=final-review-report.md`, `DEFAULT_RUNS=one run with --since-last`, the walker flags
   of finalWalker and the model and effort of finalFixer). It makes the runs, fixes the findings,
   proves the specs its fixes touch and ends with the work staged — it runs no suite.
3. `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` (also in
   `<SESSION>/tasks/T/results/step-9.json`) → a split task runs `split.commands.fixups` now
   (`FIXUPS_APPLIED {…}`, `NOTHING_STAGED`, or `FIXUPS_KEPT <reason>` — keep that line for the
   step's report). Then start the regression, Bash `run_in_background: true`:

       node "<SKILL_DIR>/scripts/regression.cjs" --root="<ROOT>" --task-dir="<SESSION>/tasks/T" --project="<PROJECT>" --base=<BASE>

   POST `{"taskId":"T","step":9,"progress":80,"currentOperation":"Final regression: unit suite, E2E suite, pre-commit gate"}`
   and end your turn with the waiter armed. Its exit wakes you; read its lines (FIXED IDENTIFIERS):
   - `REGRESSION_GREEN` (exit 0) → point 4. A part it could not run is said, not hidden —
     `UNIT_SKIPPED <reason>`, `E2E_SKIPPED <reason>`, `PRECOMMIT_SKIPPED <reason>`: POST each as a
     `logEntry`; the summary reads them from `results/regression.json`.
   - `REGRESSION_RED` (exit 1) → the red lines (`UNIT_FAILED <errorsPath>`, `E2E_FAILED <errorsPath>`,
     `MOCKS_LEFT <files>`, `PRECOMMIT_FAILED <errorsPath>`) go to a fix agent: render
     `task-info.cjs --step=9 --render --phase=regression-fix`, spawn it
     (`subagent_type: "doh:pipeline-worker"` when your Agent tool lists it, else `general-purpose`)
     with those lines verbatim under `## The red lines`. Its `result` → a split task runs
     `split.commands.fixups` again → run the regression again, whole. At most TWO fix rounds: a
     third red regression, or the fix agent's `error`, → failure protocol, the report quoting the
     red lines and naming the paths.
   - `REGRESSION_BLOCKED` (exit 3) → the machine, not the code. `E2E_BLOCKED unreachable <url> …`
     → the backend is the user's to start: POST
     `{"taskId":"T","question":{"id":"backend1","text":"<the line, in the user's language, and what usually brings that backend up>","options":["<the backend answers now — run it again>"]}}`,
     wait for the `answer`, run the regression again. Any other `E2E_BLOCKED` (the dev server did
     not come up, `mocks.patch` does not apply any more, no free port) → failure protocol with
     that line.
4. A split task proves every part on its own before the step may complete — every part is a pull
   request of its own, and the fix-ups of steps 6, 5 and 9 were folded into parts nobody built
   alone since. Bash `run_in_background: true`: `split.commands.verifyParts`. POST
   `{"taskId":"T","step":9,"currentOperation":"Each part on its own: lint, typecheck, unit tests, build"}`.
   - `PARTS_GREEN` → point 5.
   - `PARTS_RED <n,…>` → the `PART <n> RED <step>=<errorsPath>` lines go to the same
     regression-fix agent as a red regression (its brief knows what a red part means); then
     `split.commands.fixups` and `split.commands.verifyParts` again. Counted with the fix rounds
     of point 3: two in all, then the failure protocol.
   - `PARTS_BLOCKED <reason>` → failure protocol with that line.
5. Delete `<SESSION>/tasks/T/auth.json` if it exists (the regression run was its last consumer, so
   the credentials die with the step, not with the pipeline), then POST
   `{"taskId":"T","step":9,"status":"completed","progress":100}`, run
   `node "<SKILL_DIR>/scripts/checkpoint.cjs" --root=<ROOT> --task=T --step=9`, and go to the
   final summary.
   - The review agent's `{"type":"error","report"}` → failure protocol for step 9
     (`post-result.cjs fail --port=PORT --task=T --step=9`).
6. When the step ends — completed, failed or skipped — stop what it left running:
   `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   A split task that leaves the step failed or skipped still runs `split.commands.fixups`: after
   `stageAll` HEAD is detached at the commit the parts start from, and only that call puts it back
   on the last part.
