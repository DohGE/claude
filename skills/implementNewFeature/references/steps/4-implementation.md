## Step 4 — Implementation (view-only)

1. Pick this task's working directory `ROOT`, once, here. A new branch starts from the
   repository's main branch `BASE`, never from whatever happens to be checked out — unless the user
   asked for another start (a branch they named, or the current one) in the requirements or since,
   and then from that. `BASE` is the first that `git -C "<PROJECT>" rev-parse --verify --quiet <name>`
   finds of: the name `git -C "<PROJECT>" symbolic-ref --short refs/remotes/origin/HEAD` gives
   without its `origin/`, `main`, `master`, then the same three under `origin/`. A branch that
   already exists is checked out as it is, with its own commits; its `BASE` is still the main
   branch found that way, the one its pull request will target.
   Every task's orchestrator picks on its own, so the project's checkout is the server's to hand
   out: POST `{"taskId":"T","root":"<PROJECT>"}` first.
   - `200` → `ROOT = PROJECT`, T's for the rest of the run, and
     `git -C "<ROOT>" checkout -b <branch> <BASE>` (or `checkout <branch>` when it already exists).
     When git refuses because of local changes, go to
     the failure protocol with its message — never stash, reset or discard the user's work.
   - `409` (`root … is task tN's`: another task has it) →
     `ROOT = <parent of PROJECT>/<basename of PROJECT>-worktrees/<slug>-<taskId>`,
     where `<slug>` is the branch with `/` and non-ASCII replaced by `-`. The task id is what keeps
     the path unique: two different branches can slugify to the same string, and `worktree add`
     would then fail on an existing directory. Create it with
     `git -C "<PROJECT>" worktree add "<ROOT>" -b <branch> <BASE>`.
     When the branch already exists and is not checked out anywhere, use
     `git -C "<PROJECT>" worktree add "<ROOT>" <branch>`. When it IS checked out elsewhere, go to
     the failure protocol with a report naming the conflict.
   A fresh worktree has neither `node_modules` nor the untracked local config the app needs. Bootstrap it before spawning anything, with ONE call (Bash tool):

       node "<SKILL_DIR>/scripts/bootstrap-worktree.cjs" --root="<ROOT>" --project="<PROJECT>"

   It installs from whatever lockfile the project committed and copies across, at the same path
   relative to the root, every `.env*` file (`envFiles`) and every gitignored, untracked `*.local.*`
   config such as `proxy.<app>.local.js` (`localFiles`) — a fresh worktree has none of them, and
   the one an app's dev server reads is the one whose absence looks like an application bug in
   step 5 rather than a missing file. Do NOT do either by hand: the copier skips `node_modules`,
   build output and the run's own `.claude` folder, and a hand-rolled walk of the project finds a
   dependency's `.env.example` long before it finds the project's own.
   `errors[]` non-empty → failure protocol for step 4. `warnings[]` is not a failure: a failed or
   skipped install means step 5 cannot run the suites, and it is reported, not retried. Keep
   `installed` and say so in the summary. When `ROOT` is `PROJECT` the call is a no-op that says so —
   that checkout already has both. Playwright is unaffected either way: the pipeline keeps using
   the plugin's own installation in `SKILL_DIR`.
   Then ONE call for both records, `BASE` without its `origin/`:
   `node "<SKILL_DIR>/scripts/post-state.cjs" --port PORT '{"taskId":"T","root":"<ROOT>","base":"<BASE>"}' '{"taskId":"T","step":4,"status":"in_progress","activeStep":4,"progress":0}'`
   — the summary names `root`, and the pull request targets `base`.
2. Spawn the implementation agent from `references/implementation-agent.md`, per "Spawning a
   sub-agent" (`ROOT` is the one step 4 just fixed, `--set=BASE=<BASE>` — the TDD gate compares
   against it). It reports progress itself via POST /api/state and writes code against the
   `doh:codeReview` checklist of each file's kind (its "Coding rulebook" section). It builds from
   what the optional steps left — spec and plan, the approved mockups, the story — and falls back
   to the requirements form for each one that did not run; its brief tells them apart by which
   files exist, so nothing about the switches goes into the prompt.
3. Final JSON `{"type":"result","filesChanged":[…],"summary","deviations":[…]}` → POST
   `{"taskId":"T","step":4,"status":"completed","progress":100,"report":"<the summary, then every
   `deviations` entry on its own line>","activeStep":<the next step: 6>}` and start it. Keep the
   `filesChanged` COUNT, the summary and the deviations; the path list itself stays out of your context.
   `deviations` is the agent's only channel for what it had to do differently — a plan step it
   replaced, a mockup that overrode the plan, a rulebook its worktree never received because the
   project had not committed it, a file the TDD gate listed that needs no spec. Nothing else in the
   run reports any of that, so an orchestrator that parses the field and drops it hides exactly the
   part a reviewer needs. `error` → failure protocol.
4. Stop what the step left running: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"` (`NONE` is the usual answer).
