---
name: fixPr
description: Use when the user wants one or more pull requests brought to a clean state - takes a list of branches separated by `;` or `,` like codeReview, fixes every UNRESOLVED review thread and the pull request conversation from the GitHub API AND every red command in the project's own lint/typecheck/unit-test/build gate, in a background sub-agent per branch inside its own git worktree, and lands one commit named after the pull request title, rebased onto the base - a stack of pull requests (each based on another one's branch) lands bottom-up, each part moved onto its landed parent; with --local=<ids> it fixes those findings of the branch's doh codeReview reports instead of the pull request comments
argument-hint: "<branch>[;<branch>…] [--local=<id>[,<id>…]] [--task=\"<change>\"] [--restack] [--resume[=<runPath>]] [--dry-run] [--no-push] [--no-reply] [--keep-worktree] [--project=<path>]"
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
The caveman plugin's own hooks, when installed, repeat these rules at another level (`full`): this block wins, at level ultra, and its boundaries below stand.
Never call the caveman skill to switch levels.

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
- Read and search files with Read, Grep and Glob, never with `cat`, `sed`, `head`, `grep`, `find` or `ls` in a shell: a shell call costs seconds before it runs.
  Send independent calls in one message, and shell commands that belong together in one call.
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
When you need the exact original - to quote it, count from it, match it or edit from it - call the headroom retrieve tool with that hash instead of guessing: `mcp__headroom__headroom_retrieve` (loaded by name through tool search when it is deferred); a bare `headroom_retrieve` in the tool list is not callable.
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
  A project whose `.claude/doh/checks.json` has `"static": true` in `steps` adds a `static checks`
  step: the code review's `decides` linter checks on the changed lines, red on any hit (README, "The gate").
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
  and every open part above a landed one moves after it (Step 5 point 4) - named or not. On
  2026-11-06 a run of part-1 and part-2 left part-3..5 sitting on the old part-2.
- Every step of a branch goes through its script - `fixpr-launch.cjs`, `restack.cjs`, `fixpr-after.cjs`,
  `ci-status.cjs`, `fixpr-summary.cjs` - each reading the run file (`--run=<runPath>`) and the agent's result file. You
  never copy a value, a sha or a verdict from one answer into another call by hand.
- Every `restack.cjs` call that acts on a target takes `--run=<runPath>` and the branch: the worktree,
  parent, tips and checks folder come from the run file. You never copy shas by hand.
- A run that stopped half way (the session died, the orchestrator was killed) goes on with
  `--resume` (Step 1b), never by hand. On 2026-11-18 a hand push after a crash skipped the
  `keep-base` check, and the bottom part conflicted with its base on GitHub.

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
   - `--resume` or `--resume=<runPath>` → `RESUME=yes` (with that run file, or the project's newest):
     go on with a run whose orchestrator stopped, from its files - Step 1b, instead of Steps 2-4.
     It takes no branch list; `--no-push`, `--no-reply`, `--keep-worktree` and `--project` still
     apply, `--dry-run` makes it name the steps only.
   - `--restack` → `RESTACK=yes`: before anything else, move the whole stack the named branches
     belong to onto the newest base, bottom-up (Step 2a). The fixes then land once, on code that is
     already current - on 2026-11-06 a fix run followed by "now rebase all 5" built every part four
     times and met every conflict twice.
3. Everything REMAINING is the branch list, verbatim. The collector splits it on `,` and `;`.
   No arguments at all (and no `--resume`) → stop and say, in Polish, that the skill needs at least
   one branch name (`/doh:fixPr feature/a;feature/b`). Never fall back to the current branch: a run
   that guesses its own target commits to a branch nobody named.

## Step 1b — Resume a stopped run (`--resume` only)

Everything a run needs to go on is on disk: the run file (`.claude/doh/fixpr-run-*.json`, with what
each launch, landing, push and `fixpr-after.cjs` kept on its target) and each agent's result file.
Run (Bash):

    node "<SKILL_DIR>/scripts/fixpr-resume.cjs" --project="<PROJECT>" [--run="<runPath>"] [--push=no] [--reply=no] [--keep-worktree=yes] [--language=<language>] [--worktrees=no]

(`--run` when the flag named a run file; `--push=no` with `--no-push`, `--reply=no` with
`--no-reply`, `--keep-worktree=yes` with `--keep-worktree`, `--worktrees=no` with `--dry-run`;
`--push` and `--language` otherwise come from the stopped run's launches.) It fetches, reads the
files and git, makes again the worktree a landing needs, and prints `runPath` and one entry per
target in `actions[]`: `action`, `reason`, `command`, sometimes `note` and `worktree`. Report each
target in Polish (`part-2: land - part-1 już wylądował`); `--dry-run` stops here. An `errors[]`
entry that names the main checkout's `node_modules` (lost by a removal, or found broken by a launch,
before the run stopped) → stop here: tell the user, in Polish, to run the install it names in their
checkout, then `--resume` again; run no command before that. Otherwise, in `actions` order, run each
`command` once, as the step it stands for:

- `spawn` - the agent never ended (no result file), or ended in error with work left in its
  worktree: the command is its launch (Step 3, its answer read as there; `--resume=yes` takes the
  worktree as it is), then spawn the agent as Step 4, with the `note` in the spawn prompt under a
  heading of its own. Its end is handled by Step 5.
- `land` - a held part whose parent has landed, or a commit made and never pushed that a worktree
  (or the local branch the worktree is made again from) still holds: background, and its `status`
  as Step 5 point 2. `land` checks that commit against its base or parent again - for a `rebase`
  target it moves onto a base that moved since, for a `keep-base` bottom (`--keep-base=yes`) only
  when it no longer merges - runs the gate on a move, and pushes with the lease. A part already in
  place answers `noop`.
- `push` - only for a commit no worktree or local branch holds any more (`land` moves HEAD, so it
  cannot carry it): `restack.cjs --action=push` with that commit and, once the commit rewrote the
  branch, the lease pinned to where origin stood when the run began. It checks no base: its
  `reason` says why `land` could not apply.
- `landing-agent` - a landing agent stopped in the middle of its rebase: the command renders its
  brief; spawn it as Step 5 point 2.
- `after`, `resolve` (`fixpr-after.cjs --resolve-only=yes`: the threads alone, again), `cascade` -
  background, the answer read as Step 5 point 4.
- `wait` - a held part whose parent has not landed: nothing yet. `manual` - report the reason in
  Polish; no script can act. `done` - nothing.

Once the commands of a pass have answered (agents still running go on in Step 5), run the script
again. A target whose action and reason come back unchanged after its command ran is not run
again: report it with the reason (a push the remote refuses, a token GitHub still rejects). Every target `done`, `manual` or waiting on a running agent
→ Step 5c and Step 6, with `--run` = `runPath`.

## Step 2a — Restack first (`--restack` only)

Without `--dry-run`, run (Bash, `run_in_background: true`) the `/doh:restack` climb:

    node "<SKILL_DIR>/scripts/restack.cjs" --action=stack --project="<PROJECT>" --stack="<arguments verbatim>" --checks-dir="<PROJECT>/.claude/doh/restack-checks" --push=<yes|no>

It runs the preflight first (as Step 2 describes it, without the token check's stop): a `preflight`
with `ok: false` → stop the run before anything moved, and report its `errors[]` in Polish with their
fixes. Otherwise handle its JSON exactly as `/doh:restack` Steps 3-4 say (`<SKILL_DIR>/../restack/SKILL.md`): a
part in `conflict` gets the conflict agent, and the climb resumes above it. Only when every part
`landed` (or was a `noop`: it already sat on its parent) go on to Step 2: the collector then reads
the moved branches and their new tips. A part that did not land → stop the run, report it in
Polish with its worktree, and say the fixes wait for it.

## Step 2 — Collect the open comments (one call, all branches)

Run (Bash tool):

    node "<SKILL_DIR>/scripts/pr-comments.cjs" --branches="<arguments verbatim>" --project="<PROJECT>" --push=<yes|no> [--dry-run=yes] [--local="<LOCAL>"] [--task="<TASK>"]

`--push=no` with `--no-push`, `--dry-run=yes` with `--dry-run`. Before it reads a comment it runs the
preflight (`preflight.cjs`): `origin` answers without a prompt, `user.name`/`user.email` are set, the
GitHub token works (a refused one falls through to the next token source), and the main checkout's
`node_modules` is complete. Its answer is `preflight` (`ok`, `checks`).

It also downloads the screenshots and recordings the comments hold (pr-media.cjs) next to the
comments file, a recording turned into still frames, and drops all but the newest copy of a bot
report repeated on every push. `counts.media` says how many attachments the agent gets; a
warning names any it could not fetch. A branch with open pull requests based on it that the run
does not name carries them in `stack.above` (bottom-first): they move after it in Step 5. A part
whose base is an open pull request the run does not name is held on it (`stack.parentOutsideRun`).
`stack.allAbove` lists every part above a target, in the run or not. `runPath` is the run file
every later script reads (`--run`). A read GitHub refused for a moment is retried in
the collector; a branch still dropped by an error stays a part of its stack (a warning says where).

With `--local` it reads no comment of the pull request: each target's `commentsPath` holds the
matched `findings[]`, the target carries `local: true` and `counts.findings`, and a warning names
every id no report of the named branches holds. A finding whose lines changed since its review
(the report's revision against the branch now) is marked `stale` (`counts.stale`, and a warning
naming the ids): its agent checks it still applies before it changes anything.

Parse the JSON from stdout:

- `preflight.ok` false → STOP the run here: no worktree, no agent. Report each `errors[]` entry (they
  start with `preflight <check>:`) in Polish, with its fix - every command in it verbatim - and tell the
  user to start the run again once it is fixed. On 2026-11-18 none of these was checked: origin was
  unreachable from Claude's process (Git Credential Manager), every launch only warned "Could not
  fetch", and the first push failed 25 minutes in. An unreachable origin stops a run that pushes, a
  missing identity any run that commits, a refused token a run that resolves threads, a missing or
  incomplete `node_modules` any run with a gate; under `--dry-run` all of them are warnings.
- Report every other `errors[]` entry to the user immediately, in Polish. Each one names the branch it
  belongs to and drops only that branch.
- Report every `warnings[]` entry, in Polish. A branch whose pull request has no open comments is a
  warning about SCOPE, not a failure: that branch still runs, for its gate alone. Say it that way.
  A warning several branches share comes once, naming them (`<branch>` stands for each one's name).
  `preflight token: GH_TOKEN was rejected; used git credential` → the run goes on with the working
  token; tell the user to unset or refresh the refused one.
  A warning that CI runs a test command the gate does not (`ciTestGap`) comes once per run: say
  that the agents' gate will not run those tests, and pass on its suggested
  `.claude/doh/checks.json`. The run goes on.
- `targets` empty → stop here, after reporting. Every branch was dropped by an error.

`targets` come bottom-first: every part of a stack after the part it is based on. `stacks[]` lists
each stack bottom-first (`["part-1", "part-2", …]`). Each target carries `branch`, `pr` (`number`,
`title`, `url`, `base`), `landing` (`rebase` | `keep-base` | `hold`), `stack` and `counts`; the
scripts below read the rest from the run file - you copy no value of it.

Tell the user, in Polish, what was found per branch — the pull request number and title, how many
threads are open, how many were already resolved and skipped, how many conversation comments and
review summaries there are — under `--local`, how many of the named findings each branch's reports
held and how many are `stale`. Name every stack bottom-first (`part-1 ← part-2 ← …`): its parts are
fixed side by side and land one after another. `candidates: 0` is reported as "no open comments;
this branch runs for its checks only", never as a skip.

**`--dry-run` stops here**, after that listing. It stays comment-only on purpose: reporting on the
gate would need a worktree and a dependency install, which is exactly what `--dry-run` exists not to
do. Say so if the user expected the checks in it.

### Step 2b — What the stack's split left out (a stack of two parts or more)

    node "<SKILL_DIR>/scripts/stack-preflight.cjs" --run="<runPath>"

From git alone, in seconds: each part's changed files, their relative and tsconfig-alias imports,
and every import of a file only a later part adds. It writes each target's `leaks` (its own) and
`restore` (its own and those of the parts below its tree still lacks) into the run file; the
launch hands `restore` to the agent, which brings those files back verbatim from that later part
first, so every part restores the same copy. On 2026-11-16 four agents found such a red gate one by
one and copied the files on their own, two of them differently. Report each target's `restore` in
Polish (`part-2: 3 pliki z part-5 - agent przywróci je przed poprawkami`). `errors[]` → report them;
the run goes on, and the agents meet the red gate themselves.

## Step 3 — Launch each branch: worktree and brief

Start every target's launch in the background (Bash, `run_in_background: true`), one call each, in
`targets` order (the bottom of a stack first), without waiting for any of them:

    node "<SKILL_DIR>/scripts/fixpr-launch.cjs" --run="<runPath>" --branch="<branch>" --push=<yes|no> --language=<language>

A launch in the foreground blocks every launch after it: on 2026-11-18 one part's install ran past
the 600 s tool timeout and held the launches of the three parts above it. The launches run side by
side (worktree.cjs takes a repository lock for its git steps). Spawn each target's agent (Step 4)
when its launch's completion notification arrives - the JSON below is the last line of that
launch's output file - and only once every target before it in `targets` is spawned or out of the
run: a launch that finishes
early waits for the ones below it, so the spawns keep the bottom-first order. Never spawn an agent
before its own launch has finished, and never wait for every launch before the first spawn: on
2026-11-03 five worktrees made one after another held the first agent back nineteen minutes.

`--push=no` when `--no-push` was passed; `<language>` is the language THIS conversation is held in,
named plainly (`Polish`, `English`, …). It makes the worktree (worktree.cjs) and renders the brief
(`promptPath`) and the two files the agent reads at one step only (`visualBrief`, `landBrief`) from
the run file and the worktree's answer; every value also goes to `varsPath`, which the agent's
workers' briefs are rendered from. Parse its JSON:

- `errors[]` non-empty → that branch is OUT of the run: report the error in Polish and move to the
  next target. The errors are deliberate refusals of worktree.cjs, each with the fix in its text,
  and none of them is something to work around: the branch is checked out somewhere AND holds
  commits origin does not have; it has no `origin/<branch>`; it has diverged from `origin/<branch>`;
  a folder is in the way that holds something of its own (a registered worktree, a `.git`, a link,
  a file the branch does not have). A placeholder error names a template - report it as a plugin
  defect.
- `heldBy` → the branch is checked out by the user; it is worked on `doh-fixpr/<branch>` and pushed
  to `origin/<branch>`. The summary tells the user to `git pull --rebase` in that checkout.
- `mainBroken: true` → the main checkout has no `node_modules`, or it misses packages its
  `package.json` declares, so no worktree can link it or have a gate. No worktree installs in its
  place: an install next to (or through) a link to that folder is what emptied it on 2026-11-18.
  STOP the run: spawn no further agent, wait for the launches still running, remove every worktree
  whose agent was not spawned
  (`node "<SKILL_DIR>/scripts/worktree.cjs" --action=remove --branch="<branch>" --project="<PROJECT>"`),
  and tell the user, in Polish, to run the install the warning names (`npm ci`, or their package
  manager's) in their checkout and start the run again. The preflight (Step 2) already stops a run
  on the same check; this catches a `node_modules` lost after it.
- `linked: false` with a warning "node_modules was installed, not linked …" → the worktree
  installed instead of linking, and the warning says why; report it. An install that failed or was
  stopped at its time limit is a warning too: that agent skips its gate.
- `visual: true` for the first time this run → start, in the background (Bash, `run_in_background: true`),
  once: `node "<SKILL_DIR>/../implementNewFeature/scripts/ensure-playwright.cjs"`. The agents' look
  at the running app needs it; on 2026-11-16 an agent installed it in the middle of its run.
  A run where no target has `visual` gets no visual check: say once, in the summary, that a
  `"visual"` key in `.claude/doh/checks.json` lets the agents look at their template fixes.
- Report the other `warnings[]` — a leftover folder removed, an install that failed (that agent
  skips its gate), the `.env*` files copied in. "Could not fetch origin/<branch> (<git's first
  line>)" should not come after a passed preflight; when it does, report that reason - the network or
  the credential store changed since - and note that the worktree starts from the refs already
  fetched, so its push may be refused.

A worktree whose lockfile is the main checkout's gets that checkout's `node_modules` linked in
instead of an install, and only `worktree.cjs --action=remove` (fixpr-after.cjs calls it) takes such
a worktree down: it unlinks first, where git's own recursive delete walks into the linked folder.
You never delete a folder yourself, never run an install in a worktree (through the link it
empties the main checkout's packages), never pass `--force` to git, and never re-run a launch
hoping for a different answer. What an install rewrote in tracked files (husky's helpers) is put
back by worktree.cjs itself; never `git checkout` it by hand.

## Step 4 — One background agent per branch

When its launch's notification has arrived (Step 3, in `targets` order): Agent tool,
`subagent_type: "general-purpose"`, background. The prompt is short and points at the rendered
brief — it never repeats it:

    Your complete instructions are in the file <promptPath>. Read it in full with the Read tool
    before doing anything else, then follow it exactly. It is already resolved: every path,
    branch and setting it names is final. You fix the open review comments of pull request
    #<pr.number> on branch <branch> and bring its lint/typecheck/test/build gate green, and you
    end with the single JSON object it specifies.

Anything this particular run has to add — a note about a previous failure, something the user said
after the fact — goes in that spawn prompt, under its own heading, after the pointer. It never goes
into the rendered file. Spawn every agent as its launch lands, before you wait for any agent: every
fix agent opens with the same system prompt and tool definitions, and the first one, alone in its
message, writes that prefix into the prompt cache for the others.

Then wait for the completion notifications and handle each branch as it lands. Never predict a
result that has not arrived, and never summarise a branch whose agent is still running — if the user
asks in the meantime, say it is still working.

Each agent ends with one short JSON object: `{"type":"result","committed","pushed","held","commit",
"commitMessage","counts","stackImpact","resultPath"}` or `{"type":"error","report","resultPath"}`;
everything else is in its `resultPath` file, which the scripts read. The plugin's SubagentStop hook
(`agent-stop.cjs`) sends a final message with prose in it, or a turn ended while the agent's own gate
still ran, back to the agent once. An agent that still finishes with NO parsable JSON counts as
`{"type":"error"}`: nothing is resolved, the worktree is kept.

**What a fix changes for the parts above it** (`stackImpact` above 0): nothing to do now. The
parts above cannot adapt before they sit on this one - three agents of 2026-11-16 answered exactly
that, and the message cut into a running gate. restack.cjs gathers every landed part's
`stackImpact` for each part it lands (`PARENT_CHANGES` in the landing agent's brief).

## Step 5 — Land each branch

A stack lands bottom-up; a branch outside any stack lands when its agent ends.

1. **A target whose agent ended with `result` and whose landing is its own** (`rebase`, `keep-base`):
   run, in the background (Bash, `run_in_background: true`):

       node "<SKILL_DIR>/scripts/fixpr-after.cjs" --run="<runPath>" --branch="<branch>" --land-next=yes --push=<yes|no> [--reply=no] [--keep-worktree=yes]

   (`--reply=no` with `--no-reply`, `--keep-worktree=yes` with `--keep-worktree`). It closes the
   threads the agent fixed once the fix is pushed (with a reply naming the commit; only the threads
   whose files the commit changes), checks every comment against the agent's verdicts (verify-fix.cjs,
   against GitHub when pushed), stops the app its visual check left running, takes the worktree
   down (kept when it holds uncommitted work or the agent ended in error), records all of it in the
   run file - and moves the next held part of the stack onto it (`next`), when that part's agent
   has ended. A `--local` target closes no thread.
2. **A held part** lands only after its parent: its landing comes as the parent's `next`, or - when
   its own agent ended after the parent had landed (`next: { waiting: true }`) - from
   (background):

       node "<SKILL_DIR>/scripts/restack.cjs" --action=land --run="<runPath>" --branch="<branch>" --push=<yes|no> --summary=yes [--pending-steps=build]

   (`--pending-steps=build` when its agent committed: the held agent built nothing.) It moves the
   part's own commits onto the landed parent, runs the gate when the move changed the code under
   it, and pushes with a lease pinned to `remoteTipAtStart`. Act on its `status`:
   - `landed` → `fixpr-after.cjs` as in point 1, with `--commit=<commit> --pushed=<yes|no>` of the landing.
   - `noop` → nothing moved: the part already sat on its parent and origin had it, so its agent
     committed nothing. `fixpr-after.cjs` as in point 1 with `--pushed=no` and no `--commit`.
   - `conflict`, or `gate-red` with `briefVars` (`mode: adapt` - the move went through and the gate
     is red on code the parts below changed) → the landing agent. Render its brief next to the fix
     agent's (`<promptPath>` with `-restack` before `.md`):

         node "<SKILL_DIR>/../../scripts/render-agent-prompt.cjs" --template="<SKILL_DIR>/references/restack-agent.md" --out="<restack prompt path>" --vars="<briefVars>" --set=PR_NUMBER=<pr.number> --set=PR_URL=<pr.url> --set=LANGUAGE=<language>

     `briefVars` already holds the worktree, parent, old tip, lease, files, mode, the changes of
     every landed part below that this part still uses (`PARENT_CHANGES`), the parent's landed diff
     cut to the conflicting files - or the files and names of the red step's errors - and those names
     (`PARENT_DIFF`), and the whole diff as a file the agent greps only when it must
     (`PARENT_DIFF_FULL`); never copy those into `--set=` flags yourself. Spawn it like a fix agent
     (Step 4, pointing at that file). Its `result` → `fixpr-after.cjs` with its `commit` and
     `pushed`; its `error` → like an agent's error. An `error` that ends in a choice (A/B) is a
     question for the user: ask it (AskUserQuestion), then send the answer to that same agent
     (SendMessage) - it resumes with the rerere record of the files it already settled.
   - `gate-red` without `briefVars`, `push-rejected`, `error` → like an agent's `{"type":"error"}`:
     nothing resolved, the worktree kept; name the red steps (`redSteps[].errorsPath`) or the refusal.
     An `error` that names a missing `user.name`/`user.email` (git cannot write the moved commits)
     or an old tip the part is not built on is the user's to fix: report it as written, never as a conflict.
   The parts above it wait for this one, whatever the outcome: a part that did not land leaves
   `origin/<branch>` where it was, and its children move onto that.
3. **An agent that ended with `error`**: `fixpr-after.cjs --run="<runPath>" --branch="<branch>" --keep-worktree=yes`
   - it records the outcome and checks the comments; nothing is resolved, removed or landed above it.
4. Read each `fixpr-after.cjs` answer: `verify.ok` false or `resolve.failed`/`unverified` go into the
   summary (the script prints them). `resolve.failed` and `resolve.replyFailed` hold one
   `{ error, count, ids }` per distinct error: report each error once, with its count; `keptWorktree`
   names a worktree left for the user. A resolve that failed for the token (a 401 on every thread)
   is run again, alone, once the token is fixed:
   `node "<SKILL_DIR>/scripts/fixpr-after.cjs" --run="<runPath>" --branch="<branch>" --resolve-only=yes` -
   it skips the threads already closed, posts no second reply, and works with the worktree gone. An
   `errors[]` entry "The main checkout's node_modules disappeared while removing …" (or "went from
   N to M entries") → tell the user at once, in Polish, that their checkout's `node_modules` is gone
   and that they must run the install it names there; launch no further target and land no further
   part until they have (every later worktree would install instead of linking); fixpr-after.cjs
   already held the next part's landing (`next.held`), and `--resume` names it again later. The same entry
   in a `restack.cjs` answer's `errors[]` stops its climb: the parts above wait. A
   `cascade` entry means open parts above that the run does not name sit on the old commit: move
   them, bottom-up, with no agent (background):

       node "<SKILL_DIR>/scripts/restack.cjs" --action=cascade --project="<PROJECT>" --stack="<cascade.stack>" --from="<cascade.from>" --from-old-tip="<cascade.fromOldTip>" --checks-dir="<checksDir>/cascade" --push=<yes|no>

   Append-only and import-only conflicts merge in the script and the gate proves them; a part with
   `status: noop` moved nothing and the climb went on above it; a `--from-old-tip` the part above
   is not built on is refused before any worktree (`errors`); a part with
   `status: conflict` gets the landing agent as in point 2 (its brief from that part's `briefVars`,
   or rendered by hand with `--set=` for a part outside the run), and the cascade runs again
   `--from` that part with `--from-old-tip` = its `oldTip`.

## Step 5b — What CI says (once, after every branch has landed; not with `--no-push`)

Start, in the background (Bash, `run_in_background: true`), once every branch has landed or stopped
and at least one pushed:

    node "<SKILL_DIR>/scripts/ci-status.cjs" --run="<runPath>" --timeout-min=15

It reads the commit statuses and check runs of each pushed commit through the GitHub API, waits
until none is pending - never past `--timeout-min` - and for a red Jenkins build reads
`<build>/consoleText` (when it needs no login) for the decisive lines: TypeScript errors,
`FAIL <spec>`, the `Tests:` / `Test Suites:` totals, `ERROR:`. Each branch's answer goes to
`<checksDir>/ci-status.json`, rewritten every round. Do Step 5c meanwhile; run Step 6 when it ends.
On 2026-11-18 Jenkins failed four of seven parts after seven green gates, and nobody looked until
the user did. A red CI is reported, never repaired in this run: the user decides on a new
`/doh:fixPr` of that branch, whose agent gets the red lines from the summary.

## Step 5c — Keep what the comments taught (once, after every branch has landed)

Skip this step under `--local`: every finding there comes from the review's own rules, and the 31
lessons offered after such a run on 2026-11-16 were refused, every one. Otherwise, when any result
file carries `lessons`:

    node "<SKILL_DIR>/../codeReview/scripts/pr-lessons.cjs" --action=list --project="<PROJECT>" --from="<each target's reportPath>.result.json,…"

Show the user, in Polish, every candidate numbered (its rule, group and source), the ones the
project's rules already hold or another candidate words differently (`known`: a file, or `#<n>`)
marked, and ask (AskUserQuestion): add all new ones / only the numbers I give / none. Then:

    node "<SKILL_DIR>/../codeReview/scripts/pr-lessons.cjs" --action=add --project="<PROJECT>" --from="<the same files>" [--pick=<numbers>]

It writes `.claude/doh/local/pr-lessons-<group>.md`, a project rule file codeReview loads; name the
files in the summary. Never add one the user did not choose.

## Step 6 — Terminal summary (Polish)

After every branch has landed (or stopped):

    node "<SKILL_DIR>/scripts/fixpr-summary.cjs" --run="<runPath>"

It prints the summary from the run file and the result files: first, when the main checkout's
`node_modules` was lost during a removal or found broken by a launch, that section, with the install
to run; then one row per pull request (commit, landing - `noop` reads "bez zmian" -, push, fixed /
rejected / without action), every rejected comment with its ground (the
part the user acts on), what was answered, the `--local` findings not fixed, the comment and thread
check per branch (each resolve or reply error once, with its count; a `--resolve-only` run again
with its final state), the self-review's report and counts, every `stackImpact` (one line per
name, parts as ranges, paths cut to their distinct tail), the files nobody looked
at (`uiUnverified`), the visual checks, the gate per branch with every still-red step's log and
every branch committed on `green-no-tests` (no unit test ran: never call it green), what CI said
per pushed branch (Step 5b: green, red with its decisive lines, or still running), every
stack bottom-first with each pair that does not sit on its parent (restack.cjs verify) and its
command, the checkouts to `git pull --rebase`, and every commit a re-spawned agent built on
(`priorCommits`). Your final message is that text as it is,
followed only by what no file holds: errors and warnings of Steps 1-5 not reported yet, the lessons
added in 5c with their files, the cascade's rows, and the note on a missing `visual` key.

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
| "A launch is usually quick, I will run it in the foreground" | An install can take ten minutes; in the foreground it hits the 600 s tool timeout and holds every launch after it (2026-11-18). Background, always; spawn on its notification. |
| "The worktree's gate needs a package, I will `npm ci` there" | Through the linked `node_modules` an install empties the main checkout's packages. The package is missing in the main checkout: the user installs there. |
| "The user's checkout is on that branch, so it is out" | Not any more: it is fixed on `doh-fixpr/<branch>` and pushed to the pull request. Only unpushed local commits keep it out. |
| "I will write one script that rebases the whole stack" | `restack.cjs --action=stack` is that script (`/doh:restack`). A hand-made one that force-pushes was refused by the auto-mode classifier on 2026-11-06. |
| "restack.cjs stopped at a conflict, I will resolve it myself" | The conflict agent resolves it, in the worktree, with the gate after it. You hold paths and verdicts, never a file's content. |
| "I will read `fix-agent.md` and paste it into the prompt myself" | That is the file twice over, per branch, in the context you emptied of comment bodies to make room. Render it with the script and pass the path. |
| "I will render the brief with my own --set list, it is only 22 flags" | `fixpr-launch.cjs` reads every value from the run file. A hand-built list is 1.5k characters a call and one dropped value away from a refused render (2026-11-16). |
| "part-1 removed a name part-3 uses - I will SendMessage part-3 now" | A held part cannot adapt before it sits on the new parent; three agents said so on 2026-11-16, and the message cut into a running gate. restack.cjs gives the landing agent every such change (`PARENT_CHANGES`). |
| "The move went through but the gate is red - that is an error for the user" | A `gate-red` with `briefVars` is the landing agent's work in `adapt` mode: this part's code following what the parts below changed. |
| "The preflight only failed on origin - the push is half an hour away, I will start the agents" | The push then fails half an hour in, after every agent's work (2026-11-18). The fix is one command the user runs now; the run starts again in a minute. |
| "The session died mid-run; I will push the commits and close the threads by hand" | `--resume` reads every state from the run file and names each step with its command: the `keep-base` check, the lease and the thread step the hand push of 2026-11-18 skipped. |
| "The resumed commit only needs its push - `land` is overkill" | An unpushed commit goes through `land` wherever a worktree holds it: its base may have moved since, and only `land` checks that before the lease push. `push` is for a commit nothing checks out any more. |
| "I will write the summary myself, I have every reply" | `fixpr-summary.cjs` prints it from the files, rejected grounds and files to look at included; your final message is its text plus what no file holds. |
