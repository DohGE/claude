## Final summary (per task)

1. `auth.json`: on success it is already gone (the last step that logs in deleted it); delete
   `<SESSION>/tasks/T/auth.json` if it still exists. After a `finish` it STAYS: the work of a failed
   task can still get its pull request, and a review or retry asked for afterwards may still have
   to log in. The server deletes every task's copy when it shuts down.
2. Collect from step results only (no file contents): changes, features, tests (E2E suite + the project's unit suite), API mocks, mockup comparison, UX findings, review results of both reviews, and step 4's deviations when it reported any — they belong at the end of `changes`, prefixed so a reader sees at once that the run departed from the plan.
3. POST `{"taskId":"T","summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","apiMocks":"...","mockupComparison":"...","uxReview":"...","codeReview":"..."}}` (`tests` = the validation agent's `testsSummary` and `unitSummary`; `apiMocks` = its `apiMockSummary`; `mockupComparison` = its `mockupSummary` - every renamed field is listed here, so a missing line reads as "no source" and the section lands empty even when the step did the work; `uxReview` = its `uxSummary`; `codeReview` = the `reviewSummary` of step 6, then that of step 9 when it ran, each naming every finding it rejected and on what ground). `finalStatus` is `Completed` on success — a FIXED IDENTIFIER — and `Failed at <step name>` after a `finish`. Put the task's branch and `ROOT` at the top of `changes` so the user can find the work. A step that runs after the summary (a review the user asked for later) POSTs the summary again with its result folded in: the screen must never say a step did not run when it did.
4. Stage that task's changes: `git -C "<ROOT>" add -A` (already done by the review agents; verify
   with `git -C "<ROOT>" status --short`). Worktrees have their own index, so tasks never stage into each other.
5. Print T's summary in the terminal (user's language): its branch, working directory and final
   status, then the details. Every other task's orchestrator prints its own.
6. Tell the user how the work leaves the run: the summary screen's **Create pull request** button —
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
`finish-pr.cjs` saves every output, and a second commit is what once dropped a task's staged work.

1. Read `pr-request.json` (it is T's own record, not the user's secret). `ROOT` = its `root`;
   `BASE` = its `base`, else the main branch step 4 would pick; the message = its `commitMessage`,
   else `<branch>`.
2. Write the pull request's description in ENGLISH, at most five sentences, to
   `<SESSION>/tasks/T/pr-body.md`: what the feature does and the main changes, taken from the
   step results you kept (the summary's features and changes) — never from reading the diff. When
   `finalStatus` starts with `Failed`, the first sentence says where the pipeline stopped and what
   is therefore unproven. No attribution of any kind: no "Generated with Claude Code", no
   `Co-Authored-By`, no robot emoji (`create-pr.cjs` strips them anyway).
3. One call does the rest, each part only after the one before it succeeded:

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
     in the summary's terms ("fix the lint and try again") and you hand it to a fresh review agent
     of step 9, or they fix it themselves and press "Try again".
   - `COMMIT_REFUSED <log>` then `CHANGES_KEPT`, `CHANGES_RESTORED` or `CHANGES_LOST <snapshot>` →
     POST `pr` `failed` with the log's decisive line; with `CHANGES_LOST`, tell the user plainly
     that `git -C "<ROOT>" stash apply --index <snapshot>` brings the staged work back.
   - `PUSH_FAILED <branch> <reason>` (no credentials, a protected branch) → POST `pr` `failed`; the
     commit stands, and "Try again" pushes it (`NOTHING_TO_COMMIT` then `PUSHED`).
   - `PR_FAILED <reason>` → POST `pr` `failed`; the commit and the push stand.
4. A split task (`taskSplit` not empty; its parts and `N` as in step 4, "Split task", `<branch>` =
   `splitBranch`): first `split-fixups.cjs` without `--stage-all` (step 4, "Split task"), so whatever
   is still staged lands in its own part; then
   `node "<SKILL_DIR>/scripts/finish-pr.cjs" --root="<ROOT>" --task-dir="<SESSION>/tasks/T" --branch=<branch>-part-<N> --amend --no-pr --push=<branch>-part-1,…,<branch>-part-<N>`
   — what `FIXUPS_KEPT` left is amended into the last part, and every part branch is pushed. Then
   one description per part (what THAT part does, `pr-body-<n>.md`) and one pull request per part,
   in order — part 1 into `BASE`, part `n` into `<branch>-part-<n-1>` — so each one shows only its
   own part's diff:
   `node "<SKILL_DIR>/scripts/create-pr.cjs" --root="<ROOT>" --head=<branch>-part-<n> --base=<its base> "--title=<the message's first line> (part n/N)" --body-file="<SESSION>/tasks/T/pr-body-<n>.md"`.
   POST `pr` `created` with every URL in `urls`.
5. Delete `pr-request.json`, and print in the terminal: the commit, the pull request URL(s) or
   the failure. The worktree stays while the server runs (point 8).

After `SERVER_GONE` the same flow runs from the file, printing the outcome instead of posting it.
