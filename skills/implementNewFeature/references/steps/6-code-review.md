## Step 6 — Code Review (view-only, before validation)

The review comes right after implementation: the E2E suite of step 5 then runs once, on code the
review already fixed, instead of once before the review and again after its fixes. A task on the
legacy route (`… → 4 → 5 → 6`, started before the final review existed) still runs it after step 5,
as its last step.

1. POST `{"taskId":"T","step":6,"status":"in_progress","activeStep":6,"progress":0}`.
   A split task (`task-info.cjs` → `split` not null): run `split.commands.stageAll` first →
   `STAGED_ALL <files>`, so the review sees the whole feature, every part, as one staged change
   (`FIXUPS_KEPT <reason>` → failure protocol). Every part is committed by now, so without it
   `doh:codeReview staged` would review nothing.
2. Spawn the review agent from `references/review-agent.md`, per "Spawning a sub-agent"
   (`task-info.cjs --step=6 --render` fills the step's own values: `STEP=6`,
   `STEP_NAME=Code Review`, `REVIEW_SECTION=Code review`, `REPORT_FILE=review-report.md`,
   `DEFAULT_RUNS=one run with no flags`, the walker flags of reviewWalker and the model and effort
   of reviewFixer — "Model and effort").
   The agent reviews exclusively via the `doh:codeReview` skill, pointed at this task's `ROOT`. It
   makes the runs the form set, one to three (one by default: the final review's `--since-last`
   run re-checks whatever this one fixed), read from `requirements.md`'s `## Code review` with
   exactly the flags listed there, re-reading that section before every run so a revision made
   during the review reaches only the runs not yet started, and stops early when a run finds
   nothing, or when a `--since-last` run would only re-check a run that fixed nothing; it fixes
   every finding except the ones that would break functionality, contradict the requirements or
   leave the mockups. It ends with the project's own pre-commit gate green (`checks.cjs
   --only=precommit`), so a lint rule the review's checklists do not know is fixed here and not
   discovered by the commit.
3. `{"type":"result","findingsFixed":N,"findingsRejected":N,"reviewSummary"}` (the agent wrote the
   same object to `<SESSION>/tasks/T/results/step-6.json`, which the final summary is built from:
   keep none of it) → a split task runs `split.commands.fixups` now (`FIXUPS_APPLIED {…}`,
   `NOTHING_STAGED`, or `FIXUPS_KEPT <reason>` — say that line in the step's report). Then POST
   `{"taskId":"T","step":6,"status":"completed","progress":100,"activeStep":<the next step: 5>}`, run
   `node "<SKILL_DIR>/scripts/checkpoint.cjs" --root=<ROOT> --task=T --step=6`, and start the next
   step. On the legacy route this was the task's last step: before completing it, run the
   regression exactly as step 9 does after its review (`references/steps/9-final-code-review.md`,
   points 3 to 5, with step 6 in every body), then delete `<SESSION>/tasks/T/auth.json` and go to
   the final summary. `error` → failure protocol
   (`post-result.cjs fail --port=PORT --task=T --step=6`).
4. When the step ends — completed, failed or skipped — stop what it left running:
   `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   A split task that leaves the step failed or skipped still runs `split.commands.fixups`: after
   `stageAll` HEAD is detached at the commit the parts start from, and only that call puts it back
   on the last part.
