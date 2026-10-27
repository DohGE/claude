## Final summary (per task)

1. Delete `<SESSION>/tasks/T/auth.json` if it still exists — the last E2E step normally already did,
   so this is the backstop for tasks that never got there (the server also wipes every task's on
   shutdown). Do this on BOTH outcomes — success and `finish` after a failure.
2. Collect from step results only (no file contents): changes, features, tests (E2E suite + the project's unit suite), API mocks, mockup comparison, UX findings, review results of both reviews, and step 4's deviations when it reported any — they belong at the end of `changes`, prefixed so a reader sees at once that the run departed from the plan.
3. POST `{"taskId":"T","summary":{"finalStatus":"...","changes":[...],"features":[...],"tests":"...","apiMocks":"...","mockupComparison":"...","uxReview":"...","codeReview":"..."}}` (`tests` = the validation agent's `testsSummary` and `unitSummary`; `apiMocks` = its `apiMockSummary`; `mockupComparison` = its `mockupSummary` - every renamed field is listed here, so a missing line reads as "no source" and the section lands empty even when the step did the work; `uxReview` = its `uxSummary`; `codeReview` = the `reviewSummary` of step 6, then that of step 9 when it ran, each naming every finding it rejected and on what ground). `finalStatus` is `Completed` on success — a FIXED IDENTIFIER the pull request button reads — and `Failed at <step name>` after a `finish`. Put the task's branch and `ROOT` at the top of `changes` so the user can find the work.
4. Stage that task's changes: `git -C "<ROOT>" add -A` (already done by the review agents; verify
   with `git -C "<ROOT>" status --short`). Worktrees have their own index, so tasks never stage into each other.
5. Print T's summary in the terminal (user's language): its branch, working directory and final
   status, then the details. Every other task's orchestrator prints its own.
6. Tell the user how the work leaves the run: the summary screen's **Shut down and create pull
   request** button commits T's staged changes with the step-1 commit message, pushes the branch,
   opens a pull request into the branch it was started from and removes T's worktree (below). By
   hand instead: `superpowers:finishing-a-development-branch` for T's branch, and — when T got a
   worktree — `git worktree remove <ROOT>` AFTERWARDS, in that order: the pipeline ends with the
   work staged and uncommitted, and `git worktree remove` refuses a worktree in that state
   (`fatal: ... contains modified or untracked files`). Say plainly that `--force` is NOT the way
   around it — it would delete the feature the run just built.
7. Leave the server running — other tasks may still be on it. Do NOT kill the PID yourself. After
   the summary, keep T's waiter listening (start it if none is) and serve what it brings — a
   "Generate Mockoon mocks" press arrives this way — but when it ends in `WAIT_TIMEOUT`, end your
   turn WITHOUT starting another. Tell the user, in the summary, that a button pressed after that
   waits in the server until they type anything in this terminal, or until "Open session" in the
   stepper's corner opens a new one for T; then drain the queue with
   `node "<SKILL_DIR>/scripts/wait-answer.cjs" --port PORT --task T --minutes 0` in the foreground,
   act on each `ANSWER`, and go back to the event loop. The run ends when the user presses "Shut
   down server" or "Shut down and create pull request" — either stops every task's run, so they
   press it once the others are done too — or the server dies. Point them at the buttons rather
   than letting them close the terminal: pressing one is also what wipes every task's `auth.json`,
   so a run killed any other way leaves the credentials they typed sitting in the session directory
   (git-ignored, but still on disk) until they delete them by hand. The browser keeps its own copy
   when "Remember on this browser" was left ticked on the step-1 form — that one is the user's to
   clear, by unticking it, and no shutdown touches it. Say so if they ask where their password lives.

## Shut down and create pull request

`{"kind":"summary","decision":"shutdown_pr","taskId":"T"}` reaches every task whose pipeline ended
`Completed`, and the server writes `<SESSION>/tasks/T/pr-request.json` — `branch`, `base`, `root`,
`commitMessage` — before the page shuts it down. The server is gone moments later, so everything
below runs from the terminal and posts nothing. An orchestrator that was not listening finds the
file when its waiter next says `SERVER_GONE` (or at "Attach"): the same flow, from the file.

1. Read `pr-request.json` (it is T's own record, not the user's secret). `ROOT` = its `root`;
   `BASE` = its `base`, else the main branch step 4 would pick; the message = its `commitMessage`,
   else `<branch>`.
2. `git -C "<ROOT>" add -A`, then `git -C "<ROOT>" status --short`: nothing staged → say so and
   skip to 6 (there is nothing to commit, and a pull request without commits is refused).
3. `git -C "<ROOT>" commit -m "<the message>"` — exactly the user's message; never `--no-verify`.
   A hook that refuses the commit stops the flow: show its output and leave the worktree as it is.
4. `git -C "<ROOT>" push -u origin <branch>`. A refused push (no credentials, a protected branch)
   stops the flow with git's own line.
5. Write the pull request's description in ENGLISH, at most five sentences, to
   `<SESSION>/tasks/T/pr-body.md`: what the feature does and the main changes, taken from the
   step results you kept (the summary's features and changes) — never from reading the diff. Then:
   `node "<SKILL_DIR>/scripts/create-pr.cjs" --root="<ROOT>" --head="<branch>" --base="<BASE>" --title="<the message's first line>" --body-file="<SESSION>/tasks/T/pr-body.md"`
   → one line, a FIXED IDENTIFIER: `PR_CREATED <url>`, `PR_EXISTS <url>` (the branch already had
   one — nothing new was opened) or `PR_FAILED <reason>` (say it; the commit and the push stand).
6. When `ROOT` is a worktree (not `PROJECT`):
   `node "<SKILL_DIR>/scripts/remove-worktree.cjs" --project="<PROJECT>" --root="<ROOT>"` →
   `WORKTREE_REMOVED <root>`, or `WORKTREE_KEPT <reason>` (uncommitted work, or git refused — say
   so; never `--force`). It unlinks every link inside the worktree first, so a `node_modules`
   linked in from the main checkout keeps its files. The branch and its commits stay.
7. Delete `pr-request.json`, and print in the terminal: the commit, the pull request URL, and
   whether the worktree went. Then stop: the server is down, the run is over.
