# fixPr agent - step 6 point 4: land the commit

Read by the fix agent of `{{BRANCH}}` at step 6 point 4, once the commit exists (or the run
legitimately committed nothing). Worktree: `{{ROOT}}` | Base: `{{BASE}}` | Landing: `{{LANDING}}`
| Push: `{{PUSH}}` | Skill dir: `{{SKILL_DIR}}`

{{#if LANDING=hold}}
- `hold` — `{{BASE}}` is another open pull request's branch: do NOT rebase and do NOT
  push. The orchestrator moves your commit onto `{{BASE}}` once that one has landed, runs the gate
  and pushes (restack.cjs). Report `held: true`, `rebased: false`, `pushed: false`, and go on with
  step 6 point 6. A rebase of yours here is what left part-2 on a part-1 that part-1's own rebase
  had rewritten.
{{/if}}
{{#if LANDING=keep-base}}
- `keep-base` — other open pull requests are built on this branch, and a rebase here rewrites
  every one of them. `git -C "{{ROOT}}" fetch origin {{BASE}}`, then
  `git -C "{{ROOT}}" merge-tree --write-tree --quiet origin/{{BASE}} HEAD`: exit 0 → it still merges
  cleanly, so no rebase (`rebased: false`, "keeps its base: stacked pull requests build on it" in
  `summary`); exit 1 → it no longer merges: rebase it exactly as `rebase` says below; any other exit
  → no rebase, and say so in `summary`.
{{/if}}
{{#if LANDING=rebase|keep-base}}
- `rebase`{{#if LANDING=keep-base}} (reached from `keep-base` only when it no longer merges){{/if}} — rebase the commit onto the current base, so the pull request lands on what `{{BASE}}`
  holds now:
  - `git -C "{{ROOT}}" rev-parse origin/{{BRANCH}}` → keep it as `<remote-sha>` (where the remote
    branch stood when you started);
  - `git -C "{{ROOT}}" fetch origin {{BASE}}`;
  - `git -C "{{ROOT}}" merge-base --is-ancestor origin/{{BASE}} HEAD` exits 0 → the branch already
    holds the whole base: nothing to rebase, `rebased: false`, go to the push;
  - otherwise `git -C "{{ROOT}}" rebase origin/{{BASE}}`. A conflict → `git -C "{{ROOT}}" rebase
    --abort`, which puts your commit back exactly as it was: `rebased: false`, the conflicting files
    and the reason in `summary`, and go to the push with the commit un-rebased. Never resolve a
    rebase conflict yourself - it is a merge of other people's work, not a review comment.
  - A rebase that went through brought the base's newer commits under your change: run the full
    gate (step 5, without `--tests=near`) once more. Red now → the base and your change do not fit
    together: `git -C "{{ROOT}}" reset --hard ORIG_HEAD` (back to your commit before the rebase - the
    only reset you ever run), `rebased: false`, the red command in `summary`, and go on un-rebased.
    Green (or `green-no-tests`: no unit test ran, as in step 5) → `rebased: true`.
{{/if}}
{{#if PUSH=no}}

With `{{PUSH}}` `no`, rebase all the same: the user pushes the branch as it is. No push: report
`pushed: false`.
{{/if}}
{{#if PUSH=yes}}
{{#if LANDING!=hold}}

**The push.** Push through the script that retries what fails for a moment (GitHub's `fatal error
in commit_refs_rules`, a 5xx, a dropped connection) and never a rejection. It pushes `HEAD` to
`origin/{{BRANCH}}`, whatever the local branch is called (a branch the user has checked out is
worked here on `doh-fixpr/{{BRANCH}}`):
- Not rebased: `node "{{SKILL_DIR}}/scripts/restack.cjs" --action=push --worktree="{{ROOT}}" --branch={{BRANCH}}` - plain push.
- Rebased: the branch's history was rewritten on purpose, so the push replaces it, guarded by
  the remote state you saw: the same command with `--lease=<remote-sha>` (a
  `--force-with-lease={{BRANCH}}:<remote-sha>` push). Never a bare `--force`, never a lease
  without `<remote-sha>`.
Its JSON says `pushed`, `attempts` and, for a refusal, `rejected: true`. A rejected push means
the branch moved on the remote WHILE you were working: do not fight it - no second rebase, no
other force. Report `pushed: false` with the rejection text in `summary` and leave the commit
sitting on the local branch for the user.
{{/if}}
{{/if}}

Then go back to the brief: step 6 point 6, the report.
