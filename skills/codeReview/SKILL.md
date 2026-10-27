---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, a list of branches, or every file under a folder) - checks every changed file against the instruction checklist of its file kind and writes one concise Polish report per branch (interactive HTML by default, Markdown with --only-md; the walked checklists stay in it only with --with-checklist; --light skips the rules of severity low and leaves Low findings and code snippets out) with severity, real line numbers, violated rule and expected result
argument-hint: "[staged | folder <path> | <branch>[,<branch>…]] [--only-md] [--light] [--with-checklist] [--with-rule-text] [--since-last] [--no-batch] [--no-windows] [--no-dedup-items] [--walker-model=<model>] [--walker-effort=<low|medium|high|xhigh|max>] [--parallel=<n>] [--project=<path>]"
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]
          timeout: 10
          once: true
---

# codeReview — deterministic instruction-driven review

You produce review REPORTS only: never fix code, commit, checkout or edit the reviewed project's
files. Staged mode is the single exception — its context script runs `git add .` to stage every
pending change before reviewing, the index only.

Execute every step in the current conversation; the targets this conversation walks itself, one
after another. Two things you may hand to sub-agents, both to `doh:codereview-walker` with the brief
the script wrote: the walk of a window of files and the cross-file pass (Step 3, Windows) — through
ONE Workflow run for every target with windows when this session has the tool (these instructions
are the opt-in it asks for), else the Agent tool — so that no conversation grows until it is
compacted and this one hears from the walk once.
Never dispatch any other sub-agent (Agent/Task/Explore) for any part of a run: not per branch, not per
file, not for a large diff, not to save time.

Coverage is non-negotiable: every file of every target, every checklist item of every applicable
instruction, on every run — violating the letter of these steps violates their spirit. Coverage and
reporting scope differ: everything is evaluated, only what the diff touched is reported (the
scope gate of `references/walk.md`).

**Run order.** This file is not in run order: what the walk of every file needs comes first, because a compaction of the session re-attaches only the head of this file.
1. Steps 1–2 run once per run, before anything else, and stand at the end of this file, after the one-time marker.
2. Step 3 has each target's files walked and every file's part written in the Step 4 format: right after Step 1 the summary's one `workflow` starts the windows of every target that has some, in the background; then this conversation walks each target without windows by the rules of `references/walk.md`.
3. The cross-file pass follows the last file: the workflow's fresh walker for a windowed target; this conversation for a target with `crossInline` (its last bundle says so); else a fresh `doh:codereview-walker` with `target.crossBriefPath`.
4. The assembly, then the next target, and after the last target Step 5: `references/assembly.md`, which the cross-file reference names.

After a compaction, this skill's hook names where the run stands and what to read again: continue from there, and never write a finished part anew.

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

## Step 3 — Have each target walked (per target)

The rules of the walk itself — the scope, mechanical-change and behaviour-preserving gates, the points every file goes through, the part format (Step 4), the invalid rationalizations and the rulebook's addresses and plans — are in `references/walk.md` in this skill's directory, and in the system prompt of every `doh:codereview-walker`.
Read that file (Step 2) only when this conversation walks a file or makes the cross-file pass itself: a target whose windows and cross-file pass go to walkers never needs it here.

The context script has already written each target's report header to `target.reportPath` (the Step 4 header, the skipped-files line and the since-last note), and removed the parts a run of the same second left behind.
A target WITH `target.resume` continues a run that was interrupted before its assembly; the script has already checked that the target still holds the content that run reviewed, pointed `reportPath` at that run's report and kept its parts.
Every file listed in `resume.doneFiles` is finished — its part, checklist block and coverage marker are on disk — and every other file is walked with the part number it has by its position in `target.files` (a part without a coverage marker is overwritten).
`resume.drafts`, when present, lists the drafts of parts the interrupted run had written and the check had refused: such a target has no windows, and this conversation walks it (Step 2 first), promoting each draft when its file's turn comes (`references/walk.md`, Coverage).
The cross-file pass and the closing parts are always written anew.
A target with an empty diff (`files` empty) has no per-file parts and no cross-file pass: write its `part01` with the single line `Nie wykryto zmian do analizy.`, then the assembly (`references/assembly.md`).

**Windows.** `target.windows` (a FIXED IDENTIFIER, like every key of the context JSON) cuts the files into runs of whole batches, `{ files: [first, last], brief, lastPart, model, effort }` each (`model` and `effort` only when set), sized so that one conversation walks a window without being compacted: a compaction drops every bundle read before it, and a conversation that keeps growing re-reads all of it with every response.
A window made only of files whose kind declares a `walker` setting — the models kinds (enums, interfaces, types, constants, model barrels) — carries that setting (`sonnet`, `medium`); every other window carries `--walker-model` / `--walker-effort`, or nothing, which is "inherit".
The windows are independent: each walker writes the parts of its own files, in order, and the part check asks each part only for the parts before it in its window.
A target has no windows (the summary's `windows` is 0) when it is small enough to walk here, under `--no-windows` (Step 1) and for a resume with `resume.drafts`: walk it yourself — Step 2, then `target.start`, whose Reads open the first batch, in ONE message.
With windows you do not walk the files yourself. Take the first way this session has:
1. **The Workflow tool.** Right after Step 1, before you walk any target yourself, call `Workflow` ONCE with `scriptPath` and `args` exactly as the summary's `workflow` gives them: one run for every target with windows, its script copied into the run folder — this skill's instructions are the opt-in the tool asks for, so do not ask the user again.
   The workflow walks `args.lanes` windows at once over all its targets, starts a stopped walker once more (it skips every part on disk), sends each target's cross-file pass to a fresh walker as soon as that target's windows are done, and notifies you once, with `{ targets: [{ dir, windows, failed, cross }] }` (`dir` is the target's `workDir`).
   Then walk the targets without windows here and assemble each; end your turn once only the workflow is left.
   When the notification arrives, per target: `failed` empty and `cross` is `CROSS DONE` → the assembly (`references/assembly.md`); a window in `failed` → walk it yourself (Step 2 first) from its first file without a part — each bundle's `## Dalej` names what you read next — then the cross-file pass below; any other `cross` → the cross-file pass below.
2. **The Agent tool.** Read the target's `windows` from the context file (the summary counts them) and dispatch them in order, up to `target.parallel` at once — one message with that many calls: `Agent(subagent_type: "doh:codereview-walker", description: "window <k>/<n>", model: <window.model>, effort: <window.effort>, prompt: "Read <window.brief> and follow it.")`, leaving out `model` and `effort` when the window has none.
   An Agent tool without an `effort` parameter gets one more prompt line instead: `medium` → `Effort: medium — think before each non-trivial decision.`, `high` → `Effort: high — think hard before each non-trivial decision.`, `xhigh` and `max` → `Effort: max — ultrathink before each non-trivial decision.` (`think`, `think hard`, `ultrathink` are FIXED IDENTIFIERS, English verbatim); `low` adds nothing.
   A walker's reply is the one line `WINDOW DONE <first>-<last>` or `WINDOW STOPPED <file>: <reason>` (FIXED IDENTIFIERS).
   Walkers run in the background, so do NOT end your turn to wait for them: run (Bash tool) `node "<SKILL_DIR>/scripts/wait-part.cjs" --path="<lastPart>"`, the option repeated for every window still running; it waits under four minutes and prints one line per path, `PART_READY <path>` or `PART_PENDING <path>` (FIXED IDENTIFIERS), as soon as one of them is on disk.
   A `PART_READY` window is done: dispatch the next window in its place, in the same turn, and wait again; its `WINDOW DONE` line, when it arrives later, needs nothing.
   Every path `PART_PENDING` → run the same command again, up to six times in a row; after that end your turn and act on the walkers' replies when they arrive.
   A turn ended while a walker runs is paid twice: whoever spawned this session is woken for nothing, and this conversation's context is re-read in full once its cache has expired.
   Any other reply, or a refused dispatch, means that window is NOT done: walk it yourself (Step 2 first) from its first file without a part, then go on with the others.
3. **No sub-agent at all.** Pass `--no-windows` in Step 1 instead.

**The cross-file pass** follows the last file part of the target, every window done.
Under the Workflow tool it already ran.
Otherwise it goes to a fresh walker like a window: `Agent(subagent_type: "doh:codereview-walker", description: "cross-file", model: <walker.model>, effort: <walker.effort>, prompt: "Read <target.crossBriefPath> and follow it.")`, then `wait-part.cjs --path="<part N+1>"` (`N` = `target.files.length`) as above; its reply is `CROSS DONE` or `CROSS STOPPED: <reason>` (FIXED IDENTIFIERS).
A walk that ends in this conversation dispatches it the same way, in the message that writes the last part (the last bundle's `## Dalej` says so): a fresh conversation makes the pass better than the tail of a long walk.
A target with `crossInline` (four files or fewer, walked here) is no long walk: make its pass here, with the Reads its last bundle's `## Dalej` names in the message that writes the last part.
Without the Agent tool, or when the agent stopped, make the pass yourself: `references/cross-file.md`, read with `target.crossBundlePath` (Step 2 first).
Then the assembly: `references/assembly.md` in this skill's directory.

You are a walker when your prompt names a brief: follow the brief and the rules of your system prompt — nothing of this step is yours.

<!-- one-time:start -->
Steps 1–2 run once per run, before Step 3.
After a compaction, the hook names what of them to read again.

## Step 1 — Build the review context

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = the current working
   directory, unless `--project=` overrides it (point 2).
2. Strip the flags FIRST, from the whole argument list, wherever they sit — an unstripped flag would
   be mapped below as a branch name:
   - `--only-md` → `OUTPUT=md`; otherwise `OUTPUT=html`.
   - `--with-checklist` → pass it through to the context script (`target.withChecklist`).
     The finished report then keeps every file's walked checklist and coverage marker (the HTML page's "Pokrycie checklist" section); without it the report carries the findings only.
     The review itself is the same either way: every part is still written with its checklist and checked (Step 3).
   - `--with-rule-text` → pass it through to the context script (`target.withRuleText`); it implies `--with-checklist`.
     The renderer adds the full text of its rule to every checklist item of the finished report; the parts are written exactly as without it.
   - `--light` → pass it through to the context script (`target.light`).
     Every checklist leaves out the items whose fixed severity is low (the item's own `severity`, else its instruction's), so the review walks every other rule.
     The renderer cuts every ⚪ **Low** finding from the finished report, and the HTML page shows no code snippet.
   - `--no-batch` → pass it through to the context script: every file is walked alone, its part in a message of its own (`target.batches` stays empty).
   - `--no-windows` → pass it through to the context script: `target.windows` stays empty and this conversation walks every file.
     Pass it only when this session cannot dispatch a sub-agent (it has no Agent tool), e.g. when it is itself a sub-agent.
   - `--no-dedup-items` → pass it through to the context script: every bundle shows every item in full.
     Without it `target.dedupItems` is true, and an item an earlier bundle of the run already showed is shown again only by reference (`references/walk.md` Step 3 point 1).
   - `--walker-model=<model>` → pass it through to the context script (`walker.model`): the `model` every window walker and the cross-file agent are spawned with (Step 3, Windows), e.g. `sonnet`.
     Without it they inherit this session's model. A window made only of files whose kind declares a `walker` setting (the models kinds: `sonnet`, effort `medium`) is spawned with that one instead.
   - `--walker-effort=<low|medium|high|xhigh|max>` → pass it through to the context script (`walker.effort`): the `effort` every walker is spawned with (Step 3, Windows).
     Without it they inherit this session's.
   - `--parallel=<n>` → pass it through to the context script (`workflow.args.lanes`, `target.parallel`): how many windows are walked at once over all targets, 1-6 (default 4).
   - `--project=<path>` → `PROJECT=<path>`. Everything is relative to it: which repository is read
     and — in staged mode — staged, where the reports land, and which `CLAUDE.md` and
     `.claude/doh/instructions/` bind. A caller whose work lives somewhere other than the current
     directory — a git worktree, e.g. a parallel implementNewFeature task — MUST pass it, or the
     review silently stages and reviews the main checkout instead of that caller's tree.
   - `--since-last` → pass it through to the context script (`INCREMENTAL`). It reviews only the
     files whose content moved since the previous review of that target, using the snapshot the
     script keeps in the branch's `cache/` folder. Meant for a RE-review of a target already reviewed (the
     implementNewFeature review step uses it for its second pass); on a first review it warns and
     reviews everything.
     The snapshot is written when the CONTEXT is built, before any file is analyzed — so it records
     what the previous run was going to review, not what it finished. After a review that died
     mid-way, `--since-last` therefore skips files nobody ever looked at, and an untouched tree comes
     back as "nothing to review". Re-review such a target in FULL (drop the flag) rather than trusting
     an empty incremental result.
3. Map the REMAINING arguments to the context script EXACTLY like this:
   - no arguments → `--mode=auto`
   - the single word `staged` → `--mode=staged` (the script first runs `git add .`, so the review
     covers every pending change — working-tree edits and untracked files staged as one set)
   - the word `folder` followed by one path → `--mode=folder --path="<path>"` (reviews every
     file currently in that folder of the working tree, no diff needed). The path must resolve
     INSIDE `PROJECT`; the script refuses one that climbs out of it and points you at `--project`
     instead, which is how you review a folder of another repository.
   - anything else → `--mode=branches --branches="<arguments verbatim>"` (the script splits on `,` and `;`)
4. Run (Bash tool): `node "<SKILL_DIR>/scripts/review-context.cjs" --mode=<mode> [--branches="..."] [--path="..."] --output=<OUTPUT> --project="<PROJECT>" [--since-last] [--with-checklist] [--with-rule-text] [--light] [--no-batch] [--no-dedup-items] [--walker-model=<model>] [--walker-effort=<effort>] [--parallel=<n>]`
   `--branches` goes with `--mode=branches` and `--path` with `--mode=folder` — folder mode fails
   with `No folder given` if the path is left off this line.
5. Parse the JSON from stdout — the part of the context the review uses:
   - Report every `errors[]` entry to the user immediately, in Polish.
   - No targets / exit code 1 → stop after reporting the errors.
   - Report every top-level `warnings[]` entry, in Polish.
   - The file at `contextPath` IS the context every later step calls "the context JSON"; the scripts
     and hooks read it. Its keys you use — `rulebookNotesPath`, `claudeMd`, `walker`, `workflow` (the one
     call for every target with windows, null when none has any), and per target `files` and `windows`
     (counts), `parallel`, `start` (a target walked here), `crossInline`, `snapshotDir`, `commands.assemble`,
     `reportPath`, `htmlReportPath`, `workDir`, `crossBundlePath`, `crossBriefPath`, `baseBranch`,
     `baseSource`, `prNumber`, `resume`, `skipped` (a count) — are in this summary: do not Read the file, whose
     60–75 kB would stay in your context until the first compaction. Read it (Read tool, never
     `cat`) only for a key the summary lacks (`instructionsCatalog`, `checklistPlans`, a target's list of
     `files` or of `windows`).
     `targets[].resumed` true means the target continues an interrupted run (Step 3).

## Step 2 — Load the rulebook (before you walk a file yourself)

A run whose every file goes to window walkers and whose cross-file pass goes to a walker skips this step: each walker reads what it needs.
Before this conversation walks a file itself — no windows, a window that failed, a resume with drafts — or makes the cross-file pass itself, read, as parallel calls in ONE message:
1. `references/walk.md` in this skill's directory: the walk, the part format and the rulebook's addresses and plans.
2. `rulebookNotesPath`: what binds a WHOLE instruction of this run — the preamble of every instruction at least one reviewed file walks. The items themselves reach you in each file's bundle.
3. `claudeMd`, when it is not null: one more rulebook, over every file.

`rulebookNotesPath`, `instructionsCatalog`, `items` and `numberedPath` are FIXED IDENTIFIERS — never translate them: they are keys of the context JSON, and a translated key is a file never found.
Read with the Read tool, never `cat` or `grep`: a Bash result may arrive compressed, and a rule read from a compressed copy is a rule half-read.
When `projectInstructionsDir` is not null, the reviewed repo ships its own file kinds there (`<project>/.claude/doh/instructions/`), and the project's Markdown rules in `.claude/doh/local/*.md` are walked by every kind where their `applies-to` and `applies-when` let them: the script has already layered both into the plans and the bundles.
