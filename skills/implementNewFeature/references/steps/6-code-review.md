## Step 6 — Code Review (view-only, before validation)

The review comes right after implementation: the E2E suite of step 5 then runs once, on code the
review already fixed, instead of once before the review and again after its fixes. A task on the
legacy route (`… → 4 → 5 → 6`, started before the final review existed) still runs it after step 5,
as its last step.

1. POST `{"taskId":"T","step":6,"status":"in_progress","activeStep":6,"progress":0}`.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent", with the
   step's own values:
   `--set=STEP=6 "--set=STEP_NAME=Code Review" "--set=REVIEW_SECTION=Code review" --set=REPORT_FILE=review-report.md`
   `"--set=DEFAULT_RUNS=run 1 with no flags, run 2 with --since-last"`
   `"--set=WALKER_FLAGS=<walker flags of reviewWalker>"` and
   `--set=FIXER_MODEL=<model of reviewFixer> "--set=FIXER_EFFORT=<the directive of its effort>"`
   ("Model and effort"). On the legacy route the step keeps its old place after validation and
   its old regression run: put in the spawn prompt `This task is on the legacy route: you are its
   last review, after validation — run step 9's regression guard, but run the E2E suite directly
   instead of ending your turn with {"type":"e2e"}.` (validation has released the slot, and a
   legacy task never queues for it again).
   The agent reviews exclusively via the `doh:codeReview` skill, pointed at this task's `ROOT`. It
   makes the runs the form set, one to three, read from `requirements.md`'s `## Code review` with
   exactly the flags listed there, re-reading that section before every run so a revision made
   during the review reaches only the runs not yet started, and stops early when a run finds
   nothing, or when a `--since-last` run would only re-check a run that fixed nothing; it fixes
   every finding except the ones that would break functionality, contradict the requirements or
   leave the mockups.
3. `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` → POST
   `{"taskId":"T","step":6,"status":"completed","progress":100,"activeStep":<the next step: 5>}` and
   start it — on the legacy route this was the last step: delete `<SESSION>/tasks/T/auth.json` and
   go to the final summary. Keep the summary for the final one. `error` → failure protocol.
4. Stop what the step left running: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
