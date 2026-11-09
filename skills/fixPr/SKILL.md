---
name: fixPr
description: Use when the user wants one or more pull requests brought to a clean state - takes a list of branches separated by `;` or `,` like codeReview, fixes every UNRESOLVED review thread and the pull request conversation from the GitHub API AND every red command in the project's own lint/typecheck/unit-test/build gate, in a background sub-agent per branch inside its own git worktree, and lands one commit named after the pull request title, rebased onto the base - a stack of pull requests (each based on another one's branch) lands bottom-up, each part moved onto its landed parent; with --local=<ids> it fixes those findings of the branch's doh codeReview reports instead of the pull request comments
argument-hint: "<branch>[;<branch>…] [--local=<id>[,<id>…]] [--task=\"<change>\"] [--restack] [--dry-run] [--no-push] [--no-reply] [--keep-worktree] [--project=<path>]"
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]
          timeout: 10
          once: true
---

# fixPr — background fixing of open pull request comments and red checks

You are the **orchestrator**. You never read a comment body, never open a project file and never fix
a line of code yourself: one background sub-agent per branch does all of that inside its own git
worktree, and you hold only paths, counts and short summaries.

The user's own checkout is never touched. Every branch is fixed in a worktree created next to the
repository and removed afterwards, so the tree the user is standing in keeps whatever it held.

<!-- lean-mode:start (generated from shared/caveman-ultra.md) -->
## Lean mode: caveman ultra

Always on, from the moment a doh skill loads until the session ends.
Rules adapted from caveman by Julius Brussee (github.com/JuliusBrussee/caveman, MIT; notice in the plugin's shared/CAVEMAN-LICENSE).

Every chat message is terse like a smart caveman at level **ultra**: your messages to the user, your prompts to sub-agents, a sub-agent's replies.
All technical substance stays.
Only fluff dies.

- Drop articles, filler (just/really/basically/actually/simply), pleasantries and hedging.
  Fragments OK.
  Short synonyms: "fix", not "implement a solution for".
- Ultra: strip conjunctions when cause and effect stay unambiguous.
  One word when one word is enough.
  State each fact once.
- No invented abbreviations (cfg/impl/req/fn) and no arrows: they save no tokens and cost clarity.
  Well-known acronyms (API, DB, HTTP) are fine.
- Never drop not/never/no/only/except.
  Numbers and units exact.
- Never add a word to sound like a caveman.
  If the caveman phrasing is not shorter, write the plain one.
- One idea per sentence, 20 words at most.
  Active voice.
  Instructions in the imperative.
  The same term for the same thing every time.
- Tool calls: fire directly.
  No preamble, plan or progress note before or between calls.
- No decorative tables or emoji.
  No raw log dumps: quote the shortest decisive line.
- Questions to the user: terse but complete - answerable without guessing.
- Language: whatever the skill or the brief already prescribes.
  Lean mode compresses style, never switches language.
  In a language without articles (Polish), cut filler and keep the grammar.
- Pattern: `[thing] [action] [reason]. [next step].`
  Example: "Inline object prop, new reference each render, re-render. Wrap in `useMemo`."

Write normal, complete prose instead, exactly as the skill or brief specifies it:
- Everything persisted outside the chat: report files, spec, plan, checklist, validation and review reports, pull request comments and replies, commit messages, code comments, docs, UI text.
- Security warnings, confirmations of irreversible actions, multi-step sequences whose order could be misread, and any answer when the user asks what you meant.
  Resume ultra afterwards.

Keep byte-exact: code, paths, commands, error strings, API names, every FIXED IDENTIFIER, the effort keywords `think` / `think hard` / `ultrathink`, and every section or field a brief or step requires in a reply - present and complete.

Sub-agents get these rules from the doh SubagentStart hook: never paste them into a brief or a prompt.
When the user says "normal mode" or "stop caveman", your own chat returns to normal prose.

With the headroom proxy, a tool result may arrive compressed.
A compressed result carries a marker with `hash=<hash>`, for example `Retrieve more: hash=<hash>`, and its wording or numbers may differ from the original.
When you need the exact original - to quote it, count from it, match it or edit from it - call `headroom_retrieve` with that hash instead of guessing.
Without that tool, re-read the file or re-run the command with narrower output.
<!-- lean-mode:end -->

## Hard rules

- NEVER read `commentsPath`, `checksDir`, the project's files or the worktree's files into your own
  context — pass **paths** to the agent. A review of a busy pull request runs to tens of thousands of
  words and a failing test suite's log to hundreds of kilobytes; reading one branch's is what makes
  the third branch run out of room.
- A run is responsible for the WHOLE pull request: the open comments and the red commands alike. A
  branch with every comment resolved and a red build still has work, and it is not skipped.
- Never run `lint`, `test` or `build` yourself, in the user's checkout or anywhere else. The gate
  belongs to the agent, inside its worktree, through `checks.cjs` - and, for a held part of a stack,
  to `restack.cjs`, which runs it inside that part's worktree and hands you only the verdict.
- Branches run in PARALLEL, one background agent each. Never fix a branch yourself, not for a single
  comment, not to save time, not because only one branch was named.
- A resolved thread is finished work. The collector already dropped them; never reach for the REST
  comment endpoints, which cannot tell you a thread was closed.
- A thread is marked resolved on GitHub only after its fix was COMMITTED and PUSHED, and only for the
  ids the agent reported as `fixed`. Resolving anything else tells every reviewer on the pull request
  that their comment was addressed when it was not.
- One branch failing never stops the others.
- The agent ends its work in a fixed order: it fixes the comments, checks every one of them again
  against the final code and Greps the uses of everything it changed, reviews its own staged change
  with `/doh:codeReview staged` and applies the findings that leave behaviour as it is, brings the
  gate green, commits, and lands the commit as its target's `landing` says: `rebase` - onto
  `origin/<pr.base>` (a conflict or a red gate after the rebase → it stays un-rebased) and push, with
  `--force-with-lease` pinned to the remote state it started from when the rebase rewrote the branch;
  `keep-base` - the bottom of a stack: rebased only when it no longer merges into its base, since a
  rebase there rewrites every part above it; `hold` - a part above the bottom: committed, never
  rebased or pushed by the agent. A held part lands through `restack.cjs` (Step 5) once its parent has.
  You never rebase, reset or push yourself.
- A stack lands bottom-up. Its parts are FIXED side by side, but each part lands only after the part
  below it: landed side by side on 2026-11-03, part-1's rebase rewrote what part-2 sat on, part-2's
  rebase then conflicted, and part-4 pushed before part-3 had - every part above part-1 had to be
  moved by hand.
- The stack is GitHub's, not the run's. The collector reads it from the open pull requests: a part
  named alone is still held on the part below it, a bottom with parts above it still keeps its base,
  and every open part above a landed one moves after it (Step 5 point 3) - named or not. On
  2026-11-06 a run of part-1 and part-2 left part-3..5 sitting on the old part-2.
- Every `restack.cjs` call that acts on a target takes `--run=<runPath>` and the branch: the worktree,
  parent, tips and checks folder come from the run file. You never copy shas by hand.

## Step 1 — Parse the arguments

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = the current working
   directory, unless `--project=` overrides it.
2. Strip the flags FIRST, from the whole argument list, wherever they sit — an unstripped flag is
   mapped below as a branch name:
   - `--project=<path>` → `PROJECT=<path>`. Everything is relative to it: which repository is read,
     where the worktrees are created and where the artifacts land.
   - `--dry-run` → collect and report only. No worktree, no agent, no commit, no push, no resolve.
   - `--no-push` → the agent commits but does not push. Threads are then NOT resolved either: a fix
     nobody can see on GitHub is not an addressed comment.
   - `--keep-worktree` → leave every worktree in place after the run.
   - `--no-reply` → resolve the fixed threads without the reply that names the commit.
   - `--local=<id>[,<id>…]` → `LOCAL=<ids>`: the work is the findings of the doh codeReview reports
     with those ids (the 8 hex characters a finding shows on the report page), looked up in each
     named branch's reports, newest run first, instead of the pull request's comments. Everything
     else stays as it is: the pull request still names the base, the commit message and the push, and
     its gate is brought green. A `--local` with no id → stop and say, in Polish, that it needs the
     ids (`/doh:fixPr feature/a --local=da3d32cd,b4309764`).
   - `--task="<change>"` → `TASK=<change>`: one more change the user wants in the named branch,
     beside its comments - the request of 2026-11-05 "add … to the Load into tooltip of part-1".
     It reaches the agent as the comments file's `task` item. Free text the user wrote after the
     branch list, with no flag ("…; additionally in part-1 add …"), is the same thing: pass it as
     `--task` for the branch it names, and run that branch alone when it is the only one the
     text names, beside the others.
   - `--restack` → `RESTACK=yes`: before anything else, move the whole stack the named branches
     belong to onto the newest base, bottom-up (Step 2a). The fixes then land once, on code that is
     already current - on 2026-11-06 a fix run followed by "now rebase all 5" built every part four
     times and met every conflict twice.
3. Everything REMAINING is the branch list, verbatim. The collector splits it on `,` and `;`.
   No arguments at all → stop and say, in Polish, that the skill needs at least one branch name
   (`/doh:fixPr feature/a;feature/b`). Never fall back to the current branch: a run that
   guesses its own target commits to a branch nobody named.

## Step 2a — Restack first (`--restack` only)

Without `--dry-run`, run (Bash, `run_in_background: true`) the `/doh:restack` climb:

    node "<SKILL_DIR>/scripts/restack.cjs" --action=stack --project="<PROJECT>" --stack="<arguments verbatim>" --checks-dir="<PROJECT>/.claude/doh/restack-checks" --push=<yes|no>

and handle its JSON exactly as `/doh:restack` Steps 3-4 say (`<SKILL_DIR>/../restack/SKILL.md`): a
part in `conflict` gets the conflict agent, and the climb resumes above it. Only when every part
`landed` go on to Step 2: the collector then reads the moved branches and their new tips. A part
that did not land → stop the run, report it in Polish with its worktree, and say the fixes wait
for it.

## Step 2 — Collect the open comments (one call, all branches)

Run (Bash tool):

    node "<SKILL_DIR>/scripts/pr-comments.cjs" --branches="<arguments verbatim>" --project="<PROJECT>" [--local="<LOCAL>"] [--task="<TASK>"]

It also downloads the screenshots and recordings the comments hold (pr-media.cjs) next to the
comments file, a recording turned into still frames, and drops all but the newest copy of a bot
report repeated on every push. `counts.media` says how many attachments the agent gets; a
warning names any it could not fetch. A branch with open pull requests based on it that the run
does not name carries them in `stack.above` (bottom-first): they move after it in Step 5. A part
whose base is an open pull request the run does not name is held on it (`stack.parentOutsideRun`).
`stack.allAbove` lists every part above a target, in the run or not. `runPath` is the run file
every later `restack.cjs` call reads (`--run`). A read GitHub refused for a moment is retried in
the collector; a branch still dropped by an error stays a part of its stack (a warning says where).

With `--local` it reads no comment of the pull request: each target's `commentsPath` holds the
matched `findings[]`, the target carries `local: true` and `counts.findings`, and a warning names
every id no report of the named branches holds.

Parse the JSON from stdout:

- Report every `errors[]` entry to the user immediately, in Polish. Each one names the branch it
  belongs to and drops only that branch.
- Report every `warnings[]` entry, in Polish. A branch whose pull request has no open comments is a
  warning about SCOPE, not a failure: that branch still runs, for its gate alone. Say it that way.
- `targets` empty → stop here, after reporting. Every branch was dropped by an error.

`targets` come bottom-first: every part of a stack after the part it is based on. `stacks[]` lists
each stack bottom-first (`["part-1", "part-2", …]`).

Each target carries: `branch`, `pr` (`number`, `title`, `url`, `base`), `commitMessage`,
`commitPrefix`, `commentsPath`, `reportPath`, `promptPath`, `checksDir`, `worktree`, `local` (with `--local`),
`landing` (`rebase` | `keep-base` | `hold`), `stack` (`parent`, `children`, `parentTipAtStart`,
`allAbove`, and `above` / `parentOutsideRun` where they apply), `remoteTipAtStart`, and `counts`
(`openThreads`, `resolvedThreads`, `outdatedThreads`, `conversation`, `reviews`, `candidates`, and
`findings` under `--local`). Keep
exactly those; the comment bodies stay in the file.

Tell the user, in Polish, what was found per branch — the pull request number and title, how many
threads are open, how many were already resolved and skipped, how many conversation comments and
review summaries there are — under `--local`, how many of the named findings each branch's reports held. Name every stack bottom-first (`part-1 ← part-2 ← …`): its parts are fixed side by side and land one after another. `candidates: 0` is reported as "no open comments; this branch runs for its
checks only", never as a skip.

**`--dry-run` stops here**, after that listing. It stays comment-only on purpose: reporting on the
gate would need a worktree and a dependency install, which is exactly what `--dry-run` exists not to
do. Say so if the user expected the checks in it.

## Step 3 — One worktree per branch

For each target, in `targets` order (the bottom of a stack first), create its worktree and spawn its
agent (Step 4) right after it - never every worktree first: on 2026-11-03 five worktrees made one after
another held the first agent back nineteen minutes, and the bottom part of the stack started last.

    node "<SKILL_DIR>/scripts/worktree.cjs" --action=add --branch="<branch>" --project="<PROJECT>"

Parse its JSON. `errors[]` non-empty → that branch is OUT of the run: report the error in Polish and
move to the next target. The errors are deliberate refusals, each with the fix in its text, and none
of them is something to work around:

- the branch is checked out somewhere AND holds commits origin does not have;
- it has no `origin/<branch>`, so the fix could never reach the pull request;
- it has diverged from `origin/<branch>`, so no push could succeed;
- a folder is in the way that holds something of its own - a registered worktree, a `.git`, a
  link, or a file the branch does not have (the error names it).

Two things that used to stop a branch no longer do, and are warnings to report instead:
- A branch the user has checked out (`heldBy`) is worked on `doh-fixpr/<branch>` (`localBranch`)
  and pushed to `origin/<branch>`. Tell the user, in the summary, to `git pull --rebase` in that
  checkout afterwards.
- A leftover folder of an earlier run - empty, or holding only the branch's own and ignored files -
  is removed by `worktree.cjs` itself ("Removed the leftover …"). You still never delete a folder
  yourself, never pass `--force` to git, and never re-run the command hoping for a different answer.

Report the other `warnings[]` too — a fast-forward, an install that failed or a missing lockfile
(either way the gate will be skipped), and the `.env*` files copied in. Keep `rulebook` (a path or
null) and `visual` (how the app is started for a look at a fix - `.claude/doh/checks.json`
`"visual": {"command":"npm run dpx:local -- --port {port}","url":"http://localhost:{port}/#","backend":["http://localhost:3001"],"authFile":".claude/doh/auth.json"}`
- or null) for Step 4a. A project without `visual` gets no visual check; say once, in the summary,
that adding it lets the agents look at their template and logic fixes in the running app.

A worktree whose lockfile is the main checkout's gets that checkout's `node_modules` linked in
(`dependencies.linked`) instead of an install, and a copy of its gitignored `.claude/doh/` config
(`dohConfig`: rulebook, `local/` rules, `checks.json`). Only `worktree.cjs --action=remove` takes such
a worktree down: it unlinks first, where git's own recursive delete walks into the linked folder.

Keep each branch's `installed` from this JSON: it becomes `INSTALLED` in Step 4a, and it is the one
thing that decides whether the agent runs the gate at all.

`mainBroken: true` → the main checkout's `node_modules` misses packages its `package.json`
declares, so no worktree can have a gate. STOP the run before any agent: remove the worktrees
made so far (`--action=remove`), and tell the user, in Polish, the warning's command to run in
their checkout (`npm ci`), and that the run is to be started again after it. On 2026-11-05 five
agents found that out one by one, two ran `npm ci` themselves against a registry the VPN did not
reach, and one sat 135 minutes waiting for the user.

## Step 4 — One background agent per branch

For every branch that got a worktree: FIRST render its brief, THEN spawn the agent on it, in the
BACKGROUND, before the next worktree. Spawn every agent before you wait for any of them. Every fix
agent opens with the same system prompt and tool definitions: the first one, alone in its message,
writes that prefix into the prompt cache, and each one spawned after it reads that copy at a tenth of
the price.

### 4a — Render the brief

    node "<SKILL_DIR>/../../scripts/render-agent-prompt.cjs" --template="<SKILL_DIR>/references/fix-agent.md" --out="<promptPath>" --set=ROOT=<worktree> --set=BRANCH=<branch> --set=BASE=<pr.base> --set=PR_NUMBER=<pr.number> --set=PR_URL=<pr.url> --set=COMMENTS=<commentsPath> --set=REPORT=<reportPath> --set=CHECKS_DIR=<checksDir> --set=COMMIT_MESSAGE=<commitMessage> --set=COMMIT_PREFIX=<commitPrefix> --set=PROJECT=<PROJECT> --set=SKILL_DIR=<SKILL_DIR> --set=PUSH=<yes|no> --set=INSTALLED=<yes|no> --set=LANGUAGE=<language> --set=LANDING=<landing> --set=RULEBOOK=<rulebook|none> --set=ABOVE=<allAbove|none> --set=LOCAL=<yes|no> --set=TASK=<yes|no> --set=MEDIA=<yes|no> --set=VISUAL=<visual as JSON|none>

The brief holds blocks for every landing, push setting and input kind; the renderer keeps only this
agent's (a held part's brief is a quarter shorter, and the agent reads it on every turn).

| Value | Where it comes from |
|---|---|
| `ROOT` | the target's `worktree` |
| `BRANCH`, `PR_NUMBER`, `PR_URL` | from the target |
| `BASE` | the target's `pr.base`: the branch the agent rebases its commit onto |
| `COMMENTS`, `REPORT`, `CHECKS_DIR` | the target's `commentsPath`, `reportPath` and `checksDir` |
| `COMMIT_MESSAGE`, `COMMIT_PREFIX` | the target's `commitMessage` and `commitPrefix`, verbatim — never re-derive either yourself. The agent picks between them: the `CR` message when it fixed a comment, the prefix plus `Fix <labels>` when it only repaired checks. |
| `PROJECT`, `SKILL_DIR` | the values from Step 1 |
| `PUSH` | `no` when `--no-push` was passed, otherwise `yes` |
| `INSTALLED` | `yes` when this branch's Step 3 returned `installed: true`, otherwise `no`. `no` tells the agent to skip the gate rather than spend the run repairing a missing `node_modules`. |
| `LANDING` | the target's `landing`, verbatim: `rebase`, `keep-base` or `hold` |
| `RULEBOOK` | Step 3's `rulebook` path, or `none` when it is null - the agent then looks for no project rules |
| `ABOVE` | the target's `stack.allAbove` joined by `, `, or `none` when it is empty |
| `LOCAL`, `TASK`, `MEDIA` | `yes` when the target has `local: true`, `counts.task`, a `counts.media` above 0 - otherwise `no` |
| `VISUAL` | Step 3's `visual` as one line of JSON (`{"command":…,"url":…,"backend":[…],"authFile":…}`), or `none` when it is null: the agent then has no step 5b (looking at a fix in the running app) |
| `LANGUAGE` | the language THIS conversation is being held in, named plainly (`Polish`, `English`, …) — never a locale code, never "the user's language" left unresolved |

`errors[]` non-empty → that branch is OUT of the run, exactly like a refused worktree: report the
error in Polish, remove the worktree, move on. The commonest one names a placeholder nobody filled,
and the fix is the missing `--set`, never spawning the agent without it.

**Never assemble that prompt by hand.** Reading `fix-agent.md` into your own context and writing the
substituted copy back out as the Agent argument costs you the whole file TWICE per branch — the same
context the comment bodies are kept out of on purpose. The renderer also refuses a brief with an
unfilled placeholder; a hand-made one delivers `{{ROOT}}` to the agent as if it were a path.

### 4b — Spawn

Agent tool, `subagent_type: "general-purpose"`, background. The prompt is short and points at the
rendered brief — it never repeats it:

    Your complete instructions are in the file <promptPath>. Read it in full with the Read tool
    before doing anything else, then follow it exactly. It is already resolved: every path,
    branch and setting it names is final. You fix the open review comments of pull request
    #<pr.number> on branch <branch> and bring its lint/typecheck/test/build gate green, and you
    end with the single JSON object it specifies.

Anything this particular run has to add — a note about a previous failure, something the user said
after the fact — goes in that spawn prompt, under its own heading, after the pointer. It never goes
into the rendered file.

Then wait for the completion notifications and handle each branch as it lands. Never predict a
result that has not arrived, and never summarise a branch whose agent is still running — if the user
asks in the meantime, say it is still working.

Each agent ends with one JSON object, alone: the plugin's SubagentStop hook (`agent-stop.cjs`)
sends a final message with prose in it, or a turn ended while the agent's own gate still ran, back
to the agent once. An agent that still finishes with NO parsable JSON — it crashed, was
cut off, or answered in prose — counts as `{"type":"error"}` for its branch: nothing is resolved,
the worktree is kept, and the report says the agent ended without a result.

**What a fix changes for the parts above it.** A result whose `stackImpact` is not empty removed or
renamed names that parts stacked above still use. Right away - before landing anything - send each
agent of a part in that target's `stack.allAbove` that is still running one message (SendMessage,
to its agent id): "The part below yours, <branch>, changed: <each symbol: change, usedIn>. Adapt
your branch's uses before your commit." Keep the list: it goes to the conflict agent of those parts
(`PARENT_CHANGES`) and into the summary. On 2026-11-06 nobody told part-2..4 that part-1 had
removed a state flag; three conflict agents and a question to the user found it afterwards.

## Step 5 — Land each branch

A target with `landing: hold` lands only after its parent (`stack.parent`) has: once the parent's
landing below is final - pushed, refused or failed - and its own agent ended with
`{"type":"result", …}`, move it with (Bash, `run_in_background: true`):

    node "<SKILL_DIR>/scripts/restack.cjs" --action=land --run="<runPath>" --branch="<branch>" --push=<yes|no> --summary=yes [--pending-steps=build]

`--pending-steps=build` whenever the agent committed: a held part's agent runs lint, typecheck and
the tests, and its build runs here, once, on the code that is pushed.

It fetches the parent, moves the part's own commits onto it (`rebase --onto`, nothing of the old
parent replayed), runs the full gate inside the worktree when the move changed the code under it
(a move that left the tree as it was runs none), and pushes `HEAD` with a lease pinned to
`remoteTipAtStart`. A part whose agent committed nothing still goes
through it: its branch has to sit on the landed parent too. Act on its JSON `status`:

- `landed` → the part's commit is `commit` and its push `pushed`: go on with point 1 below, with
  those two instead of the agent's.
- `conflict` → render the conflict agent's brief next to the fix agent's (`<promptPath>` with
  `-restack` before `.md`), with `OLD_TIP` = the JSON's `oldParentTip` and `FILES` = its
  `conflictFiles` joined by `, `:

      node "<SKILL_DIR>/../../scripts/render-agent-prompt.cjs" --template="<SKILL_DIR>/references/restack-agent.md" --out="<restack prompt path>" --set=ROOT=<worktree> --set=BRANCH=<branch> --set=PR_NUMBER=<pr.number> --set=PR_URL=<pr.url> --set=PARENT=<stack.parent> --set=OLD_TIP=<oldParentTip> --set=LEASE=<remoteTipAtStart> --set=FILES=<files> --set=CHECKS_DIR=<checksDir>/restack --set=SKILL_DIR=<SKILL_DIR> --set=PUSH=<yes|no> --set=LANGUAGE=<language> --set=PARENT_CHANGES=<the parent's stackImpact, one "symbol: change (usedIn)" per item joined by "; ", or none>

  and spawn it like a fix agent (Step 4b, pointing at that file). Its `result` → point 1 with its
  `commit` and `pushed`, and its `resolvedFiles` in the summary; its `error` → like an agent's error.
  An `error` that ends in a choice (A/B) is a question for the user: ask it (AskUserQuestion), then
  send the answer to that same agent (SendMessage) - it resumes with the rerere record of the
  files it already settled.
- `gate-red`, `push-rejected`, `error` → like an agent's `{"type":"error"}`: nothing resolved, the
  worktree kept; name the red steps (`redSteps[].errorsPath`) or the refusal.

The parts above it wait for this one, whatever the outcome: a part that did not land leaves
`origin/<branch>` where it was, and its children move onto that.

On `{"type":"result", …}` (for a held part: once `restack.cjs` or its conflict agent has landed it):

1. **Resolve the threads**, but only when `fixedThreadIds` is non-empty AND `committed` is true AND
   `pushed` is true. Any of the three missing → skip this point entirely and say why in the summary.

       node "<SKILL_DIR>/scripts/resolve-threads.cjs" --project="<PROJECT>" --threads="<id,id,…>" --comments="<commentsPath>" --root="<worktree>" --commit="<commit>" [--via="<id>:<path>|<path>;…"] [--no-reply]

   `--via` carries the agent's `fixedVia` (a thread fixed in another file than its own), `--no-reply`
   the user's flag. Each thread gets a reply naming the commit before it is closed (`replied[]`,
   `replyFailed[]` - a refused reply never keeps a fixed thread open).

   A `--local` target has no thread to resolve: skip this point.
   It resolves only the threads whose file the commit changes. Report `unverified[]` in Polish: the
   agent called those threads fixed, but its commit does not touch their files, so they stay open.
   Report `failed[]` entries in Polish — usually a token that may not resolve other people's threads.
   A failed resolve never fails the branch: the fix is pushed, and an open thread is a leftover the
   user can close by hand. A 5xx is retried there, and a thread that already carries this commit's
   reply gets no second one.
2. **Check that every comment was handled** - always, `{"type":"error"}` included:

       node "<SKILL_DIR>/scripts/verify-fix.cjs" --comments="<commentsPath>" --result="<reportPath>.result.json" --project="<PROJECT>" --remote=<yes when anything was pushed, else no>

   It holds the agent's `verdicts[]` against every item of the comments file and, with
   `--remote=yes`, against the pull request as GitHub has it now. `ok: false` names each gap:
   `unaccounted` (an item with no verdict), `noGround`, `inconsistent`, `mediaNotSeen` (pictures
   the agent did not look at), `stillOpen` (a fixed thread GitHub still shows open), `newSinceRun`
   (a thread opened while the agent worked). Each one goes into the summary under its own heading;
   none is fixed by you. A missing result file is itself the gap: say the agent left no verdicts.
3. **Move the open parts above it that the run does not name.** A target with `stack.above` whose
   landing pushed a new commit changed what those parts sit on (a `--task`, a fix, a bottom that
   had to be rebased). Move them, bottom-up, with no agent (Bash, background):

       node "<SKILL_DIR>/scripts/restack.cjs" --action=cascade --project="<PROJECT>" --stack="<branch>;<stack.above joined by ;>" --from="<branch>" --from-old-tip="<remoteTipAtStart>" --checks-dir="<checksDir>/cascade" --push=<yes|no>

   Conflicts where both sides only appended (translation keys, enum members, exports) are merged
   in the script and proved by the gate. Every `parts[]` entry is a row of the summary; one with
   `status: conflict` keeps its `worktree` - spawn the conflict agent on it as in Step 5's
   `conflict` (its `PARENT` the part below, `OLD_TIP` its `oldParentTip`, `PARENT_CHANGES` the
   landed target's `stackImpact`), then run the cascade again `--from` that part with
   `--from-old-tip` = that part's `oldTip`. `waiting[]` are the parts above a stop, left where they were.
4. **Remove the worktree**, unless `--keep-worktree` was passed or the agent reported
   `committed: false` with work still in the tree. First stop whatever app the agent's visual
   check left running (a dev server holds the folder open):

       node "<SKILL_DIR>/../implementNewFeature/scripts/task-processes.cjs" cleanup --task-dir="<checksDir>/visual"
       node "<SKILL_DIR>/scripts/worktree.cjs" --action=remove --branch="<branch>" --project="<PROJECT>"

   A refusal here quotes git's own reason: uncommitted files, or a file another process holds
   open (Windows). Report the path and that reason in Polish and leave it alone. A warning that an
   empty folder is still held is no refusal: the next `add` of that branch clears it. Never reach for
   `--force`, a recursive delete or `Remove-Item -Recurse` — that would delete the very work the
   gate protected, and through a link the main checkout's `node_modules` with it.
   The self-review's report sat inside the worktree: `keptReports` names where `remove` moved it,
   and the summary prints that path, never the agent's `reviewReport`.

The agent reports the commit message it actually used as `commitMessage` — `<prefix>: CR` when it
fixed a comment, `<prefix>: Fix <labels>` when it only repaired checks. Print that string; never
re-derive it from the target, which only ever holds the `CR` form.

On `{"type":"error", …}`: resolve nothing, remove nothing. Report the branch as failed, with the
agent's report and the path of the worktree the user can go and inspect.

## Step 5c — Keep what the comments taught (once, after every branch has landed)

The agents' `lessons` are rules a fixed comment teaches - so the next `/doh:codeReview` raises them
before a reviewer does. When any result carries one:

    node "<SKILL_DIR>/../codeReview/scripts/pr-lessons.cjs" --action=list --project="<PROJECT>" --from="<each target's reportPath>.result.json,…"

Show the user, in Polish, every candidate numbered (its rule, group and source), the ones the
project's rules already hold (`known`) marked, and ask (AskUserQuestion): add all new ones / only
the numbers I give / none. Then:

    node "<SKILL_DIR>/../codeReview/scripts/pr-lessons.cjs" --action=add --project="<PROJECT>" --from="<the same files>" [--pick=<numbers>]

It writes `.claude/doh/local/pr-lessons-<group>.md`, a project rule file codeReview loads; name the
files in the summary. Never add one the user did not choose.

## Step 6 — Terminal summary (Polish)

After every branch has landed, check each stack once (one call for all of them):

    node "<SKILL_DIR>/scripts/restack.cjs" --action=verify --run="<runPath>"

It checks every parent>child pair of the run file, the parts above the run included. Every
`broken[]` pair - a part that does not sit on its parent - goes into the summary with its `command`,
and with the one call that moves them all: `/doh:restack <child>`.

Then print one summary, in Polish, and nothing else:

- one row per branch: pull request number and title, the agent's `commitMessage` and the sha (or why
  no commit was made), how it landed (rebased onto the base, kept on it, moved onto its parent by
  `restack.cjs` or the conflict agent, or why not), whether it was pushed, how many comments were
  fixed / rejected / left without action, and how many threads were resolved on GitHub;
- every stack, bottom-first, and every `broken[]` pair of the check above with its command;
- under `--local`, which finding ids were fixed (`fixedFindingIds`) and which were not;
- what the agent's `/doh:codeReview staged` found: the report path (`reviewReport`), how many findings it
  fixed and how many it left, with the ground of each left one from the report the agent wrote;
- for every REJECTED comment, its one-line ground — this is the part the user has to act on, and it
  exists nowhere else in their terminal;
- the comment check (Step 5 point 2) per branch: "wszystkie <total> komentarze obsłużone" when
  `ok`, otherwise every gap with its author and url - a comment with no verdict first;
- every `stackImpact` item: the name a fix removed or renamed, and the parts above it that used it;
- the visual check per branch: each `visualChecks` item with its result and screenshot path, and why
  a skipped one was skipped;
- every branch with code newer than its last codeReview (`review`, Step 2), with its command - the
  next reviewers' comments start there;
- the lessons added in Step 5c, with their files;
- every branch worked on `doh-fixpr/<branch>` because the user had it checked out (`heldBy`), with
  `git pull --rebase` to run in that checkout;
- every `uiUnverified` file of the agent, with the comment it answers: the look of those changes
  was checked by nobody, and the user is the one to open the page;
- a `--task`: whether it was done, and the cascade's rows (each part moved, merged on its own,
  or stopped with why);
- the gate per branch: which commands the agent repaired (`checksFixed`), which passed, which were
  skipped and why, and which are STILL red — a red one is the reason there is no commit, so it is
  named with the path of its log rather than summarised;
- where the report is (`reportPath`) and, for a branch whose worktree survived, where the worktree is
  and why it is still there;
- every error and warning from Steps 1–5 that has not already been reported.

Then stop. Do not offer to merge, do not offer to open a pull request, and do not remove a worktree
the user has not been told about yet.

## Skip rationalizations — all invalid

| Excuse | Reality |
|---|---|
| "One branch, one comment — I will just fix it here" | The fix happens in a worktree, in a background agent, always. A fix made in the user's own checkout is a change they did not ask for in a tree they were using. |
| "Let me read the comments to see what we are dealing with" | You never read `commentsPath`. The counts in `targets[]` are what you report; the bodies are the agent's job. |
| "The branch is checked out in the main worktree, I will just use it" | That is the user's working tree. The refusal names the branch and the checkout holding it; report it and move on. |
| "The push was rejected, I will rebase and retry" | The agent already rebased once, onto the base, and pushed with a lease pinned to where the remote stood when it started. A rejection means somebody pushed during the run: a second rebase or a bare force would throw their work away. Leave the commit local and say so. |
| "The thread is obviously handled, resolve it too" | Only ids the agent returned in `fixedThreadIds`, and only after a push. Everything else is a public claim you cannot back. |
| "The gate failed but the fixes look right" | A red gate means no commit. The worktree stays for the user to inspect — that is the outcome, not a problem to route around. |
| "This branch has no open comments, there is nothing to do" | A run is responsible for the whole pull request. A branch with every comment resolved and a red build is precisely the one the user wants finished; it gets a worktree and an agent like any other. |
| "The gate is red — let me run `npm test` and see" | You never run the project's commands. That is the agent's work, inside its worktree; running them in the user's checkout uses the wrong tree and puts the output in the context you keep empty on purpose. |
| "The agent only repaired the build, I will still call the commit `CR`" | The message is whatever the agent reported in `commitMessage`. Renaming it in the summary describes a commit that is not in the branch. |
| "Nothing was committed, so I will clean up the worktree" | An uncommitted worktree holds work. Removing it destroys it; git refuses for the same reason. |
| "The agent is still running, I will summarise what it will probably find" | A result that has not arrived is not a result. Say it is still running. |
| "part-4 finished first, I will land it now" | A held part lands after its parent, through `restack.cjs`. Landed earlier, it sits on a parent that is about to change. |
| "A leftover fixpr-* folder blocks the branch, I will delete it" | `worktree.cjs add` clears a leftover that holds nothing of its own. One it keeps holds something - the error names it; the user decides. |
| "The user's checkout is on that branch, so it is out" | Not any more: it is fixed on `doh-fixpr/<branch>` and pushed to the pull request. Only unpushed local commits keep it out. |
| "I will write one script that rebases the whole stack" | `restack.cjs --action=stack` is that script (`/doh:restack`). A hand-made one that force-pushes was refused by the auto-mode classifier on 2026-11-06. |
| "restack.cjs stopped at a conflict, I will resolve it myself" | The conflict agent resolves it, in the worktree, with the gate after it. You hold paths and verdicts, never a file's content. |
| "I will read `fix-agent.md` and paste it into the prompt myself" | That is the file twice over, per branch, in the context you emptied of comment bodies to make room. Render it with the script and pass the path. |
