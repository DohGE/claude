---
name: restack
description: Use when the user wants a stack of pull requests (each based on another one's branch) moved onto its newest base, or a stack whose parts no longer sit on each other put back in line - takes one branch of the stack (the rest is read from GitHub) or the whole stack bottom-first, moves the bottom onto its base and every part onto the part below it, bottom-up, each in its own worktree with the project's gate after a move that changed code, merges append-only conflicts itself, hands real conflicts to a background conflict agent, and pushes every part with a lease; it never touches the user's checkout
argument-hint: "<branch>[;<branch>…] [--base=<branch>] [--no-onto-base] [--start=<part> --parent-old-tip=<sha>] [--dry-run] [--no-push] [--no-gate] [--project=<path>]"
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]
          timeout: 10
          once: true
---

# restack — move a stack of pull requests onto its newest base, bottom-up

You are the **orchestrator**. You never rebase, push, resolve a conflict or open a project file
yourself: `restack.cjs` moves the parts, and a background conflict agent resolves what the script
cannot. You hold only the script's JSON, paths and short summaries.

Why a skill: on 2026-11-06 "rebase all 5 branches" after a fixPr run took about 25 hand-made calls -
a worktree, a landing, a removal, a conflict brief and a resolve per part - and the one script
written to do it in a go was refused by the auto-mode classifier, since it force-pushed five
branches. This is that script, shipped and documented.

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

- The parts move bottom-up, one after another: a part moves only onto a parent that has already
  landed. Never two at once.
- Never run git's `rebase`, `reset` or `push` yourself, in the user's checkout or anywhere else.
  `restack.cjs` pushes with a lease pinned to where each branch stood before the climb; a push it
  reports rejected means somebody pushed meanwhile - report it, never force it.
- A conflict is the conflict agent's, in its worktree, with the gate after it. You never read the
  conflicting files.
- A worktree the script kept (a part that did not land) is never removed by you before the user
  has been told where it is and why.
- One part stopping stops the climb: the parts above it stay where they are (`waiting`).

## Step 1 — Parse the arguments

`SKILL_DIR` = this skill's base directory. `FIXPR` = `<SKILL_DIR>/../fixPr` (the scripts and the
conflict agent's brief live there). `PROJECT` = the current working directory, unless `--project=`.

Strip the flags first, wherever they sit:
- `--base=<branch>` → the bottom's base; without it, the bottom's pull request names it.
- `--no-onto-base` → `ONTO_BASE=no`: the bottom stays where it is; only the parts above it are
  put back on each other.
- `--resume` → the previous climb stopped at a part that has landed since (its conflict agent, or
  the user, pushed it): Step 3 with `--resume=yes`, Step 2 skipped.
- `--start=<part>` with `--parent-old-tip=<sha>` → start a climb at that part by hand.
- `--dry-run` → Step 2 only.
- `--no-push` → `PUSH=no`; `--no-gate` → `GATE=no` (say in the summary that nothing was built).

What remains is the stack, verbatim: one branch (the rest is read from GitHub) or the whole stack
bottom-first, split on `;` or `,`. Nothing → stop and say, in Polish, that the skill needs a branch
(`/doh:restack DPXN-1-part-2`).

## Step 2 — The plan

    node "<FIXPR>/scripts/restack.cjs" --action=plan --project="<PROJECT>" --stack="<stack>" [--base=<base>]

Tell the user, in Polish, the stack bottom-first with its base (`master ← part-1 ← part-2 ← …`),
the pull request number of each part (`prs`), which pairs already sit on each other (`ok`) and which
do not (`broken`), and every warning. A warning that commits are "already in" the base (a parent
squash-merged under the bottom) is expected: the climb moves only the commits after them. A stack
of one branch with no pull request → stop: the user
gives the stack and `--base` by hand. **`--dry-run` stops here.**

## Step 3 — The climb

Run (Bash, `run_in_background: true`):

    node "<FIXPR>/scripts/restack.cjs" --action=stack --project="<PROJECT>" --stack="<stack>" [--base=<base>] --onto-base=<yes|no> --checks-dir="<PROJECT>/.claude/doh/restack-checks" --push=<yes|no> --gate=<yes|no> --language=<language of this conversation> [--resume=yes | --start=<part> --parent-old-tip=<sha>]

Each part gets a worktree (`worktree.cjs`: a branch the user has checked out is moved on
`doh-fixpr/<branch>` and pushed to its pull request), is moved with `rebase --onto` - its own
commits only - and is checked by the project's gate when the move changed the code under it (a
gate already green on the same tree is reused). A bottom whose parent pull request was
squash-merged into the base moves off that parent's last commit, never replaying it (`squashed`).
Conflicts where both sides only appended (translation keys, enum members, exports) are merged by
the script and proved by that gate. The JSON:

- `stack`, `base`, `prs`; `resumedAfter` with `--resume=yes`;
- `parts[]`, one per part it reached, bottom-up: `branch`, `parent`, `status`, `commit` (new sha),
  `oldTip` (where it stood before), `rebased`, `pushed`, `gate` (verdict), `redSteps`,
  `conflictFiles` (the first 10), `conflictCount`, `oldParentTip`, `autoResolved`, `squashed`
  (`commits` of a squash-merged parent left out), `worktree` (kept only when it did not land),
  `agentPrompt` / `agentPromptErrors` (a conflict only), `warnings`, `errors`;
- `waiting[]` — the parts above a stop, untouched.

Act on the LAST part:

- every part `landed` → Step 5.
- `conflict` → Step 4.
- `gate-red` → stop. Name each red step with its `errorsPath`; the worktree stays for the user.
- `push-rejected` → stop. Somebody pushed to that branch during the climb; say so.
- `error` → stop with its `errors`.

## Step 4 — A conflict

The climb has already rendered the conflict agent's brief: the stopped part's `agentPrompt`. Never
render or assemble it yourself. `agentPrompt` null → stop and report its `agentPromptErrors`. Then
spawn it (Agent tool, `subagent_type: "general-purpose"`, background):

    Your complete instructions are in the file <agentPrompt>. Read it in full with the Read tool
    before doing anything else, then follow it exactly. It is already resolved: every path,
    branch and setting it names is final. You resolve the conflicts of moving branch <branch>
    (pull request #<number>) onto its landed parent <parent>, bring its gate green, push, and end
    with the single JSON object it specifies.

Wait for its notification; never predict it. It ends with one JSON object:

- `{"type":"result", …}` → Step 3 again with `--resume=yes` in place of `--start` and
  `--parent-old-tip`, nothing else changed: it takes the landed part's worktree down and climbs on
  above it from where that part stood before (`restack-state.json` in the checks folder). An answer
  with `resumedAfter` and no `parts` (the stopped part was the top) → Step 5.
- `{"type":"error", …}` whose report ends in a choice (A/B) → ask the user that question
  (AskUserQuestion, in Polish, the agent's options as the options), then send the answer to the
  same agent (SendMessage, to its id). It resumes from the rerere record of what it already
  settled and ends again with one JSON object.
- any other `error` → stop; report it with the worktree's path.

## Step 5 — Check and summary (Polish)

    node "<FIXPR>/scripts/restack.cjs" --action=plan --project="<PROJECT>" --stack="<stack>" [--base=<base>]

`broken` must be empty now; any pair in it goes into the summary with its `command`.

Then one summary, and nothing else:
- the stack, bottom-first, with its base;
- one row per part: the pull request, `oldTip` → `commit` (short shas), how it moved (not at all,
  rebased with no conflict, off a squash-merged parent - `squashed.commits` left out - conflicts
  merged by the script - `autoResolved` - or by the conflict agent, with its `resolvedFiles`), the
  gate verdict (reused when its warning says so), whether it was pushed;
- every part that did not land, with why, its worktree and what the user can do;
- `waiting` parts, left where they were;
- every branch moved on `doh-fixpr/<branch>` because the user had it checked out (a warning of its
  part): `git pull --rebase` in that checkout;
- every warning not reported yet.

Then stop. Do not offer to merge or to open a pull request.

## Skip rationalizations — all invalid

| Excuse | Reality |
|---|---|
| "One `git rebase --onto` per branch is quicker by hand" | It is what took 25 calls on 2026-11-06, and a hand-made force-push script is what the classifier refused. The script leases every push and gates every move. |
| "I will render the brief again / copy the conflicting files into it" | The climb rendered it from its own JSON (`agentPrompt`). On 2026-11-10 copying 29 paths by hand cost output tokens and invited a dropped one. |
| "I will take the worktree down and pass `--start` and the old tip myself" | `--resume=yes` does both from the state file, in one call, with no sha copied. |
| "The conflict looks small, I will fix it" | The conflict agent resolves it in the worktree, with the gate after it. You never read the file. |
| "part-3 failed, I will still move part-4 and part-5" | A part moves only onto a landed parent. The parts above a stop wait. |
| "The user's checkout is on a part, I will switch it" | Never touch the user's checkout. `worktree.cjs` moves that part on `doh-fixpr/<branch>`. |
| "A fixpr-* folder is in the way, I will delete it" | `worktree.cjs` clears a leftover that holds nothing of its own; one it keeps is named in its error, and the user decides. |
