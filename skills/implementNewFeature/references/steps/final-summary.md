## Final summary (per task)

1. `auth.json`: on success it is already gone (the last step that logs in deleted it); delete
   `<SESSION>/tasks/T/auth.json` if it still exists. After a `finish` it STAYS: the work of a failed
   task can still get its pull request, and a review or retry asked for afterwards may still have
   to log in. The server deletes every task's copy when it shuts down.
2. A split task whose last step did not prove its parts (it was skipped, or the task was finished
   early): run `split.commands.fixups` (`task-info.cjs`), so nothing stays staged outside its
   part. The parts themselves are proven before the pull requests (below), not here.
3. Build and post the summary with ONE call — never compose it yourself:

       node "<SKILL_DIR>/scripts/post-result.cjs" summary --port=PORT --task=T

   It reads what every step left in `<SESSION>/tasks/T/results/` — the implementation's summary,
   features and deviations (`step-4.json`, or one `step-4-part-<n>.json` per part), validation's
   `testsSummary` / `unitSummary` / `mockupSummary` / `uxSummary` / `apiMockSummary`
   (`step-5.json`), both reviews' `reviewSummary` (`step-6.json`, `step-9.json`), the regression's
   lines and the parts' gate — and the task's own record: its branch and working directory at the
   top of `changes`, the deviations at the end of it, marked, so a reader sees at once that the
   run departed from the plan. A step that left no result says why in its section (switched off,
   skipped after it failed, did not run): no section reads as if the work was done. It works out
   `finalStatus` itself, from the steps: `Completed` on success — a FIXED IDENTIFIER —
   `Completed with skipped steps: <step names>` when the user went on without a failed step, and
   `Failed at <step name>` after a `finish`. The NAME, never the id. It prints `SUMMARY_POSTED`,
   then `finalStatus: …`, `branch: …`, `root: …` (`POST_FAILED <reason>` → say so and post it again
   once the reason is gone).
   A step that runs after the summary (a review the user asked for later) ends by posting the
   summary again the same way, with its result folded in: the screen must never say a step did
   not run when it did.
4. Stage that task's changes: `git -C "<ROOT>" add -A` (already done by the review agents; verify
   with `git -C "<ROOT>" status --short`). Worktrees have their own index, so tasks never stage into each other.
5. Tell the user, in the terminal, in their language and in THREE lines at most: the final status,
   the branch and working directory, and that the details are on the summary screen. The screen
   holds every section; repeating them here only spends tokens on text the user already has.
6. Add how the work leaves the run, once: the summary screen's **Create pull request** button —
   there for a failed task too — commits T's staged changes with the step-1 commit message, pushes
   the branch and opens a pull request into the branch it was started from, while the server keeps
   running for the other tasks; the link appears on the summary. **Shut down server** sits in the
   sidebar and stops every task's run, so they press it once every task is done. By hand instead:
   `superpowers:finishing-a-development-branch` for T's branch, and `git worktree remove <ROOT>`
   AFTERWARDS, in that order: the pipeline ends with the work staged and uncommitted, and
   `git worktree remove` refuses a worktree in that state (`fatal: ... contains modified or
   untracked files`). Say plainly that `--force` is NOT the way around it — it would delete the
   feature the run just built.
7. Leave the server running — other tasks may still be on it. Do NOT kill the PID yourself. After
   the summary, keep T's waiter listening, with `--minutes 240`, and serve what it brings — a
   "Create pull request" or a "Generate Mockoon mocks" press arrives this way — but when it ends in
   `WAIT_TIMEOUT`, end your turn WITHOUT starting another. Tell the user, in the summary, that a
   button pressed after that waits in the server until they type anything in this terminal, or
   until "Open session" in the stepper's sidebar opens a new one for T; then drain the queue with
   `node "<SKILL_DIR>/scripts/wait-answer.cjs" --port PORT --task T --minutes 0` in the foreground,
   act on each `ANSWER`, and go back to the event loop. The run ends when the user presses "Shut
   down server", or the server dies. Point them at the button rather than letting them close the
   terminal: pressing it is also what wipes every task's `auth.json`, so a run killed any other way
   leaves the credentials they typed sitting in the session directory (git-ignored, but still on
   disk) until they delete them by hand. The browser keeps its own copy when "Remember on this
   browser" was left ticked on the step-1 form — that one is the user's to clear, by unticking it,
   and no shutdown touches it. Say so if they ask where their password lives.
8. On `{"kind":"summary","decision":"shutdown"}` (or `SERVER_GONE`) with T's pull request open
   (`pr.status` `created` or `exists`, as you last posted it): remove T's worktree —
   `node "<SKILL_DIR>/scripts/remove-worktree.cjs" --project="<PROJECT>" --root="<ROOT>"` →
   `WORKTREE_REMOVED <root>`, or `WORKTREE_KEPT <reason>` (uncommitted work, or git refused — say
   so; never `--force`). It unlinks every link inside the worktree first, so a `node_modules`
   linked in from the main checkout keeps its files. The branch and its commits stay. Without an
   open pull request the worktree stays: it holds the only copy of the work.

## Create pull request

`{"kind":"summary","decision":"create_pr","taskId":"T"}` — the user pressed "Create pull request"
on T's summary. The server wrote `<SESSION>/tasks/T/pr-request.json` — `branch`, `base`, `root`,
`commitMessage`, `finalStatus`, `taskSplit`, `splitBranch` — and shows "Creating the pull request"
until you POST the outcome. It stays up; nothing here stops it. Never run `git commit`, `git push`
or a hook yourself in this flow, and never run a refused step a second time to "see the error":
the scripts save every output, and a second commit is what once dropped a task's staged work.

1. Read `pr-request.json` (it is T's own record, not the user's secret). `ROOT` = its `root`;
   `BASE` = its `base`, else the main branch step 4 would pick; the message = its `commitMessage`,
   else `<branch>`.
2. Write the pull request's description in ENGLISH, at most five sentences, to
   `<SESSION>/tasks/T/pr-body.md`: what the feature does and the main changes, taken from the
   summary on screen (`GET /api/state` → T's `summary.features` and `summary.changes`, read with a
   one-line filter — never the whole state, never the diff). When `finalStatus` starts with
   `Failed`, the first sentence says where the pipeline stopped and what is therefore unproven;
   when it names skipped steps, the first sentence names them and what nobody proved because of
   it. No attribution of any kind: no "Generated with Claude Code", no `Co-Authored-By`, no robot
   emoji (`create-pr.cjs` strips them anyway).
3. An unsplit task — one call does the rest, each part only after the one before it succeeded:

       node "<SKILL_DIR>/scripts/finish-pr.cjs" --root="<ROOT>" --task-dir="<SESSION>/tasks/T" --branch=<branch> --base=<BASE> "--message=<the message>" --body-file="<SESSION>/tasks/T/pr-body.md"

   It stages, runs the project's pre-commit gate without lint-staged's backup stash, snapshots
   the tree (`refs/doh/T/before-commit`), commits — never `--no-verify` — proves the commit landed,
   pushes and opens the pull request. Its lines (FIXED IDENTIFIERS):
   - `COMMITTED <sha>` (or `NOTHING_TO_COMMIT`), `PUSHED <branch>`, then `PR_CREATED <url>` or
     `PR_EXISTS <url>` → POST `{"taskId":"T","pr":{"status":"created"|"exists","url":"<url>","commit":"<sha>"}}`.
   - `PRECOMMIT_FAILED <errorsPath>` → the project's own hook is red on the staged work and nothing
     was committed. Read the first lines of `errorsPath`, POST
     `{"taskId":"T","pr":{"status":"failed","reason":"pre-commit: <the first decisive line>"}}`, and
     tell the user: a fix here is new code no review has seen, so it is their call — they write it
     in the summary's terms ("fix the lint and try again") and you hand it to a regression-fix
     agent of step 9 (`task-info.cjs --step=9 --render --phase=regression-fix`, the red line in its
     prompt), or they fix it themselves and press "Try again".
   - `COMMIT_REFUSED <log>` then `CHANGES_KEPT`, `CHANGES_RESTORED` or `CHANGES_LOST <snapshot>` →
     POST `pr` `failed` with the log's decisive line; with `CHANGES_LOST`, tell the user plainly
     that `git -C "<ROOT>" stash apply --index <snapshot>` brings the staged work back.
   - `PUSH_FAILED <branch> <reason>` (no credentials, a protected branch) → POST `pr` `failed`; the
     commit stands, and "Try again" pushes it (`NOTHING_TO_COMMIT` then `PUSHED`).
   - `PR_FAILED <reason>` → POST `pr` `failed`; the commit and the push stand.
4. A split task (`taskSplit` not empty; `N` = `task-info.cjs` → `split.parts`, `<branch>` =
   `splitBranch`) opens one pull request per part — part 1 into `BASE`, part `n` into
   `<branch>-part-<n-1>`, so each one shows only its own part's diff — and EVERY part must pass
   the project's lint, typecheck, unit tests and build on its own first: each is a pull request
   CI runs by itself. Write one description per part (what THAT part does) to
   `<SESSION>/tasks/T/pr-body-<n>.md`; a part without one gets `pr-body.md`. Then ONE call, Bash
   `run_in_background: true` (a part not verified since it last moved is built now, and a build
   takes minutes):

       node "<SKILL_DIR>/scripts/finish-split-pr.cjs" --root="<ROOT>" --project="<PROJECT>" --task-dir="<SESSION>/tasks/T" --branch=<branch> --base=<BASE> --parts=<N> "--message=<the message>"

   It folds what is still staged into its part (`split-fixups.cjs`'s line; after `FIXUPS_KEPT` the
   rest is amended into the last part through the pre-commit gate), verifies every part
   (`verify-parts.cjs`: `PART <n> GREEN | RED <step>=<errorsPath> | BLOCKED <reason>`, then
   `PARTS_GREEN | PARTS_RED <n,…> | PARTS_BLOCKED <reason>`), pushes every part branch with a lease
   (`PUSHED <branch>`) and opens the pull requests in order (`PR_CREATED` / `PR_EXISTS <url>` per
   part), stopping at the first failure:
   - every part has its pull request → POST `pr` `created` with every URL in `urls`.
   - `PARTS_RED <n,…>` → nothing was pushed. POST
     `{"taskId":"T","pr":{"status":"failed","reason":"part <n> does not pass <step> on its own: <the first decisive line of its errorsPath>"}}`
     and tell the user which part and which step: their call, as for a red pre-commit — a
     regression-fix agent (the `PART <n> RED …` line in its prompt; then press "Try again"), or
     their own fix.
   - `PARTS_BLOCKED`, `PRECOMMIT_FAILED`, `COMMIT_REFUSED`, `PUSH_FAILED`, `PR_FAILED` → POST `pr`
     `failed` with that line, as in point 3; pull requests already opened stay, and "Try again"
     finds them (`PR_EXISTS`).
5. Delete `pr-request.json`, and print in the terminal: the commit, the pull request URL(s) or
   the failure. The worktree stays while the server runs (point 8).

After `SERVER_GONE` the same flow runs from the file, printing the outcome instead of posting it.
