---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, a list of branches, or every file under a folder) - checks every changed file against global/local instruction checklists and writes one concise Polish report per branch (interactive HTML by default, Markdown with --only-md) with severity, real line numbers, violated rule and expected result
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]
          timeout: 10
          once: true
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/skills/codeReview/scripts/check-part.cjs"]
          timeout: 30
---

# codeReview — deterministic instruction-driven review

You produce review REPORTS only: never fix code, commit, checkout or edit the reviewed project's
files. Staged mode is the single exception — its context script runs `git add .` to stage every
pending change before reviewing, the index only.

Execute EVERY step yourself, in the current conversation, targets sequentially — never dispatch
sub-agents (Agent/Task/Explore) for any part of a run: not per branch, not per file, not for a large
diff, not to save context or time.

Coverage is non-negotiable: every file of every target, every checklist item of every applicable
instruction, on every run — violating the letter of these steps violates their spirit. Coverage and
reporting scope differ: everything is evaluated, only what the diff touched is reported (Step 3
scope gate).

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

## Step 1 — Build the review context

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = the current working
   directory, unless `--project=` overrides it (point 2).
2. Strip the flags FIRST, from the whole argument list, wherever they sit — an unstripped flag would
   be mapped below as a branch name:
   - `--only-md` → `OUTPUT=md`; otherwise `OUTPUT=html`.
   - `--project=<path>` → `PROJECT=<path>`. Everything is relative to it: which repository is read
     and — in staged mode — staged, where the reports land, and which `CLAUDE.md` and
     `.claude/doh/instructions/` bind. A caller whose work lives somewhere other than the current
     directory — a git worktree, e.g. a parallel implementNewFeature task — MUST pass it, or the
     review silently stages and reviews the main checkout instead of that caller's tree.
   - `--since-last` → pass it through to the context script (`INCREMENTAL`). It reviews only the
     files whose content moved since the previous review of that target, using the snapshot the
     script keeps next to the report. Meant for a RE-review of a target already reviewed (the
     implementNewFeature review loop uses it from cycle 2 on); on a first review it warns and
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
4. Run (Bash tool): `node "<SKILL_DIR>/scripts/review-context.cjs" --mode=<mode> [--branches="..."] [--path="..."] --output=<OUTPUT> --project="<PROJECT>" [--since-last]`
   `--branches` goes with `--mode=branches` and `--path` with `--mode=folder` — folder mode fails
   with `No folder given` if the path is left off this line.
5. Parse the JSON from stdout — a short summary, not the context:
   - Report every `errors[]` entry to the user immediately, in Polish.
   - No targets / exit code 1 → stop after reporting the errors.
   - Report every top-level `warnings[]` entry, in Polish.
   - Read the file at `contextPath` with the Read tool — never `cat` it: that file IS the context
     every later step calls "the context JSON" (`targets`, `globalInstructions`, `checklistPlans`, …).
     `targets[].resumed` true means the target continues an interrupted run (Step 3).

## Step 2 — Load the rulebook (once per run)

1. Read the `numberedPath` of EVERY entry of `globalInstructions` — the globals at least one
   reviewed file is actually walked against, not every global the skill ships.
2. Read the `numberedPath` of EVERY entry of `localInstructionsCatalog` (deduplicated across
   targets; per-file `localInstructions` are INDEXES into this catalog).
   `numberedPath` (a FIXED IDENTIFIER) is a copy of the instruction at `path` that the script wrote
   for this run, with every checklist item already prefixed by its address (`- general#6: …`).
   Read it with the Read tool, never `cat` or `grep`: a Bash result may arrive compressed, and a
   rule read from a compressed copy is a rule half-read.
3. If `claudeMd` is not null, read it and treat it as one more global instruction.
4. Issue every Read of points 1–3 as parallel tool calls in ONE message — the whole rulebook
   loads in a single turn, never one file per turn.
5. Precedence when rules conflict: project `CLAUDE.md` > local instruction > global instruction,
   and among locals the narrower one wins — a file routinely walks a general local plus the specific
   one for its kind (`component` + `feature-component`, `unit-tests` + `ngrx-effects-unit-test`,
   `models` + `state-interface`), which is layering, not duplication. Apply only the winning rule;
   never report a violation of the overridden rule.
6. Some of those paths may sit under `projectInstructionsDir` (`<project>/.claude/doh/instructions/`)
   — the reviewed repo's own rulebook. It binds exactly like the skill's: a project file replaces the
   skill file of the same relative path, the rest are extra instructions.

Never skip or skim any of these files — they are the review rulebook.

Every checklist item has an address, and Step 3 ticks the items off one by one under it:
`<id>#<n>` is the n-th top-level `- ` bullet of that instruction's body, counted from 1 in file
order — the only numbering there is. Each entry of the two catalogs above carries the `id` its
items are addressed by beside its `path`, and its `numberedPath` copy already prints that address in
front of every item. Take addresses from that copy only: never number, list or count items yourself,
and never through Bash.
Each file of a target carries `plan`, an INDEX into `checklistPlans` (top level of the context
JSON) — files of one kind share one plan, so the catalog holds a handful of entries for a diff of
hundreds of files, exactly like `localInstructionsCatalog` below. `checklistPlans[file.plan].checklist`
lists one `<id>:<items>` entry per instruction that applies to that file — the globals first, then
its matched locals — where `<items>` names WHICH items of that instruction this file is walked
against (`general:1-13`, and `accessibility:6-9,12-14,17,20` for a file whose kind takes it out of
the markup-only rules). `checklistTotal`, which stays on the FILE, is their sum: the number of items
that file must be walked against.
The plan is the authority on that: walk exactly the numbers it lists, under the addresses it gives
them, and never renumber a narrowed instruction from 1 — `accessibility#12` is the twelfth bullet of
the file, whether or not `#1-11` are in this file's plan.
Three mechanisms put an item there or leave it out, and all three are already resolved in the plan.
A whole instruction is narrowed by `applies-to`: a global that declares one is narrowed by path
exactly like a local, one that declares none still applies to every file, and a pattern starting with
`!` excludes what it matches and always wins over an include. A single item is narrowed by a leading
scope tag — `- {styles} Contrast ratios …` walks only for the file kinds the instruction's `scopes:`
frontmatter maps that name to (an untagged item walks wherever its instruction does). A reach tag
works the other way: `- {+routes} A guard factory is invoked …` ALSO walks that item for the files
scope `routes` maps, outside the instruction's `applies-to` — a rule about one file kind that is
broken in another (the guard rule, in the routes file that registers the guard). Such a file's plan
then holds that instruction with only its reaching items; that is the reach, not a mismatch.
So a plan shorter than the rulebook is a decision, not an omission — the plan's `globalInstructionsSkipped` names, by
`<id>`, the globals this file's path took it out of, an instruction that is not in the plan is never walked or ticked, and an
item the plan does not list is not this file's rule: it is never walked, never ticked and never
reported, not even when the file happens to break it.
`checklistGates` (top level of the context JSON) holds the `gate:` sentence of every instruction that
declares one — a precondition answered per file, in Step 3 point 2, before that instruction is walked.
The project `CLAUDE.md` is a rulebook, not a numbered checklist: its rules decide verdicts and
override conflicting instruction items, but they get no `<id>#<n>` line of their own.

## Step 3 — Analyze (per target, per file) and write findings as you go

**Scope gate — only what the diff touched.** Coverage is unchanged (every file, every checklist item);
what shrinks is what may be REPORTED. A finding exists only when the violation is carried by a line of
that file's `changedLines` — the diff added that line or modified it. A pre-existing violation on an
untouched line is never a finding: not at any severity, not even when the same rule is violated on a
changed line elsewhere in the same file, and never as a proposal to refactor code the diff left alone.
Four narrow carve-outs, each of which must state its link to the diff in `**Problem:**`:
- `changedLines: null` (status `A`, and every file in folder mode) — the whole file is in scope, every line counts as changed;
- an obligation the changed lines create — the diff adds a construct whose required companion is
  missing (a new handler/branch/action without its spec case, a new subscription without teardown, a
  missing fail action completing a trio, a new interactive element without its required attribute):
  reported, citing the changed line that creates the obligation;
- a regression the diff causes in untouched code (a renamed field its old readers still use, a removed
  guard something still relies on) — cited at the untouched line, naming the change that breaks it;
- a deletion-only diff (`changedLines` is `""`, or status `D`) — only consequences of the removal itself.

**Mechanical-change gate — a reformatted or renamed line is not a reviewed line.** A change is
MECHANICAL when it cannot alter runtime behaviour: an import added, removed, reordered or repointed;
an identifier renamed (variable, field, method, class, component, interface, constant, action,
translation key, test description); a file or folder renamed or moved; a component/directive selector
renamed; pure formatting (indentation, wrapping, quotes, semicolons, trailing commas, blank lines,
member order with no code change). Anything that changes what the code DOES is not mechanical, however
small it looks — a changed condition, argument, operator, default, lifecycle hook or pipe never is.
- A line whose ONLY change is mechanical counts as UNTOUCHED for reporting, exactly like a line the
  diff never touched: no finding may cite it for a rule it was already breaking before the diff, at
  any severity, however clearly the rule is broken. Renaming or reformatting code is not adopting it.
- A file whose WHOLE diff is mechanical gets no logic pass at all: do not evaluate its behaviour,
  error handling, performance, state usage, template semantics or test assertions. Its checklist walk
  narrows to the two questions below, and its coverage marker records that narrowed walk.
- Exactly two things ARE reported on a mechanical change, and `**Problem:**` names the change each
  one comes from:
  1. **the change broke something** — a reference still using the old name, path, selector, key or
     import (template, spec, barrel `index.ts`, route, style, translation file, mock, DI token, lazy
     import), a symbol left unresolved by a removed import, an import still pointing at a file that
     moved, a public member renamed out from under its callers;
  2. **the change itself violates an instruction** — the new name breaks a naming rule; a renamed
     component whose selector, folder name, file name and sibling files (`.html`, `.scss`, `.spec.ts`,
     snapshot) were not renamed to match; a moved file now sitting in the wrong layer or outside its
     canonical location; an import edge whose direction or form (barrel vs concrete path) now breaks
     the architecture instruction; a reformat that leaves the file against the style rules.
- The rename pair is `oldPath → path` on the file entry; `oldPath` is there when `status` is `R`
  and absent otherwise — that pair, not the diff, is what the naming and location checks compare. The
  diff at `diffPath` is cut from one diff of the whole target, so it shows a rename as `rename from` /
  `rename to` plus the hunks that really changed; still, "the diff shows the whole file as new" never
  means "review the whole file as new" when `status` is `R`. A pure rename changes no content at
  all: `changedLines` is `""` while `status` is `R`, which is a rename, not the deletion-only case
  above.
- Git only calls a move a rename when the content stayed similar enough; a heavily edited move arrives
  as an added file (`A`) plus a deleted one (`D`). When an added file is recognizably the moved content
  of a file deleted in the same target, treat the unchanged parts as mechanical and review only what
  the move actually changed.

**Behaviour-preserving gate — a review never asks for a functional or visual change.** Every finding
must be fixable without changing what the working code DOES or how it LOOKS. Drop the finding, at any
severity, when applying it would: break or regress functionality that currently works; change runtime
behaviour into something other than what the task plan, ticket or PR description specifies; or change
the rendered UI (layout, spacing, colours, copy, states, flow) into something other than the mockups.
That includes "while you are here" improvements — a different algorithm, a stricter validation, an added
guard or default, a removed branch, a renamed public contract, a restyled template — whenever the change
is not required by an instruction AND provably behaviour-neutral. Findings stay on the axis this review
owns: structure, naming, typing, duplication, layering, tests, security and real defects, where the fix
is a refactor the user cannot see. When the code contradicts the plan or the mockups, report THAT as the
finding (the code is wrong), never a change that would make working code deviate from them.

**Prettier formatting is out of scope.** Never report anything Prettier owns and rewrites on save:
indentation, line width and wrapping, line breaks inside calls/objects/arrays/templates, quote style,
semicolons, trailing commas, spacing around operators/braces/attributes, blank-line count, and the
physical placement of Angular template attributes or class lists. No finding of ANY severity is
written about such a line, and no report ever says "run Prettier" or "format this" — the formatter
settles it mechanically and a review comment about it is noise. Import ORDER stays reviewable (the
general instruction owns it) because it expresses layering, and so does everything about the code
itself: naming, structure, duplication, typing, logic.

**Endpoint names are out of scope.** Never report the wording, spelling, casing, versioning, path
segments, leading/trailing slashes, key names or CHANGES of REST endpoint paths and their `endpoints`
constants — the backend contract decides them, not this review. The one exception is an absolute URL
inside the value: protocol + domain (`https://api.example.com/...`), `localhost`, or an IP with a port —
that is reported as a hard-coded environment/base URL. Everything else about such a file (typing,
method naming, layering, `.pipe(...)` usage, secrets in query params) stays reviewable as usual.

A target WITHOUT `target.resume`: clear any stale part files first —
`rm -f "<reportPath minus .md>".part*.md` — then write the report header (Step 4 format) to
`target.reportPath`. The report path carries the run stamp down to the MINUTE, so a second run of the
same target inside the same minute lands on the same paths; a previous run that died between writing
its parts and assembling them would otherwise have its leftovers spliced into this report by the
concatenation at the end.
A target WITH `target.resume` continues a run that was interrupted before its assembly; the script
has already checked that the target still holds the content that run reviewed, and pointed
`reportPath` at that run's report. Never `rm` its parts. Write the header only when
`resume.headerWritten` is false. Skip every file listed in `resume.doneFiles` — its part, checklist
block and coverage marker are already on disk — and analyze every other file exactly as below, with
the part number it has by its position in `target.files` (overwrite a part that exists without a
coverage marker). The cross-file pass and the closing parts are always written anew.
Then process EVERY file in
`target.files`, one at a time, in the listed order. The script has already excluded everything
skippable → `target.skipped` (generated, binary, and prose — the label says "wygenerowane/binarne" but
`*.md`, `*.txt`, `*.rst`, `*.adoc` and `LICENSE`-style files go there too), so `target.files` contains
no file you may skip:
no exceptions for renames, formatting-only diffs, tests, configs, file size, diff size, or how many
files remain — the mechanical-change gate narrows what a renamed or reformatted file may REPORT,
never whether it is processed. A file whose `localInstructions` is empty still gets the complete global pass — zero
local matches usually means the file sits outside every dedicated location (the script surfaces
these files in `warnings[]`), not that the file may be skimmed. For each file:

1. Open the file from `target.workDir`, the folder the script filled with what this target reviews
   (`workDir`, `contentPath` and `diffPath` are FIXED IDENTIFIERS — never translate them).
   `file.contentPath` is the file's full content in the reviewed revision (the branch's commit or
   the index; in folder mode, the working-tree file itself), and `file.diffPath` is this file's own
   section of the target's diff.
   Read both with the Read tool — never `cat`, `git show` or `git diff` through Bash, whose output
   may reach you compressed: a line lost on the way is a line never reviewed.
   `contentPath` is `null` for a status `D` file and for a binary one — review it from the diff
   alone; `diffPath` is `null` for a status `A` file and in folder mode, where every line is new
   and the content alone is the input.
   The line numbers the Read prints are the numbers every finding, tick and range below uses.
   A file longer than 2,000 lines is read page by page (`offset`/`limit`) up to its last line,
   never sampled.
   A line the Read cuts short (over 2,000 characters) is read whole with
   `sed -n '<N>p' "<contentPath>"`.
   One file is open at a time.
   The message that writes file N's part (point 4) may carry the Reads of file N+1, since neither
   depends on the other; file N+1's analysis still starts only after both have returned.
   `target.commands.grep` (Bash, needs a POSIX shell) searches the whole reviewed revision (the
   branch's commit, the index, the working tree) for its `<pattern>` placeholder, an extended regex.
   It prints only `<count> match(es) -> <file>`: Read that file for the matches themselves.
   Use it, never a search of the checkout, whenever a rule asks whether something already exists
   elsewhere in the project.
   `changedLines` (precomputed by the script from `git diff -U0`) is the authoritative list of the
   lines this diff touched, numbered exactly like the Read of `contentPath`, e.g. `"7, 12-15"`;
   `""` means the diff only deleted lines, `null` means an added/deleted file. Never re-derive
   these ranges from diff hunks yourself.
   The import edges are not yours to collect: the script wrote them to `target.importLedger` (the
   cross-file layering question reads it). Only a file named on its `# not parsed` line — a language
   the script has no extractor for — needs its import lines noted while its content is open.
   With the file's diff and content in front of you, turn its plan's `checklist`
   (`checklistPlans[file.plan].checklist`) into the ticking list of
   this file: every instruction of the plan, in plan order, expanded to exactly the item numbers its
   `<items>` spec names (`component:1-27` is `#1`…`#27`; `accessibility:6-9,12` is four items, and
   `#1-5`, `#10-11` are not this file's rules) — that list, and nothing shorter or wider, is what
   point 2 walks and what point 4 writes down.
2. Evaluate the file against every point below, checklist-driven — never holistically. For points
   1 and 2, walk that ticking list top-to-bottom: read an item, check the file's code against that
   one item, reach an explicit pass/violation verdict, record the finding(s) on violation, tick the
   item off, then move to the next item. The checklist drives the pass — never scan the file first
   and recall rules from memory afterwards. Reason through items SILENTLY — do not print per-point
   notes or progress commentary; a file's verdicts go into its checklist block (point 4) and its
   findings into the report, never into the terminal. Sampling checklists, skipping items, or
   abandoning a checklist partway through a file is forbidden:
   1. Compliance with every global instruction, checklist item by item.
   2. Compliance with every matched local instruction (its `localInstructions` indexes into
      `localInstructionsCatalog`), checklist item by item.
   3. Consistency with the other files of this diff (naming, patterns, architecture) - the one point
      NOT verdicted here: a single file cannot answer it. This pass only COLLECTS what it needs (the
      names and literals the file introduces, and the imports of a `# not parsed` file); the one cross-file pass
      below reaches the verdicts. Judging it per file as well would raise the same drift once per
      file involved, in several part files, under the same instruction.
   4. Potential regressions.
   5. Readability problems.
   Performance, security, architecture and test coverage are enforced through their global
   instruction checklists in point 1 — do not invent extra criteria beyond the instructions.
   An item counts as evaluated only after you checked the file's code against it and reached an
   explicit pass/violation verdict — "nothing jumped out at a glance" is not a verdict.
   **A tick is earned, never assumed.** `[x]` goes on an item ONLY when it was checked 100%: you
   read the item, looked at this file's code for it, and can say where you saw the answer — the
   lines that satisfy a requirement, the lines you cleared for a prohibition, or the lines that
   violate it. Everything short of that — the rule's subject lives in code this run never opened,
   the item needs a build/runtime answer, you are guessing, you ran out of room — stays `[ ]` with
   the reason written next to it. An unticked item is an honest gap the report carries on; a tick
   that was not earned is a false claim about the review and the one thing this checklist exists to
   prevent. Neither the size of the file nor the number of items already walked changes this.
   **Gates come first, and only where the instruction declares one.** For each instruction of the
   plan whose `<id>` appears in `checklistGates`, answer that one sentence against the file's content
   BEFORE walking its items. A gate that holds changes nothing — walk the items one by one as always.
   A gate that fails is a verdict for the whole instruction: the items THIS FILE'S PLAN gives it are
   collapsed into ONE ticked range line naming what is absent (`[x] security#1-6,#8-13 — BRAMKA:
   plik zawiera wyłącznie re-eksporty`), and they count as checked, because the gate answered every
   one of them.
   A gate is answered from what the file HOLDS, never from its name or its size: a `.component.ts`
   with inline `styles`, a `host: {}` binding, a timer or a `document` call renders UI, and a gate
   waved through on "this looks like a plain class" is the unearned tick the ticking exists to
   prevent. When the answer is not obvious, the gate HOLDS and the items are walked.
   A gate fails only when the file holds NONE of the constructs the gate sentence names — never
   because what it holds looks trivial, small or obviously correct.
   A one-line setter is a method and a lone `.next()` call is behaviour: a test-coverage gate over
   such a file holds, and its items are walked.
   Checklist items come in two shapes, and both get real verdicts:
   - prohibitions — code that must not appear; scanning the file finds these;
   - requirements — something that MUST be present (`ChangeDetectionStrategy.OnPush`, a route
     `title`, `{ dispatch: false }`, an `afterEach`, a `should`-prefixed description, a fail action
     completing a trio, a matching spec...). Scanning never finds an absence: a requirement's PASS
     verdict is reached only by pointing at the exact code that satisfies it, and a requirement
     nothing satisfies is a finding.
   Element-level template rules (`data-test`, `type` on `<button>`, `[alt]`, `aria-label`, programmatic
   labels, bound ARIA state) are verified per ELEMENT, never per file: walk EVERY interactive and media
   element of the template (`button`, `a`, `input`, `select`, `textarea`, `img`, any element with an event
   binding) and reach a separate verdict for each applicable rule on each element — one compliant element
   never passes the file, and a rule's walk ends at the last element, not at its first violation.
   Seven rule families are historically under-reported; check them deliberately for every file their
   instructions match, even when the diff looks unrelated (they stay defined ONLY by their
   instruction files — never re-derive them from memory):
   - `computed()`/`pipe(map(...))` over facade values (component, feature-component and ngrx-facade instructions);
   - naming rules (general instruction) plus naming consistency across the diff;
   - code-quality rules (code-quality instruction): duplicated code as full 🔴 High findings;
     unnecessary, unused and boilerplate code, every comment the diff adds, inconsistency as full
     🟡 Medium findings — never nits to skip;
   - structure rules: canonical area layout and `index.ts` barrel placement (architecture instruction);
   - test scaffolding rules (unit-tests instruction plus the matching per-type test instruction):
     spec and snapshot location, the prescribed setup instead of TestBed/MockStore, `ngMocks.faster()`
     with `beforeAll`, a state-restoring `afterEach`, `should`-prefixed descriptions, a lazily
     reassigned `actions$`, payload-asserting `toHaveBeenCalledWith(...)` — re-walked in full for
     EVERY spec file; the sixth spec gets the same item-by-item walk as the first;
   - change-detection escape hatches and missing `effect()` `onCleanup` (performance instruction):
     absence-shaped rules that scanning never surfaces — a `markForCheck()`/`detectChanges()`/`NgZone`
     call reads as ordinary code until you ask why the state it compensates for is not a signal;
   - signal-input wiring in specs (unit-tests instruction): an input written by property assignment
     instead of `setInput`/`MockRender` inputs — the spec passes either way, so only an explicit
     verdict per input-setting line finds it.
3. Record only REAL findings — no speculative or cosmetic padding.
   One finding = one rule violated in one file. When the SAME rule is broken in several places of
   one file with the same consequence and severity, that is ONE finding whose `**Linia:**` lists
   every occurrence (`2, 8, 10-12`) — never one block per occurrence. An occurrence whose
   consequence or severity differs (one crashes, another is cosmetic) gets its own finding, as
   does a different rule broken on the same line.
   The SAME violation is reported ONCE: when one requirement is written into several instructions
   (a local rule and the general or global one it refines), one finding's `**Reguła:**` names
   every copy it breaks, `; `-joined, the most specific first — a local before a global, the
   specific local before the general one it sits under (`feature-component#4; component#9;
   general#6`).
   A file walking both `component` and `feature-component` gets ONE such finding for a rule they
   share — never the same violation twice in two findings.
   Those copies are the ONLY items one finding may share, so it names at most one item per
   instruction. Two items of one checklist are two requirements: code breaking both — even on
   one line — is two findings, each with its own `**Problem:**`, `**Oczekiwane:**`, severity and
   lines. A finding that lists several defects ("brak OnPush, style inline, `CommonModule` w
   `imports`") is one defect reported and the rest lost: the reader fixes, the PR comments and the
   severity follow the first one.
   Every item that finding names is ticked `NARUSZENIE` with the finding's lines, each in its own
   instruction's block line.
   None of them is ticked `OK` because another item "already reports it": code that breaks an item
   never passes it, and a violation filed under one item only is lost to every other rule it breaks.
   Every listed line number is determined at the moment of writing it: locate the offending code
   in the Read of `contentPath` and cite the number printed there — never diff hunk numbering, never an
   estimate from memory. Each occurrence contributes one number, or one `<start>-<end>` span when
   that single occurrence spans contiguous lines. Cross-check every finding against `changedLines`
   and the scope gate: lines outside `changedLines` are reportable only under one of the gate's four
   carve-outs, and the description must state the link to the diff; otherwise the finding is dropped.

   **Two sweeps close every file — a cited line is not a retired line.** The checklist pass of point 2
   finds a rule's FIRST violation; these two sweeps find the rest, and both run before the file's
   findings are written:
   - *occurrence sweep* — for every rule you are reporting, search the WHOLE file for its remaining
     occurrences and list each one in `**Linia:**`. The first hit is never assumed to be the only one.
   - *line sweep* — re-read every line you cited and ask which OTHER checklist items that same line
     breaks. One line routinely violates several rules at once: `<input [(ngModel)]="q"
     placeholder="Search">` breaks the forms rule, the i18n rule and the label rule; a
     `@Component({...})` bag that already produced a missing-`OnPush` finding still hides inline
     `styles:`, a mismatched `imports` array and a selector-prefix breach; an `<a target="_blank">`
     flagged for its unvalidated URL still lacks `rel="noopener noreferrer"`; a field flagged as
     mutable-bound-in-template still holds a hard-coded user-facing string. Writing a finding for a
     line marks that ONE rule handled — never the line.
   Both sweeps run on every file, and most of all on files that already produced many findings: that
   is where further occurrences hide, not where they run out.
4. Persist per FILE, never all at the end and never later than the file's own walk: the moment a
   file's walk is finished, write ONE part file for it — `<reportPath minus .md>.part<NN>.md`,
   `<NN>` being the file's position in `target.files` (from 1), zero-padded to the digit count of
   `target.files.length + 2` and never to fewer than two digits (`part03` for 5 files, `part003`
   for 98).
   Every part of the target, the cross-file and closing ones included, uses that one width.
   The assembly below concatenates them through a shell glob, which orders them as text: `part100`
   would land between `part10` and `part11` if the earlier parts were padded narrower.
   Write it with ONE Write call, holding, in this order: the file's findings sections, its ticked
   checklist block, its coverage marker.
   A file with no findings still gets its part file — the block and the marker alone.
   A part is report text: lean mode never shortens it, not a finding and not a checklist line.
   Earlier parts are never edited, and the next file is not analyzed before the current one's part
   file is written (only the Reads of the next file may ride in the same message as this write).
   **Every part is checked as it is written.** This skill's hook runs `scripts/check-part.cjs` on each
   Write or Edit of a part file and compares it with the context JSON: the part number and width,
   the parts before it being on disk, a block covering exactly the plan's items with the marker's
   total, the form of every verdict line, a finding behind every `NARUSZENIE`, and cited lines that
   exist in `contentPath`.
   A part that fails is NOT written: the call comes back with the list of problems.
   Fix every one and Write the WHOLE part again — an Edit is checked the same way, as the file it
   would leave behind.
   Never answer a refusal by ticking an item you did not check: an item you cannot verify is
   `[ ] … — NIEZWERYFIKOWANE: <reason>`, which the check accepts.
   The checklist block is the file's walk, written down:

       <!-- checklist: <file.path>
       [x] accessibility#3,#10-11,#15-16 — BRAMKA: plik nie buduje DOM ani nie zarządza fokusem
       [x] general#1-5,#7-13 — OK (brak wystąpień)
       [x] general#6 nazwy const camelCase — NARUSZENIE (12, 18)
       [x] component#1 OnPush — NARUSZENIE (4)
       [x] component#2-14,#16-27 — OK (brak wystąpień)
       [ ] component#15 walidatory runtime — NIEZWERYFIKOWANE: formularz w klasie bazowej
       -->

   - The block covers every item of the file's ticking list (point 1), in plan order — the plan's
     item numbers, no others: an item the plan left out gets no line, not even a `NIE DOTYCZY` one.
     It does NOT spend a line per item: **items of one instruction that share a verdict are collapsed
     into one line** whose address is a range or a list of ranges (`general#1-5,#7-13`). Every item
     the plan lists still appears exactly once — the ranges of one instruction never overlap and
     never skip a number the plan lists, or the renderer says so (a number the plan itself does not
     list is not a gap, and a range may jump over it). Expanded, the block has exactly
     `checklistTotal` items.
   - `NARUSZENIE` is the one verdict word the renderer MATCHES, exactly and case-sensitively, to mark
     an item as broken in the coverage section. Write it in capitals and in that exact form: a
     `naruszenie`, `NARUSZONO` or `VIOLATION` parses as a clean item, so the page would show the rule
     as ✓ compliant directly under the finding that reports it breaking. The renderer NAMES such a
     line as a warning, which keeps the Markdown — so a near miss costs the HTML report instead of
     passing unnoticed, and the fix is the exact word, never ticking a different item instead.
     `OK`, `BRAMKA`, `NIEZWERYFIKOWANE` and `brak wystąpień` are FIXED IDENTIFIERS as well: the part
     check reads every one of them, in capitals and exactly as written here, never translated.
   - Collapse only what genuinely shares a verdict. `NARUSZENIE` and `NIEZWERYFIKOWANE` lines carry
     their own reason, so they stay separate — a range is for the OK run around them and for a
     gated-out instruction, never a way to sweep a violation into a neighbour's range.
   - The 2–6 word label in your own words belongs on the lines that need it: `NARUSZENIE`,
     `NIEZWERYFIKOWANE`, and a single-item `OK` worth naming. On a collapsed OK or BRAMKA range the
     address IS the reference — do not spell out thirty rules to say the file has none of them.
   - `[x] … — OK (<where>)` — checked and compliant. `<where>` is where you saw the answer: the
     line numbers of THIS file you verified, as its Read printed them (`L12, L18`), or
     `brak wystąpień` when the rule's subject does not occur in the file at all.
     `brak wystąpień` is a verdict for a PROHIBITION only — for a requirement, a missing subject is
     a finding, never an absence to wave through.
     `<where>` never names another item: `OK (pod general#6)` is no evidence, and an item the code
     breaks is `NARUSZENIE` even when another item's finding already cites the lines (point 3).
   - `[x] … — BRAMKA: <what is absent>` — the instruction's `gate` failed for this file (point 2),
     so its whole range is ticked in one line. Only an instruction listed in `checklistGates` may
     produce such a line, and the reason names what the file does not contain.
   - `[x] … — NARUSZENIE (<n>, …)` — checked and broken; the lines are the ones the finding's
     `**Linia:**` carries, written the same way (bare numbers, no `L` prefix), and that finding is
     in this same part file, its `**Reguła:**` naming this item's address among its own.
     (Findings from the cross-file
     pass or from the universal points 3–5 belong to no item and appear only as findings.)
   - `[ ] … — NIEZWERYFIKOWANE: <reason>` — anything you could not check 100% (point 2). The reason
     is concrete: what was missing, not "no time".
   - Each verdict is written when it is reached, so the block is the running record of the walk —
     never a list reconstructed from memory once the file is done. Collapsing is how a reached
     verdict is WRITTEN, not permission to reach one for thirty items at once: an OK range means you
     walked each of those items and each came back clean.
   The coverage marker closes the block and states the same walk as numbers:
   `<!-- coverage: <file.path> <checked>/<file.checklistTotal> -->`
   `<checked>` is how many ITEMS of the block carry `[x]` — a range line contributes every number it
   spans, not one — counted from the block you just wrote;
   `checklistTotal` is copied from the context JSON. The two match on a file you finished — a
   smaller `<checked>` makes the renderer warn and keeps the Markdown, which is the honest outcome
   of an interrupted pass, not something to paper over with an unearned tick. The renderer recounts
   the ticks and warns when the marker, the block and `checklistTotal` disagree.
   A file the mechanical-change gate narrowed writes `<!-- coverage: <file.path> mechanical -->`
   and NO checklist block — its walk was two questions, not the checklist, and that marker is its
   complete proof. It is for a WHOLE-diff mechanical file only; a file with even one behavioural
   change walks and ticks its items like any other.

After the per-file pass, do ONE cross-file pass over the whole diff for point 3, written as part
`N+1` (`N` = `target.files.length`): its findings sections only, no checklist block and no coverage
marker.
That part is written on every target with files — empty when the pass found nothing, because the
assembly refuses a report without it.
Answer each of these four questions explicitly, against the diff as a whole:
1. Duplication drift — is the same logic, formatting or literal implemented in two or more places
   of this diff, or re-implemented next to an existing shared util? Answer it from three sources:
   - `target.duplicationCandidates` — jscpd's scan of the whole reviewed revision, kept only where
     the diff wrote at least half of the copy: `path` and `lines` are the copy, `sources` what it
     repeats, `kinds` how it matched (`exact`, `renamed` identifiers, `similar` with a gap).
     Open both sides of every candidate.
     Dismiss one only when the two blocks share no logic: a shape the framework or a generator
     dictates (a TestBed skeleton, a module or route declaration, a generated `project.json` or
     `tsconfig`), parallel data (translation files), or — for a `renamed` or `similar` candidate —
     nothing but syntax, because the blocks call different functions and read different fields (two
     `ngOnInit`s, each calling its own initializers).
     Renamed local variables and parameters over the same operations are still a copy.
     Report every other one.
     A target without the list was not scanned (its warning says why), and the other two sources
     then carry the question alone.
   - A search for what a token scan cannot see: for every exported function, class, pipe,
     directive, validator, util or constant the diff ADDS, look for an existing equivalent in the
     reviewed revision with `target.commands.grep` (Read the file it names) — by its name, a
     synonym and the characteristic expression of its body — in the shared folders first (`shared/`, `utils/`, `common/`, `core/`,
     or wherever this project keeps them).
   - What the per-file walk already noticed.

   Report every copy the diff adds under the code-quality instruction as 🔴 High, anchored on a
   line of the copy that the diff changed, and name the source it repeats (`path:lines`).
2. Layering — Read `target.importLedger` and walk it edge by edge, together with the edges you
   noted for its `# not parsed` files. Each line is `<importing file>:<line> → <specifier>`, plus
   `(<resolved path>)` for a relative one; `<line>` is the import's line in that file's
   `contentPath`. Name the layer
   of the importing file and of the imported module, check the edge's direction AND its form
   (barrel vs concrete path, per the architecture instruction) against the architecture
   instruction, and report each forbidden edge at the importing file, on that line. A permitted
   direction does not end the edge's verdict — a legal edge taken through the wrong form is still a
   finding. "No layering findings" may be claimed only after every ledger entry has its verdict.
3. Derived-data flow — does any state field, action payload or component binding carry a value
   computable from other state? Report every station of the flow (the action, the reducer field,
   the dispatching component), each under its own instruction.
4. Naming consistency — the same concept named differently across the diff's files, or one name
   reused for different concepts; reported under the code-quality instruction (🟡 Medium), while a
   plain naming-convention breach stays a general-instruction finding.

A target whose whole review produced no finding closes with one more part file after the cross-file
one, holding the single line `Nie wykryto problemów.` — the per-file parts before it still carry
every checklist block and coverage marker, which is what the report then shows. A target with an
empty diff (`files` empty) has no per-file parts at all: `Nie wykryto zmian do analizy.` is its
`part01`, so the assembly below always has something to concatenate.

Assemble the report in ONE Bash call: check the parts against the context, append them to
`target.reportPath` (which already holds the header), remove the parts, the import ledger and the
work folder, and — when `target.htmlReportPath` is not null — render the HTML report from the
assembled Markdown:
`node "<SKILL_DIR>/scripts/check-part.cjs" --context="<contextPath>" --report="<reportPath>" && { cat "<reportPath minus .md>".part*.md >> "<reportPath>"; rm -f "<reportPath minus .md>".part*.md "<target.importLedger>"; rm -rf "<target.workDir>"; node "<SKILL_DIR>/scripts/render-report.cjs" --report="<reportPath>" --project="<PROJECT>" --mode="<target.kind>" --branch="<target.branch>" --base="<target.baseBranch>"; }`.
`<contextPath>` is the path Step 1 printed.
The check gates everything after it (`&&`): when a part is missing or breaks the format, it exits 1,
lists every problem by part file and leaves the parts, the ledger and the work folder on disk.
Write each part it names again, whole, and run the same command again.
The four trailing arguments are what puts a code snippet under every finding: `--project` locates the
reviewed files, and `--mode`/`--branch`/`--base` make the snippet read the same revision the review
read — rendering it as a real `+`/`-` diff for `branch` and `staged`, and as a plain file view for
`folder`. Drop `--base` when `target.baseBranch` is null (staged and folder targets). Without these
arguments the HTML still renders, only without snippets.
Inside the braces the separators are `;`, never `&&`: once the check has passed, the renderer must
run even if the concatenation found nothing, otherwise a clean review would silently fall back to
Markdown in HTML mode.
Drop the render command when `htmlReportPath` is null (`--only-md` was passed) — the Markdown
is the report then. Otherwise the renderer replaces it with `target.htmlReportPath`; if it prints
warnings it keeps the Markdown too — but a kept Markdown has two very different causes, and only one
of them is yours to fix. `nierozpoznana…`/`nieczytelny…` warnings mean the report really did drift
from the Step 4 format: a line the parser could not read, which costs the HTML that finding or that
tick. A `sprawdzono <checked>/<total>` warning means the opposite — the block parsed perfectly and
simply carries an item you left `[ ] NIEZWERYFIKOWANE`. That one is the format working as intended;
never answer it by going back and ticking an item you did not check.

Coverage gate — before leaving Step 3 for a target: re-read `target.files` and confirm every entry
had its `contentPath`/`diffPath` read, its part file written, and either all five points covered (point 3
collected, the other four verdicted) or — for a whole-diff mechanical file — the gate's two
questions answered; analyze any missed file now. A target with an unanalyzed file is not done,
regardless of diff size or session length.

## Step 4 — Report format (one file per target, ALWAYS in Polish)

`target.reportPath` (UTF-8) is assembled during Step 3 (header written first, one part file per analyzed file, one concatenation at the end), with this structure and nothing else.
`render-report.cjs` parses exactly this structure to build the HTML report, so it is a contract, not a suggestion — every deviation degrades the HTML and makes the renderer keep the Markdown:

    # Code Review: <branch> → <baseBranch> | <YYYY-MM-DD> <HH:mm>

    ## <file path>

    <emoji> **<Severity>**
    - **Linia:** <N | N, M, X-Y>
    - **Problem:** <description of this single violation>
    - **Reguła:** <id>#<n>
    - **Expected Result:** <correct code state + concrete implementation proposal>
    - **PR Problem:** <ENGLISH, two sentences: what is wrong at these lines + the concrete consequence>
    - **PR Expected:** <ENGLISH, two to three sentences: the expected state + the concrete way to reach it>
    - **PR Locations:** <ENGLISH, comma-separated: every file and symbol the fix has to touch>

    <!-- checklist: <file path>
    [x] <id>#<from>-<to>[,#<from>-<to>] — OK (brak wystąpień)
    [x] <id>#<n> <short item label> — NARUSZENIE (<lines>)
    [x] <id>#<from>-<to> — BRAMKA: <what the file does not contain>
    [ ] <id>#<n> <short item label> — NIEZWERYFIKOWANE: <reason>
    -->
    <!-- coverage: <file path> <checked>/<total> -->

- Staged header instead: `# Code Review: staged (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Folder header instead: `# Code Review: folder <target.folder> (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Take the header date and time from the trailing `-YYYY-MM-DD-HH-mm` of `reportPath`, replacing the final dash of the time with `:` (e.g. `14-30` → `14:30`), so the header always matches the file name.
- If `target.skipped` is non-empty, add directly under the header the single line:
  `Pominięto pliki wygenerowane/binarne: <paths, comma-separated>`.
- The checklist block and the `<!-- coverage: ... -->` line of Step 3 point 4 are part of this
  format: one of each per analyzed file (the marker alone for a whole-diff mechanical one), written
  after that file's findings. They are HTML comments, so their text never reaches the rendered page —
  the renderer reads the ticks, checks them against the marker and shows them as the page's
  "Pokrycie checklist" section.
- When `target.unchangedSinceLastReview` is non-empty (a `--since-last` run), add one comment line
  under the header:
  `<!-- since-last: <N> unchanged file(s) skipped; previous report: <target.previousReportPath> -->`
- Severity emoji, exactly: ⚪ **Low**, 🟡 **Medium**, 🔴 **High**, 🟤 **Critical**, 🔵 **Missing Unit Test**.
- Assign severity by these criteria, picking the highest that applies:
  - 🟤 **Critical** — security vulnerability, data loss/corruption, state leaking between users or requests, runtime crash or broken build on a main path.
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification), and every duplication finding (code-quality's duplicated-logic and copy-paste-with-a-tweak items), whether jscpd listed it or the review found it.
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation, and every other code-quality finding (unnecessary, unused or boilerplate code, an added comment, inconsistency) — those stay Medium however cosmetic they look.
  - ⚪ **Low** — readability, naming-convention or style drift with no behavioral impact and not covered by the code-quality instruction.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
- When the violated rule is behavioral, **Problem:** names the observable runtime consequence
  (infinite dispatch loop, race condition, subscription leak, crash on null, stale UI) — and
  severity is picked from that consequence, not from the rule's category.
- One finding = one such block = one rule in one file (the splitting rules are Step 3 point 3).
  Separate every block from the next with exactly one blank line, and put one blank line before AND
  after every `##` header — that is what makes each finding render as its own section.
- `**Reguła:**` is the ADDRESS of the violated checklist item — `<id>#<n>`, the same address its
  `NARUSZENIE` line ticks (`component#1`), several joined with `; ` when one finding breaks more
  than one item. The address is a FIXED IDENTIFIER: never the item's text, never translated — the
  renderer looks each one up in the rulebook, prints the item's own words, and flags an address the
  rulebook does not hold. Only a finding no checklist item covers (the cross-file pass, the universal
  points 3–5, a `CLAUDE.md` rule) writes prose instead: `<source> → <rule in a few words>`, e.g.
  `CLAUDE.md → brak console.log`.
- `PR Problem`, `PR Expected` and `PR Locations` are written ONLY when `target.htmlReportPath` is not
  null. An `--only-md` run has no HTML page and so no way to post a comment, and its findings carry
  the four fields above and nothing more.
- `PR Problem`, `PR Expected` and `PR Locations` are the text of the pull request comment, so they
  are the only fields written in ENGLISH — no Polish words, ever. Write them for a reviewer who sees
  the comment on GitHub and never opens the report: everything needed to act on the finding has to
  be in those three fields, and every concrete name the Polish `Problem` and `Expected Result` use
  has to appear there too, in backticks.
  - `PR Problem` — two sentences. The first says what is wrong at the cited lines, naming the
    symbols involved (`method`, `field`, `selector`, `effect`, template element, style rule). The
    second states the concrete consequence: the runtime behaviour, the regression risk, the leak or
    the maintenance cost that makes it worth fixing.
  - `PR Expected` — two to three sentences. The first is the state the code should be in; the rest
    is the concrete way to get there — the operator, API, pattern, structure or test to use, and
    where it goes. Carry over every concrete name the Polish `Expected Result` proposes (method,
    field, action, selector, component, style class, translation key, spec file), so no part of the
    proposal is left behind in the Polish report.
  - `PR Locations` — a comma-separated list of every place the change has to be made, in the order
    the work would be done. Write `` `<path or file name>` `` when the file itself is the target and
    `` `<file>` → `<symbol>` `` when a specific method, effect, selector, template block, style rule
    or key is. List the reported file first, then every other file the fix reaches (actions,
    reducer, facade, template, styles, translations, spec). It is never empty — with nothing else to
    name, it is the reported file alone.
  Still no severity, no rule name, no Polish, and no sentence that only restates the Polish fields
  without adding the English detail above.
- The severity is a bold lead line — `<emoji> **<Severity>**` with NO leading `- ` — that opens the
  block; the other fields (seven, or four in an `--only-md` run) follow it as `- ` bullet lines in
  the order shown. Each field is its
  own line and never continues on the previous field's line. `**Linia:**` holds a comma-separated
  list of numbers and/or `<start>-<end>` spans — one entry per occurrence. Its format is a FIXED
  IDENTIFIER: bare line numbers as the Read of `contentPath` printed them (`12, 18, 20-24`), with
  no `L` prefix, no path, no word and no note. A note belongs in `**Problem:**`. The renderer builds the finding's code snippet from this
  field, so an entry it cannot read gets no snippet and a parser warning.
- Group findings under one `## <file path>` section per file; omit files without findings.
  The cross-file pass may append a second section for an already-reported path — that is acceptable.
- Expected Result describes ONLY the correct state of the code plus a concrete implementation proposal.
- No intros, no summaries, no closing remarks — findings only.
- No findings in the whole target → the report body is the single line `Nie wykryto problemów.`
- Empty diff (`files` empty) → the single line `Nie wykryto zmian do analizy.` (plus the skipped line, if any).

## Step 5 — Terminal summary (Polish)

After writing all reports print, in Polish: each report path (`target.htmlReportPath` when the renderer ran, otherwise `target.reportPath`) + finding counts per severity, plus any errors/warnings from Step 1 and any warning the renderer printed.
Also state the checklist coverage of the target: how many files walked their whole checklist, and — when any did not — every such file with its `<checked>/<total>`, so an unticked item is read as the gap it is instead of disappearing into the report.
For a `--since-last` run also say how many files were skipped as unchanged and where the previous report is (`target.unchangedSinceLastReview`, `target.previousReportPath`) — the reader must know the report covers only what moved.
For a resumed target (`target.resume`) say that it continued the run from `resume.from` and how many files it took over from it.For a branch target also name the base it was reviewed against — `target.baseBranch` plus where that base came from, read off `target.baseSource`: `pr` = the target branch of PR #`target.prNumber`, `fork` = the branch it was created from, `candidate` = the default `main`/`master`/`develop`/`dev` detection. Staged and folder targets have no base (`baseSource` is null): a staged review covers the uncommitted changes themselves.
Nothing else.

## Skip rationalizations — all invalid

Catching yourself thinking any of these means STOP and return to the file or checklist item:

| Excuse | Reality |
|---|---|
| "Too large / trivial / renamed / similar to a file that passed" | Coverage never shrinks: the script already removed skippable files, moved code breaks structure and import rules exactly at its new location, and similarity is not compliance. A mechanical-only diff narrows what the file may REPORT to the gate's two questions — it never drops the file from the pass. |
| "This rename/reformat drags in badly written code" | The mechanical-change gate: a renamed or reformatted line counts as untouched. Report only what the change BROKE and what the change ITSELF violates — never a violation that was already sitting there. |
| "This rule is pedantic here" | Rule weight is expressed through severity, never through omission. |
| "I remember the instructions" | Verdicts come from the instruction files read this run, item by item — not from memory. |
| "This would work better a different way" | The behaviour-preserving gate: if the fix changes what working code does, how it flows, or how it looks versus the plan and the mockups, it is not a finding. Report only fixes the user cannot see. |
| "This file already has plenty of findings" | Findings per file are unlimited. Stopping a checklist partway is skipping items. |
| "This line already has a finding" | Findings are per rule, not per line. A cited line goes back through the remaining checklist items (Step 3 point 3, line sweep) — one line commonly breaks three or four rules. |
| "I already reported this rule here" | You reported its first occurrence. The occurrence sweep (Step 3 point 3) searches the whole file for the rest and puts every one into `**Linia:**`. |
| "No local instruction matched this file" | The globals in its plan still apply, and zero local matches often means the file sits outside every dedicated location — itself a violation. |
| "The gate probably fails, collapse the instruction" | A gate is answered from what the file HOLDS, and an unclear answer means the gate HOLDS. A wrongly failed gate silently drops a whole instruction — the widest unearned tick there is. |
| "One big range is faster to write" | A range is a way to write verdicts you already reached, one per item. Ranging over items you did not walk is thirty unearned ticks on one line. |
| "Context/time is running low" | Coverage outranks speed, and the coverage marker records what you actually walked. Keep going file by file. |
| "This item is obviously fine, tick it" | A tick states you checked THIS file against THAT item and can name where you saw the answer. Obvious-looking is what unchecked items look like; check it, then tick it. |
| "I will write the checklist once the file is done" | The block is the record of the walk: each line is written as its verdict is reached, and the file's part file is written before the next file is opened. A block composed afterwards is a summary of what you remember, which is what the ticks exist to replace. |
| "Ticking every item keeps the numbers clean" | The numbers are not the point; what was actually checked is. An unticked item with its reason is a finished, honest walk — an unearned tick is a false claim in a report someone will act on. |
| "jscpd listed nothing, so nothing is duplicated" | jscpd matches copied token runs. Logic written again in other words, and a helper that already exists in a shared folder, reach the review only through the `target.commands.grep` search of cross-file question 1, whose matches are in the file it names. |
| "This jscpd candidate is short / only similar" | A candidate is dismissed only on the grounds cross-file question 1 lists: a dictated shape, parallel data, or the same syntax around different calls and fields. Every other one is a 🔴 High finding, whatever its length or kind. |
| "Reading several files at once saves time" | One file is open at a time (Step 3 point 1). With several files' code in front of you, the walk of each one drifts into a skim of all of them. Only the next file's Reads may ride with the current part's Write. |
| "`OK (pod X#n)` — the other item already reports it" | Code that breaks an item never passes it. When the two items are one requirement in two instructions, the finding names both and both are ticked `NARUSZENIE`; when they are two requirements, each gets its own finding (Step 3 point 3). |
| "One finding per area of the file is tidier — list everything under it" | Each defect is its own finding. Items of one instruction in one `**Reguła:**` are refused by the part check: they are separate requirements, and a merged block reports one of them. |
| "The methods are trivial, the gate fails" | Triviality never fails a gate: a one-line setter is a method and a lone `.next()` call is behaviour. Only a file holding none of the constructs the gate names fails it. |
| "The check refused the part, tick the rest to get through" | The check refuses a false record, never an honest one: `[ ] … — NIEZWERYFIKOWANE: <reason>` always passes. Fix what it names and Write the whole part again. |
