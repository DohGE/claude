---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, a list of branches, or every file under a folder) - checks every changed file against global/local instruction checklists and writes one concise Polish report per branch (interactive HTML by default, Markdown with --only-md) with severity, real line numbers, violated rule and expected result
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
5. Parse the JSON from stdout:
   - Report every `errors[]` entry to the user immediately, in Polish.
   - No targets / exit code 1 → stop after reporting the errors.
   - Report every top-level `warnings[]` entry, in Polish.

## Step 2 — Load the rulebook (once per run)

1. Read the `path` of EVERY entry of `globalInstructions` — the globals at least one reviewed file
   is actually walked against, not every global the skill ships.
2. Read the `path` of EVERY entry of `localInstructionsCatalog` (deduplicated across targets;
   per-file `localInstructions` are INDEXES into this catalog).
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
items are addressed by beside its `path`; number the bullets of every instruction as you read it.
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
Two mechanisms put an item there or leave it out, and both are already resolved in the plan.
A whole instruction is narrowed by `applies-to`: a global that declares one is narrowed by path
exactly like a local, one that declares none still applies to every file, and a pattern starting with
`!` excludes what it matches and always wins over an include. A single item is narrowed by a leading
scope tag — `- {styles} Contrast ratios …` walks only for the file kinds the instruction's `scopes:`
frontmatter maps that name to (an untagged item walks wherever its instruction does). So a plan shorter
than the rulebook is a decision, not an omission — the plan's `globalInstructionsSkipped` names, by
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
  and absent otherwise — that pair, not the diff, is what the naming and location checks compare. A
  path-limited diff renders any rename as a brand-new file, so "the diff shows the whole file as new"
  never means "review the whole file as new" when `status` is `R`. A pure rename changes no content at
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

Clear any stale part files first — `rm -f "<reportPath minus .md>".part*.md` — then write the report
header (Step 4 format) to `target.reportPath`. The report path carries the run stamp down to the
MINUTE, so a second run of the same target inside the same minute lands on the same paths; a previous
run that died between writing its parts and assembling them would otherwise have its leftovers spliced
into this report by the concatenation at the end. Then process EVERY file in
`target.files`, one at a time, in the listed order. The script has already excluded everything
skippable → `target.skipped` (generated, binary, and prose — the label says "wygenerowane/binarne" but
`*.md`, `*.txt`, `*.rst`, `*.adoc` and `LICENSE`-style files go there too), so `target.files` contains
no file you may skip:
no exceptions for renames, formatting-only diffs, tests, configs, file size, diff size, or how many
files remain — the mechanical-change gate narrows what a renamed or reformatted file may REPORT,
never whether it is processed. A file whose `localInstructions` is empty still gets the complete global pass — zero
local matches usually means the file sits outside every dedicated location (the script surfaces
these files in `warnings[]`), not that the file may be skimmed. For each file:

1. Build the file's commands from the target-level `target.commands` templates by substituting
   the file's `path` for the `<path>` placeholder: `commands.diff` shows what changed,
   `commands.show` prints the full content piped through `cat -n` (needs a POSIX shell).
   Status `A` files have no diff — review them from the `show` output alone (every line is new);
   status `D` files have no content — review them from the diff alone. (`commands.diff` is `null`
   for modes without diffs, e.g. folder mode.)
   Fetch contents in BATCHES: one Bash call chains the commands of several consecutive files,
   each preceded by an `echo "=== <path> ==="` marker line, up to ~1,500 output lines per call —
   never one call per file. If a batch's output comes back truncated, re-fetch the missing files
   in smaller batches. Only the fetching is batched — the analysis below stays strictly one file
   at a time.
   `changedLines` (precomputed by the script from `git diff -U0`) is the authoritative list of the
   lines this diff touched, numbered exactly like the `cat -n` output, e.g. `"7, 12-15"`;
   `""` means the diff only deleted lines, `null` means an added/deleted file. Never re-derive
   these ranges from diff hunks yourself.
   While the file's content is open, append its import lines to a running import ledger
   (`importing file → imported module`, one entry per import) — the cross-file layering question
   consumes this ledger after the per-file pass.
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
      import ledger of point 1, the names and literals the file introduces); the one cross-file pass
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
   - code-quality rules (code-quality instruction): duplicated, unnecessary, unused and boilerplate
     code, every comment the diff adds, inconsistency — full 🟡 Medium findings, never nits to skip;
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
   does a different rule broken on the same line. The SAME violation is reported ONCE, under the
   most specific instruction that covers it: a local beats a global, and the specific local beats the
   general one it sits under. A file walking both `component` and `feature-component` gets ONE finding
   for a rule they share, under `feature-component` — not the same violation twice with two `Reguła:` lines.
   Every listed line number is determined at the moment of writing it: locate the offending code
   in the `cat -n` output and cite the number printed there — never diff hunk numbering, never an
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
   `<NN>` running in `target.files` order and zero-padded to the width of the LAST number the target
   will use (two digits up to 99 parts, three from 100 on, counted from `target.files` before the
   first part is written). The assembly below concatenates them through a shell glob, which orders
   them as text: `part100` would land between `part10` and `part11` if the earlier parts were padded
   narrower. Write it with ONE Write call, holding, in this
   order: the file's findings sections, its ticked checklist block, its coverage marker. A file with
   no findings still gets its part file — the block and the marker alone. Earlier parts are never
   edited, and the next file is not analyzed before the current one's part file is written (the
   fetching of point 1 stays batched; only the analysis and this write are per file).
   The checklist block is the file's walk, written down:

       <!-- checklist: <file.path>
       [x] accessibility#3,#10-11,#15-16 — BRAMKA: plik nie buduje DOM ani nie zarządza fokusem
       [x] general#1-5,#7-13 — OK (brak wystąpień)
       [x] general#6 nazwy const camelCase — NARUSZENIE (L12, L18)
       [x] component#1 OnPush — NARUSZENIE (L4)
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
     passing unnoticed, and the fix is the exact word, never ticking a different item instead. (`BRAMKA` and
     `NIEZWERYFIKOWANE` are read by humans only — the `[ ]` box is what records an unverified item.)
   - Collapse only what genuinely shares a verdict. `NARUSZENIE` and `NIEZWERYFIKOWANE` lines carry
     their own reason, so they stay separate — a range is for the OK run around them and for a
     gated-out instruction, never a way to sweep a violation into a neighbour's range.
   - The 2–6 word label in your own words belongs on the lines that need it: `NARUSZENIE`,
     `NIEZWERYFIKOWANE`, and a single-item `OK` worth naming. On a collapsed OK or BRAMKA range the
     address IS the reference — do not spell out thirty rules to say the file has none of them.
   - `[x] … — OK (<where>)` — checked and compliant. `<where>` is where you saw the answer: the
     `cat -n` line numbers you verified (`L12, L18`), or `brak wystąpień` when the rule's subject
     does not occur in the file at all. `brak wystąpień` is a verdict for a PROHIBITION only — for a
     requirement, a missing subject is a finding, never an absence to wave through.
   - `[x] … — BRAMKA: <what is absent>` — the instruction's `gate` failed for this file (point 2),
     so its whole range is ticked in one line. Only an instruction listed in `checklistGates` may
     produce such a line, and the reason names what the file does not contain.
   - `[x] … — NARUSZENIE (L<n>, …)` — checked and broken; the lines are the ones the finding's
     `**Linia:**` carries, and that finding is in this same part file. (Findings from the cross-file
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

After the per-file pass, do ONE cross-file pass over the whole diff for point 3, written as the
final part file. Answer each of these four questions explicitly, against the diff as a whole:
1. Duplication drift — is the same logic, formatting or literal implemented in two or more places
   of this diff, or re-implemented next to an existing shared util? Report every copy the diff adds,
   under the code-quality instruction (🟡 Medium).
2. Layering — walk the import ledger collected in point 1 of the per-file pass, edge by edge: name
   the layer of the importing file and of the imported module, check the edge's direction AND its
   form (barrel vs concrete path, per the architecture instruction) against the architecture
   instruction, and report each forbidden edge at the importing file. A permitted direction does not
   end the edge's verdict — a legal edge taken through the wrong form is still a finding. "No layering
   findings" may be claimed only after every ledger entry has its verdict — an empty ledger means
   the collection step was skipped, not that the diff has no import edges.
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

Assemble the report in ONE Bash call: append every part file to `target.reportPath` (which already
holds the header), remove the parts, and — when `target.htmlReportPath` is not null — render the
HTML report from the assembled Markdown:
`cat "<reportPath minus .md>".part*.md >> "<reportPath>"; rm -f "<reportPath minus .md>".part*.md; node "<SKILL_DIR>/scripts/render-report.cjs" --report="<reportPath>" --project="<PROJECT>" --mode="<target.kind>" --branch="<target.branch>" --base="<target.baseBranch>"`.
The four trailing arguments are what puts a code snippet under every finding: `--project` locates the
reviewed files, and `--mode`/`--branch`/`--base` make the snippet read the same revision the review
read — rendering it as a real `+`/`-` diff for `branch` and `staged`, and as a plain file view for
`folder`. Drop `--base` when `target.baseBranch` is null (staged and folder targets). Without these
arguments the HTML still renders, only without snippets.
The separators are `;`, never `&&`: the renderer must run even if the concatenation found nothing,
otherwise a clean review would silently fall back to Markdown in HTML mode.
Drop the last command when `htmlReportPath` is null (`--only-md` was passed) — the Markdown
is the report then. Otherwise the renderer replaces it with `target.htmlReportPath`; if it prints
warnings it keeps the Markdown too — but a kept Markdown has two very different causes, and only one
of them is yours to fix. `nierozpoznana…`/`nieczytelny…` warnings mean the report really did drift
from the Step 4 format: a line the parser could not read, which costs the HTML that finding or that
tick. A `sprawdzono <checked>/<total>` warning means the opposite — the block parsed perfectly and
simply carries an item you left `[ ] NIEZWERYFIKOWANE`. That one is the format working as intended;
never answer it by going back and ticking an item you did not check.

Coverage gate — before leaving Step 3 for a target: re-read `target.files` and confirm every entry
had its commands run, its part file written, and either all five points covered (point 3
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
    - **Reguła:** <instruction file → checklist item, or the violated point name>
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
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification).
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation, and every code-quality finding (duplicated, unnecessary, unused or boilerplate code, an added comment, inconsistency) — those stay Medium however cosmetic they look.
  - ⚪ **Low** — readability, naming-convention or style drift with no behavioral impact and not covered by the code-quality instruction.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
- When the violated rule is behavioral, **Problem:** names the observable runtime consequence
  (infinite dispatch loop, race condition, subscription leak, crash on null, stale UI) — and
  severity is picked from that consequence, not from the rule's category.
- One finding = one such block = one rule in one file (the splitting rules are Step 3 point 3).
  Separate every block from the next with exactly one blank line, and put one blank line before AND
  after every `##` header — that is what makes each finding render as its own section.
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
  block; the other seven fields follow it as `- ` bullet lines in the order shown. Each field is its
  own line and never continues on the previous field's line. `**Linia:**` holds a comma-separated
  list of numbers and/or `<start>-<end>` spans — one entry per occurrence.
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
For a branch target also name the base it was reviewed against — `target.baseBranch` plus where that base came from, read off `target.baseSource`: `pr` = the target branch of PR #`target.prNumber`, `fork` = the branch it was created from, `candidate` = the default `main`/`master`/`develop`/`dev` detection. Staged and folder targets have no base (`baseSource` is null): a staged review covers the uncommitted changes themselves.
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
