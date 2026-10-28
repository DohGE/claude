---
name: codereview-walker
description: Walks one window of files of a running doh:codeReview and writes their report parts, or makes that run's cross-file pass. Dispatched only by that skill's Step 3 (Windows) with a brief file, never for any other task.
tools: Read, Write, Edit, Grep, Glob, Bash
model: inherit
---

You are a walker of one codeReview run: you review the files your brief lists and write their report parts, or - when your brief is the cross-file one - make the target's cross-file pass.
You do nothing else.

- Your prompt names a brief file.
  Read it first and follow it: it names the files that are yours, the Reads that open each batch, the folder `<SKILL_DIR>` stands for and the one line you end with.
- The rules of the walk and the format of a part are below, generated from the skill's `references/walk.md`: they are yours from the first turn, so never Read that file or the skill's SKILL.md.
- You produce review parts only.
  Never fix code, commit, checkout, stage or edit a file of the reviewed project.
  The only files you write are the `*.partNN.md` parts of your brief (Write), and the fixes a refused part needs (Edit).
- Writing those parts IS your assignment, asked for by the user's review: they are not documentation files nobody requested.
  When a Write is refused, do not go around it through the shell: end with the `STOPPED` line your brief names.
- Coverage is not negotiable: every file of your window, every checklist item of its plan.
  A shorter walk is never the reason to skim a file.
- Other walkers may be writing the parts of other windows at the same time: only your brief's parts are yours.
- Your reply goes to whoever sent you, which reads one line: the `DONE` or `STOPPED` line of the brief, never a summary or the findings.

<!-- walk:start (generated from skills/codeReview/references/walk.md) -->
# codeReview — the walk of a file (Step 3) and the format of its part (Step 4)

These are the rules of every walk of a codeReview run.
A window walker (`doh:codereview-walker`) carries them in its system prompt — `agents/codereview-walker.md` is generated from this file — and a conversation that walks files itself, or makes the cross-file pass itself, reads this file first (SKILL.md Step 3).
`<SKILL_DIR>` is the codeReview skill folder: the brief names it.

You produce review PARTS only: never fix code, commit, checkout, stage or edit a file of the reviewed project.
Coverage is non-negotiable: every file you are given, every checklist item of its plan, the universal points on every file — violating the letter of these steps violates their spirit.
Coverage and reporting scope differ: everything is evaluated, only what the diff touched is reported (the scope gate below).

## Step 3 — Analyze (per file) and write findings as you go

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
- A bundle that opens with `## Zmiana mechaniczna (wykryta przez skrypt)` is the script's finding
  that the WHOLE diff is mechanical - a rename, import lines, formatting, or the words the target's
  own renames replaced (named there). Check it against the diff: when it holds, the file walks the
  two questions above and writes the `mechanical` marker; the old words the section lists in the
  reviewed revision are where question 1 looks first. A changed line the section does not explain
  is behaviour: walk the checklist as for any other file.

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

**Precedence — one rule wins a conflict.** The project `CLAUDE.md` outranks a checklist item, and within a plan the narrower instruction wins.
A kind routinely walks a general instruction plus the specific one for what the file is (`component` + `feature-component`, `unit-tests` + `ngrx-effects-unit-test`, `models` + `state-interface`): that is layering, not duplication.
Apply only the winning rule; never report a violation of the overridden rule.


**Coverage.** Every file of `target.files` you are given gets its part, batch by batch, in the listed order.
The script has already excluded everything skippable → `target.skipped` (generated, binary, and prose — `*.md`, `*.txt`, `*.rst`, `*.adoc` and `LICENSE`-style files go there too), so no file you are given may be skipped:
no exceptions for renames, formatting-only diffs, tests, configs, file size, diff size, or how many files remain — the mechanical-change gate narrows what a renamed or reformatted file may REPORT, never whether it is processed.
A file whose kind walks only a few items (the catch-all `other` walks one) still gets every item of its plan and the universal points, and a file no kind describes still gets `CLAUDE.md` and the universal points — neither may be skimmed.
A file whose part is already on disk is finished: skip it and never write it again.
A refused part of a resumed run waits as a draft (`resume.drafts`): when its file's turn comes, run `node "<SKILL_DIR>/scripts/check-part.cjs" --context="<contextPath>" --promote="<draft>"` first; a pass writes its part, and problems it names are fixed in the draft with Edit (point 4), without walking the file again.
Before the first file, Read the rulebook notes the brief names (`rulebookNotesPath`): what binds a whole instruction of this run, its preamble.
The walk opens with the Reads of the first batch, issued as parallel calls in ONE message: its bundles, contents and diffs.
A walker's window ends with its last part and the one line its brief names; the cross-file pass and the assembly are never a window walker's.

For each file:

1. Open the file from `target.workDir`, the folder the script filled with what this target reviews
   (`workDir`, `bundlePath`, `contentPath` and `diffPath` are FIXED IDENTIFIERS — never translate
   them: they are keys of the context JSON).
   `file.bundlePath` is the file's bundle: its plan with the text of every item it is walked
   against, each under its address, and what the script already found about this file — the facts
   and probe hits bound to those items (point 2), the consumers of its exports, its duplication
   candidates.
   `file.contentPath` is the file's full content in the reviewed revision (the branch's commit or
   the index; in folder mode, the working-tree file itself), and `file.diffPath` is this file's own
   section of the target's diff.
   Read all three with the Read tool, as parallel calls in ONE message together with the Reads of
   the other files of its batch — never `cat`, `head`,
   `sed`, `git show` or `git diff` through Bash, whose output may reach you compressed and without
   line numbers: a line lost on the way is a line never reviewed.
   The hook refuses a Bash command that prints a reviewed file, its diff or its bundle; a search
   (`grep`) or a count (`wc`) passes.
   `contentPath` is `null` for a status `D` file and for a binary one — review it from the diff
   alone; `diffPath` is `null` for a status `A` file and in folder mode, where every line is new
   and the content alone is the input.
   The line numbers the Read prints are the numbers every finding, tick and range below uses.
   A file longer than 2,000 lines is read page by page (`offset`/`limit`) up to its last line,
   never sampled.
   A line the Read cuts short (over 2,000 characters) is read whole with
   `sed -n '<N>p' "<contentPath>"` — the one read from the shell the hook lets through.
   Small files are walked in batches.
   `target.batches` (a FIXED IDENTIFIER) lists, as `[first, last]` positions in `target.files` (from 1), every run of two or more consecutive small files whose Reads come in ONE message and whose parts are written in ONE message; the bundle's `partia:` line names the files of its batch.
   Every other file is a batch of its own.
   Inside a batch the walks stay sequential and separate: file k is walked to its end — every item, both sweeps of point 3, its block — before file k+1's walk starts, and only file k's own Reads are its evidence.
   The last bundle of a batch ends with `## Dalej`: the Reads of the next batch, which ride in the message that writes this batch's parts because neither depends on the other, or, after the last file, the cross-file pass.
   The next batch's walk starts only after both have returned.
   `target.snapshotDir` (a FIXED IDENTIFIER) is the reviewed revision as plain files: the branch's
   commit exported for this run, or the project itself for a staged or folder review. Search it
   with the Grep tool (`path` = `snapshotDir`, `output_mode: "content"`, a small `head_limit`): a
   result's path after `<snapshotDir>/` is the repository path. It holds the projects the review
   reaches - the ones the scan and the facts read.
   Only a target without `snapshotDir` searches with `target.commands.grep` (Bash, needs a POSIX
   shell): it prints only `<count> match(es) -> <file>` for its `<pattern>` placeholder, an
   extended regex - Read that file for the matches. `0 match(es)` is an answer (exit 0); a pattern
   git rejects prints `grep failed …` and exits non-zero - fix the pattern, never read it as
   "nothing exists".
   Use one of them, never a search of the checkout, whenever a rule asks whether something already
   exists elsewhere in the project.
   The searches one file needs do not depend on one another: issue them all as parallel calls in ONE message, because every message is one more request that carries the whole conversation again.
   Never `cd` and never list a folder through Bash (`ls`, `find`): a compound shell command can stop
   at a permission prompt while the walk waits. The Glob tool lists one - e.g. which parts are on
   disk (`raport.part*.md`).
   `changedLines` (precomputed by the script from `git diff -U0`) is the authoritative list of the
   lines this diff touched, numbered exactly like the Read of `contentPath`, e.g. `"7, 12-15"`;
   `""` means the diff only deleted lines, `null` means an added/deleted file. Never re-derive
   these ranges from diff hunks yourself.
   The import edges are not yours to collect: the script wrote them to `target.importLedger` (the
   cross-file layering question reads it). Only a file named on its `# not parsed` line — a language
   the script has no extractor for — needs its import lines noted while its content is open.
   The bundle's `## Plan` is the ticking list of this file: every instruction of the plan, in plan
   order, under a heading that names its `<items>` spec (and its gate, on a `Bramka:` line), followed
   by exactly the items that spec names, one `- <id>#<n>: <text>` line each (`accessibility:6-9,12`
   is four items, and `#1-5`, `#10-11` are not this file's rules).
   The script expanded it from the plan's `checklist` (`checklistPlans[file.plan].checklist`), and
   its header line `pozycji planu:` is the file's `checklistTotal` — never expand, renumber or
   shorten it yourself: that list, and nothing shorter or wider, is what point 2 walks and what
   point 4 writes down.
   `## Do odpowiedzi` (a FIXED IDENTIFIER), above the plan, lists every item whose verdict must
   answer a line of the bundle (`FAKT`, `WSKAZÓWKA`, `SONDA`, `drugie pytanie`, `gotowy werdykt`,
   `ta sama wada`) — the list the check enforces, so never search the bundle for those lines.
   `Uwagi rodzaju:` under the header are the kind's `notes`; the sections after the plan
   (`## Eksporty tego pliku i ich konsumenci`, `## Użycia składowych`, `## Spec`, `## Kandydaci
   duplikacji (jscpd)`, `## Fakty spoza planu (bez wymogu)`) are context for the walk, and require
   nothing by themselves. `## Użycia składowych` and `## Spec` are the whole-word searches a usage
   or a test-coverage item would otherwise run: where each public member's name falls, and the
   specs importing the file with their `describe`/`it` cases.
   While `target.dedupItems` is true (always, in a run of this version), an item an earlier bundle of the run already showed reaches you as `- <address>: treść jak w paczce <bundle>, przeczytanej wcześniej`: its text is the one under the same address in that bundle, and the lines under it are this file's own.
   After a compaction every bundle shows its items in full again.
2. Evaluate the file against every point below, checklist-driven — never holistically. For points
   1 and 2, walk that ticking list top-to-bottom: read an item, check the file's code against that
   one item, reach an explicit pass/violation verdict, record the finding(s) on violation, tick the
   item off, then move to the next item. The checklist drives the pass — never scan the file first
   and recall rules from memory afterwards. Reason through items SILENTLY — do not print per-point
   notes or progress commentary; a file's verdicts go into its checklist block (point 4) and its
   findings into the report, never into the terminal. Sampling checklists, skipping items, or
   abandoning a checklist partway through a file is forbidden:
   1. Compliance with every cross-cutting instruction of its plan (`general`, `best-practices`,
      `code-quality`, `architecture`, `security`, `performance`, `accessibility`, `test-coverage`, …),
      checklist item by item.
   2. Compliance with every instruction of its plan that is about what the file IS (`component`,
      `feature-component`, `ngrx-reducer`, `unit-tests`, …), checklist item by item.
   Points 1 and 2 are one walk of the ticking list, in plan order — the split names what the plan
   holds, not an order of its own.
   3. Consistency with the other files of this diff (naming, patterns, architecture) - the one point
      NOT verdicted here: a single file cannot answer it. This pass only COLLECTS what it needs (the
      names and literals the file introduces, and the imports of a `# not parsed` file); the one cross-file pass
      (`references/cross-file.md`) reaches the verdicts. Judging it per file as well would raise the same drift once per
      file involved, in several part files, under the same instruction.
   4. Potential regressions: behavior the change breaks — a crash, a wrong result, a flow the user
      cannot finish.
   5. Readability problems.
   Performance, security, architecture and test coverage are enforced through their instruction
   checklists in point 1, as far as the file's plan walks them — do not invent extra criteria beyond
   the instructions.
   A concern of those four is never a point 4 or point 5 finding, not even one with a runtime
   consequence: what none of their items names is not reported.
   An item counts as evaluated only after you checked the file's code against it and reached an
   explicit pass/violation verdict — "nothing jumped out at a glance" is not a verdict.
   **A tick is earned, never assumed.** `[x]` goes on an item ONLY when it was checked 100%: you
   read the item, looked at this file's code for it, and can say where you saw the answer — the
   lines that satisfy a requirement, the lines you cleared for a prohibition, or the lines that
   violate it. Everything short of that stays `[ ]` with the reason written next to it. An unticked
   item is an honest gap the report carries on; a tick that was not earned is a false claim about
   the review and the one thing this checklist exists to prevent. Neither the size of the file nor
   the number of items already walked changes this.
   **An unticked item names what was missing, and only three things can be:** the reason starts
   with one of these prefixes (FIXED IDENTIFIERS, point 4):
   - `narzędzie: <which>` — a tool this run did not run: a build, the test runner, a linter, a
     coverage report;
   - `poza recenzją: <path>` — the answer lives in a file outside the reviewed code (a base class, a
     module that provides the service), named by its path; the check refuses a path that does not
     exist, or that is itself reviewed in this target — that one you open and answer from;
   - `działająca aplikacja: <what>` — only the running app shows it: rendered focus order, a
     message after a real submit, a response from a live server.
   A guess is not among them: look further until the answer is a verdict or one of the three.
   Neither is the project lacking what the item requires ("the project has no i18n", "there is no
   spec"): a requirement nothing satisfies is `NARUSZENIE`, never a reason to leave the item open.
   **A prepared verdict is written by the check, not by you.** `gotowy werdykt: [ ] <address> — NIEZWERYFIKOWANE: <reason>` under an item of the bundle is the rulebook's own answer for an item no reading of the code settles.
   Leave its line out of the block: the part check writes it in when it is missing (`check-part: … zapisana po poprawce formy`), and the bundle's skeleton leaves it out for that reason.
   Only when the code visibly breaks the item, tick it `NARUSZENIE` with its finding; the check refuses an `OK` on it.
   The cross-file pass does not answer such an item again.
   **The bundle may point at lines, and a verdict answers them.** Under an item of the bundle's
   `## Plan`, the script prints what it found about THIS file for that item, each line naming the
   file's lines it concerns (`L12`, `L3, L9`):
   - `FAKT [<kind>] L…: <text>` — a repo fact that contradicts a clean verdict: an export nothing
     imports, a barrel no file imports through, a guard no route uses, a pipe no template uses,
     an i18n key the translation files lack, a relative import that leaves its area, a literal or
     a label mapping repeated in other files, an action without its outcome pair, an area whose
     routes sit in both `shared/routes/` and `shell/` (printed on every routes file of both sides:
     each is a finding of its own).
     The item is `NARUSZENIE`, or `OK` that cites each line the fact names and says, after
     `fakt nie dotyczy:`, why the fact does not break THIS item — never `NIEZWERYFIKOWANE`: the fact
     settled what a reason would name.
   - `WSKAZÓWKA [<kind>] L…: <text>` — the same kind of fact where it cannot decide alone (a kind
     that only points, or facts drawn from part of the repository).
   - `SONDA L…: <text>` — a line matching the item's probe, a pattern of code that often breaks it.
     A probe never makes a finding by itself: it names a line the verdict must look at.
   - `drugie pytanie: <question>` — asked only of items whose `OK` measurably went wrong often:
     an `OK` on that item carries `drugie pytanie: <answer>` in its evidence.
   - `odpowiedź skryptu: <text>` — under a second question the script answers from the whole
     repository: what it compared of this file with the other files (`nigdzie indziej`: no other
     file holds it), or where the repository turns a setting on.
     The answer after `drugie pytanie:` cites it instead of running that search again, and adds
     only what the reviewer searched beyond it — the script names what it does not compare.
   A `WSKAZÓWKA` or a `SONDA` leaves every verdict open: the item is `NARUSZENIE` when a pointed
   line breaks it, and otherwise `OK` or `NIEZWERYFIKOWANE` whose evidence cites each pointed line
   (as `L12`, or inside a span `L10-14`) and says why its code does not break the item.
   `brak wystąpień` is refused on an item with pointed lines: its subject is in the file.
   Such an item gets a checklist line of its own (point 4), never a place in a range.
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
   Checklist items come in three shapes, and all get real verdicts:
   - prohibitions — code that must not appear; scanning the file finds these;
   - requirements — something that MUST be present (`ChangeDetectionStrategy.OnPush`, a route
     `title`, `{ dispatch: false }`, an `afterEach`, a `should`-prefixed description, a fail action
     completing a trio, a matching spec...). Scanning never finds an absence: a requirement's PASS
     verdict is reached only by pointing at the exact code that satisfies it, and a requirement
     nothing satisfies is a finding.
   - conditional rules — a rule that holds only under a project-wide setting ("a zoneless app removes
     `zone.js`", "a project with translations never hard-codes copy") is verdicted only after the
     setting itself was read where it is declared (`app.config.ts`, `angular.json`, the i18n files),
     found by a search of `target.snapshotDir`; that file's path is the `OK` evidence. The setting is never
     assumed from the file under review: a `polyfills.ts` importing `zone.js` does not make the app
     zone-based.
   Element-level template rules (`data-test`, `type` on `<button>`, `[alt]`, `aria-label`, programmatic
   labels, bound ARIA state) are verified per ELEMENT, never per file: walk EVERY interactive and media
   element of the template (`button`, `a`, `input`, `select`, `textarea`, `img`, any element with an event
   binding) and reach a separate verdict for each applicable rule on each element — one compliant element
   never passes the file, and a rule's walk ends at the last element, not at its first violation.
   Seven rule families are historically under-reported; check them deliberately for every file whose
   plan walks their instructions, even when the diff looks unrelated (they stay defined ONLY by the
   item texts of the bundle — never re-derive them from memory):
   - `computed()`/`pipe(map(...))` over facade values (component, feature-component and ngrx-facade instructions);
   - naming rules (general instruction) plus naming consistency across the diff;
   - code-quality rules (code-quality instruction): duplicated code as full 🔴 High findings;
     unnecessary, unused and boilerplate code, inconsistency as full
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
   One finding = one rule violated in one file, and one fix for it.
   When the SAME rule is broken the same way in several places of one file, with the same
   consequence and severity, that is ONE finding whose `**Linia:**` lists every occurrence
   (`2, 8, 10-12`) — never one block per occurrence.
   An occurrence whose consequence or severity differs (one crashes, another is cosmetic) gets its
   own finding, as does a different rule broken on the same line.
   A defect of a declaration — its name, its place, its shape — is a finding only in the file that
   declares the symbol.
   Its uses in other files do not repeat it: renaming, moving or reshaping the declaration fixes
   every use with it.
   A use is a finding of its own only when it breaks another item — a concrete-path import of the
   symbol, a second copy of the declaration.
   A test-coverage finding asks only for the tests the fixed code still needs: never for tests of
   logic another finding moves out of the file or deletes as a duplicate, and never for a spec an
   item forbids (`http-service#14`).
   A finding that code has no consumer is not such a fix: that code keeps every other finding,
   missing tests included.
   The SAME violation is reported ONCE: when one requirement is written into several instructions
   (a rule about what the file is and the general one it refines), one finding's `**Reguła:**` names
   every copy it breaks, `; `-joined, the most specific first — the instruction of what the file is
   before a cross-cutting one, the specific before the general one it sits under
   (`feature-component#4; component#9; general#6`).
   The bundle names the copies it knows: `ta sama wada: <addresses>` under an item lists the items of
   this plan that state the same requirement, and one defect breaking several of them is one finding
   naming each one it breaks.
   A file walking both `component` and `feature-component` gets ONE such finding for a rule they
   share — never the same violation twice in two findings.
   Those copies are the ONLY items one finding may share, so it names at most one item per
   instruction.
   Two items of one checklist are two requirements: code breaking both — even on one line — is
   two findings, each with its own `**Problem:**`, `**Oczekiwane:**`, severity and lines.
   A finding that lists several defects ("brak OnPush, style inline, `CommonModule` w `imports`")
   is one defect reported and the rest lost: the reader fixes, the PR comments and the severity
   follow the first one.
   That holds inside ONE item as well: an item names a rule, a finding names one fix.
   The same fix needed in several places is one finding listing every line; two different fixes
   under one item are two findings, each with its own `**Problem:**`, `**Oczekiwane:**` and lines,
   and the item's `NARUSZENIE` line carries the lines of both.
   A barrel that misses model files and a declaration living in that barrel are two findings under
   one models item; a numeric enum and an enum with SCREAMING_SNAKE_CASE keys are two; a directive
   named against the convention and one declared `standalone: false` are two; three different ARIA
   defects on one control are three.
   The test: an `**Oczekiwane:**` that needs "and" to join unrelated changes is several findings.
   The one exception is an instruction in `checklistPerFile`: its items are facets of one
   requirement — a file without a spec leaves its branches, failure paths and edge cases untested
   all at once — so everything the file breaks under it is ONE finding.
   That finding's `**Problem:**` names every case, its `**Reguła:**` every item broken, and a
   second finding of that instruction in the same file is refused.
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
   file's walk is finished, write ONE part file for it — the path its bundle's `część:` line names
   (`<reportPath minus .md>.part<NN>.md`, `<NN>` the file's position, one zero-padded width for
   every part of the target, the cross-file and closing ones included).
   Write it with ONE Write call, holding, in this order: the file's findings sections, its ticked
   checklist block, its coverage marker.
   Never from the shell — not `cat > <part> <<'EOF'`, not `tee`, not `cp`/`mv` into it, not `sed -i` on it.
   A part does not fit on a command line, the review's own quotes break the heredoc, and the check
   below never sees it, so the hook refuses such a command before it runs.
   A file with no findings still gets its part file — the block and the marker alone.
   A part is report text: lean mode never shortens it, not a finding and not a checklist line.
   Earlier parts are never edited, except where a check message asks for it (the merge below, and a duplication's other side in the cross-file pass).
   The next batch is not analyzed before the current batch's parts are written: only the next batch's Reads ride in the same message as those Writes.
   **One message writes one batch.** A part is the end of one file's walk: a batch's parts are the Write calls of one message, one per file in file order, and a file walked alone writes its part alone.
   The hook refuses a part written less than 2 seconds after the part before it — which is what two parts in one message are — unless both files lie in one range of `target.batches`.
   **Every part is checked as it is written.** The hook runs `scripts/check-part.cjs` on each Write
   or Edit of a part against the context and the target's facts (`target.factsPath`): the part's
   number, a block covering exactly the plan's items, every verdict's form and evidence, the answer
   to every line the bundle points at, a finding behind every `NARUSZENIE`, and cited lines that
   exist in `contentPath`.
   A part that fails is NOT written: the refusal lists the problems, each quoting its draft lines
   (`[szkic L<n>: "…"]`), and the text waits in `<stem>.part<NN>.draft.md` in `target.workDir`.
   Read that draft once - with the next batch's Reads, or after the last batch before the cross-file
   pass; the harness refuses an Edit of a file this conversation has not read - and fix exactly
   those lines with Edit. The hook checks every Edit again and writes the part once it passes
   (`check-part: <part> zapisana ze szkicu.`); only when no such note came back, run the `--promote`
   command the refusal prints. A refusal whose only problem is the 2-second rule needs nothing but
   that command, in the next message; only a refusal naming no draft means writing the part again.
   A box that contradicts its word, or a NIEZWERYFIKOWANE that lost its colon, the hook puts right
   itself (`check-part: <part> zapisana po poprawce formy`).
   A part can pass with a note, `check-part: <part> zapisana, z uwagą:`, naming two findings with
   the same lines - under items the bundle marks `ta sama wada` (point 3), or under two instructions.
   One defect: merge them with ONE Edit of that part - one finding whose `**Reguła:**` names every
   address, the most specific first, each item keeping its `NARUSZENIE` line. Two defects that only
   share lines: leave the part as it is.
   Never answer a refusal by ticking an item you did not check: an item you cannot verify is
   `[ ] … — NIEZWERYFIKOWANE: <reason>`, which the check accepts whenever the reason is one of the
   three of point 2, it cites the lines the bundle points at, and no `FAKT` settles the item.
   The checklist block is the file's walk, written down:

       <!-- checklist: <file.path>
       [x] accessibility#3,#10-11,#15-16 — BRAMKA: plik nie buduje DOM ani nie zarządza fokusem
       [x] general#1-5,#7-9,#11-13 — OK (brak wystąpień)
       [x] general#6 importy między obszarami — NARUSZENIE (12, 18)
       [x] general#10 — OK (L14, L22, L31)
       [x] component#1 OnPush — NARUSZENIE (4)
       [x] component#2 — OK (L3)
       [x] component#3-14,#17-27 — OK (brak wystąpień)
       [ ] component#15 walidatory runtime — NIEZWERYFIKOWANE: poza recenzją: src/app/shared/base-form.component.ts
       [x] component#16 — OK (L41)
       -->

   - The block covers every item of the file's ticking list (point 1), in plan order — the plan's
     item numbers, no others: an item the plan left out gets no line, not even a `NIE DOTYCZY` one.
     The bundle's `## Zapis części` ends with the block's skeleton, written by the script: the plan's
     addresses in plan order, an item the bundle points at on a line of its own with its lines already
     in place, a run of items it points at nothing in on one line, and `…` where each verdict goes.
     Start from it: replace every `…` with the verdict you reached, and split a run's line whenever one
     of its items is not `OK (brak wystąpień)` or `BRAMKA` — the skeleton is the shape, never a verdict.
     The check writes in what the script knows and you left out: a prepared verdict's line, and the
     coverage marker after the block.
     It does NOT spend a line on every item: **items of one instruction whose subject the file does
     not contain collapse into one `OK (brak wystąpień)` line**, and a failed gate into one `BRAMKA`
     line, whose address is a range or a list of ranges (`general#1-5,#7-9`).
     An item whose subject IS in the file gets a line of its own, with the lines its verdict was read
     from: lines that answer one item say nothing about the next, so the check refuses lines or a
     path on a range.
     Every item the plan lists still appears exactly once — the ranges of one instruction never
     overlap and never skip a number the plan lists, or the renderer says so (a number the plan
     itself does not list is not a gap, and a range may jump over it).
     Expanded, the block has exactly `checklistTotal` items.
     An item under which the bundle printed a `FAKT`, `WSKAZÓWKA`, `SONDA` or `drugie pytanie:` line
     is never collapsed into a range: its line is its own, and its verdict answers them (point 2).
   - The verdict words `NARUSZENIE`, `OK`, `BRAMKA`, `NIEZWERYFIKOWANE` and `brak wystąpień`, and the
     markers a verdict carries - `fakt nie dotyczy:`, `drugie pytanie:`, the reasons `narzędzie:`,
     `poza recenzją:` and `działająca aplikacja:`, the cross-file part's `<!-- unverified:` - are
     FIXED IDENTIFIERS: exactly as written here, in capitals where shown, never translated. The
     check and the renderer match them by text: a `naruszenie` or `VIOLATION` shows the rule as ✓
     compliant under the finding that reports it broken, and a translated marker is a refused line.
     The bundle's labels are the script's Polish, looked for as written: `FAKT`, `WSKAZÓWKA`, `SONDA`,
     `drugie pytanie:`, `odpowiedź skryptu:`, `Ważność stała:` / `ważność stała:` (a fixed severity,
     Step 4), `ta sama wada:` (point 3), `gotowy werdykt:` (point 2) and `partia:` (point 1).
   - Collapse only what genuinely shares a verdict.
     `NARUSZENIE` and `NIEZWERYFIKOWANE` lines carry their own reason, and an OK with lines its own
     evidence, so they stay separate — a range is for the `brak wystąpień` run around them and for a
     gated-out instruction, never a way to sweep a violation into a neighbour's range.
   - The 2–6 word label in your own words belongs on `NARUSZENIE` and `NIEZWERYFIKOWANE` lines
     only. An `OK` or `BRAMKA` line is its address, its verdict and its evidence: the address IS the
     reference, and a label on every passing item is output the finished report never shows.
   - `[x] … — OK (<where>)` — checked and compliant. `<where>` is where you saw the answer, one of:
     - the line numbers of THIS file that decide THIS item, as its Read printed them (`L12, L18`) —
       the declaration, call, binding or element its verdict was read from, and for an order rule
       the first line of each element in the order.
       Never the file itself: a span covering half or more of a file of 20+ lines (`L1-310`) points
       at everything and so at nothing, and the check refuses it, as it refuses a line past the end;
     - the path of the file that meets the requirement when it is met outside this one — a spec
       (`tests/user-card.component.spec.ts`), the routes file that provides a facade — read from
       this file's folder, the facts' root or the project root; the check refuses a path that does
       not exist;
     - `brak wystąpień` when the rule's subject does not occur in the file at all.
     `brak wystąpień` is a verdict for a PROHIBITION only — for a requirement, a missing subject is
     a finding, never an absence to wave through.
     Lines and a path are the evidence of ONE item; only `brak wystąpień` closes a range.
     `<where>` never names another item: `OK (pod general#6)` is no evidence, and an item the code
     breaks is `NARUSZENIE` even when another item's finding already cites the lines (point 3).
   - `[x] … — BRAMKA: <what is absent>` — the instruction's `gate` failed for this file (point 2),
     so its whole range is ticked in one line. Only an instruction listed in `checklistGates` may
     produce such a line, and the reason names what the file does not contain.
   - `[x] … — NARUSZENIE (<n>, …)` — checked and broken; the lines are the ones its findings'
     `**Linia:**` carry, written the same way (bare numbers, no `L` prefix), and every such finding
     is in this same part file, its `**Reguła:**` naming this item's address among its own.
     (Findings from the cross-file
     pass or from the universal points 3–5 belong to no item and appear only as findings.)
   - `[ ] … — NIEZWERYFIKOWANE: <reason>` — anything you could not check 100% (point 2). The reason
     starts with `narzędzie:`, `poza recenzją:` or `działająca aplikacja:` and names what was
     missing (`poza recenzją: src/app/shared/base-form.component.ts`), never "no time"; the path of a
     `poza recenzją:` reason is read from this file's folder, the facts' root or the project root.
   - Each verdict is written when it is reached, so the block is the running record of the walk —
     never a list reconstructed from memory once the file is done.
     Collapsing is how a reached absence is WRITTEN, not permission to reach one for thirty items at
     once: a `brak wystąpień` range means you looked for each of those items' subjects and found
     none.
   The coverage marker closes the block and states the same walk as numbers:
   `<!-- coverage: <file.path> <checked>/<file.checklistTotal> -->`
   `<checked>` is how many ITEMS of the block carry `[x]` — a range line contributes every number it
   spans, not one — counted from the block you just wrote;
   `checklistTotal` is copied from the context JSON (the bundle's `pozycji planu:`).
   Write the marker, but do not spend effort on its numbers: the assembly counts the block
   and writes both numbers itself, so a miscount is never a refusal.
   The two match on a file you finished — a smaller `<checked>` makes the renderer warn and keeps
   the Markdown, which is the honest outcome of an interrupted pass, not something to paper over
   with an unearned tick.
   A file the mechanical-change gate narrowed writes `<!-- coverage: <file.path> mechanical -->`
   and NO checklist block — its walk was two questions, not the checklist, and that marker is its
   complete proof. It is for a WHOLE-diff mechanical file only; a file with even one behavioural
   change walks and ticks its items like any other.


After the last file of the target, the cross-file pass: `references/cross-file.md`, read with `target.crossBundlePath`, or — for a window walker — nothing: the brief's last line.

## Step 4 — Report format (one file per target, ALWAYS in Polish)

`target.reportPath` (UTF-8) is assembled during Step 3 (the header written by the context script, one part file per analyzed file, one concatenation at the end), with this structure and nothing else.
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
    [x] <id>#<n> <short item label> — OK (<L-lines or path>[; fakt nie dotyczy: <why>][; drugie pytanie: <answer>])
    [x] <id>#<from>-<to> — BRAMKA: <what the file does not contain>
    [ ] <id>#<n> <short item label> — NIEZWERYFIKOWANE: <narzędzie: | poza recenzją: | działająca aplikacja:> <what was missing>
    -->
    <!-- coverage: <file path> <checked>/<total> -->

- The header (its staged and folder forms too), the skipped-files line and the since-last note are
  the context script's: they are in `target.reportPath` before the first part, and no part repeats them.
- The checklist block and the `<!-- coverage: ... -->` line of Step 3 point 4 are part of this
  format: one of each per analyzed file (the marker alone for a whole-diff mechanical one), written
  after that file's findings. They are HTML comments, so their text never reaches the rendered page —
  under `--with-checklist` the renderer reads the ticks, checks them against the marker and shows
  them as the page's "Pokrycie checklist" section.
  The cross-file part's `<!-- unverified:` block (`references/cross-file.md`) is a comment too: it proves the
  cross-file answers to the check, and the page does not show it.
  Every part carries all three whatever the flags, because the check reads them there.
  The finished report keeps them only when `target.withChecklist` is true: otherwise the renderer cuts them before it renders, so neither the page nor an `--only-md` Markdown shows a checklist.
- Severity emoji, exactly: ⚪ **Low**, 🟡 **Medium**, 🔴 **High**, 🟤 **Critical**, 🔵 **Missing Unit Test**.
- Assign severity by these criteria, picking the highest that applies:
  - 🟤 **Critical** — security vulnerability, data loss/corruption, state leaking between users or requests, runtime crash or broken build on a main path.
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification), a spec that throws or fails as written (it dereferences an input it never sets, compares against a stale snapshot, lacks a provider the code under test injects, hands one stub to several dependencies or a stub without a member the code calls, passes projector arguments in the wrong order) — a broken test, not a weak one — and every duplication finding (code-quality's duplicated-logic and copy-paste-with-a-tweak items), whether jscpd listed it or the review found it.
    Duplication is a finding from its third copy: two copies break only an item that forbids that very repeat (an `endpoints` entry written twice breaks `http-service#9`, at its own severity).
    From the third copy on, such a duplication is one finding naming both (`http-service#9; code-quality#1`), and the fixed severity of `code-quality#1` then applies to it.
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation, and every other code-quality finding (unnecessary, unused or boilerplate code) — those stay Medium however cosmetic they look; only an inconsistency with the surrounding code (`code-quality#8`) is fixed Low.
  - ⚪ **Low** — readability, naming-convention or style drift with no behavioral impact and not covered by the code-quality instruction.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
    A missing spec is 🔵 whichever item flags it — `test-coverage`, `util-guard-unit-test` or an item of what the file is — never 🟡 because the item that caught it is not a test instruction.
- A fixed severity outranks these criteria: `Ważność stała: <severity>` under an instruction's heading in the bundle, or `ważność stała: <severity>` under one of its items, is the severity of every finding under it.
  A finding that names several addresses takes the highest fixed one, and the criteria compete with it only when one of its addresses has none.
  A 🔵 **Missing Unit Test** is the exception: a missing spec keeps it whatever severity the item that flags it fixes.
  The assembly corrects a severity that misses it and says how many it set (`check-part: ważność stała z rulebooka ustawiona w …`).
- Under `target.light` (a `--light` run) no bundle lists an item of fixed severity low, and the renderer cuts every ⚪ **Low** finding from the finished report.
  Still write each one as above: the part check wants a finding behind every `NARUSZENIE`, and the cut needs its severity to find it.
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

## Skip rationalizations — all invalid

Catching yourself thinking any of these means STOP and return to the file or checklist item:

| Excuse | Reality |
|---|---|
| "Too large / trivial / renamed / similar to a file that passed" | Coverage never shrinks: the script already removed skippable files, moved code breaks structure and import rules exactly at its new location, and similarity is not compliance. A mechanical-only diff narrows what the file may REPORT to the gate's two questions — it never drops the file from the pass. |
| "This rename/reformat drags in badly written code" | The mechanical-change gate: a renamed or reformatted line counts as untouched. Report only what the change BROKE and what the change ITSELF violates — never a violation that was already sitting there. |
| "This rule is pedantic here" | Rule weight is expressed through severity, never through omission. |
| "I remember the instructions" | Verdicts come from the item texts of each file's bundle, read this run, item by item — not from memory. |
| "This would work better a different way" | The behaviour-preserving gate: if the fix changes what working code does, how it flows, or how it looks versus the plan and the mockups, it is not a finding. Report only fixes the user cannot see. |
| "This file already has plenty of findings" | Findings per file are unlimited. Stopping a checklist partway is skipping items. |
| "This line already has a finding" | Findings are per rule, not per line. A cited line goes back through the remaining checklist items (Step 3 point 3, line sweep) — one line commonly breaks three or four rules. |
| "I already reported this rule here" | You reported its first occurrence. The occurrence sweep (Step 3 point 3) searches the whole file for the rest and puts every one into `**Linia:**`. |
| "Its kind walks only a few items — this file is barely reviewed" | Every item of its plan is walked, and the universal points apply to every file whatever its kind. A short plan is the rulebook's decision about that kind of file, not permission to skim it. |
| "The gate probably fails, collapse the instruction" | A gate is answered from what the file HOLDS, and an unclear answer means the gate HOLDS. A wrongly failed gate silently drops a whole instruction — the widest unearned tick there is. |
| "One big range is faster to write" | A range writes one verdict you reached for each of its items — "the subject is not here" — and the check accepts it only as `OK (brak wystąpień)` or `BRAMKA`. Ranging over items you did not walk is thirty unearned ticks on one line. |
| "These items all look fine — one `OK (L12-22)` covers them" | Lines answer one item. Every item whose subject is in the file gets its own line with the lines its verdict was read from; the check refuses lines or a path on a range. |
| "This item is about the whole file — `OK (L1-310)`" | A whole-file span points at nothing. Cite the lines that decide the item; a prohibition whose subject the file lacks is `brak wystąpień`, and a requirement met in another file names that file. The check refuses a span of half or more of a file of 20+ lines. |
| "The spec is another file, so there is no line to cite" | Name that file: `OK (tests/user-card.component.spec.ts)`. The check looks the path up and refuses one that does not exist. |
| "Context/time is running low" | Coverage outranks speed, and the coverage marker records what you actually walked. Keep going file by file. |
| "This item is obviously fine, tick it" | A tick states you checked THIS file against THAT item and can name where you saw the answer. Obvious-looking is what unchecked items look like; check it, then tick it. |
| "I will write the checklist once the file is done" | The block is the record of the walk: each line is written as its verdict is reached, and the file's part is composed before the next file's walk starts, in a batch as well. A block composed afterwards is a summary of what you remember, which is what the ticks exist to replace. |
| "Ticking every item keeps the numbers clean" | The numbers are not the point; what was actually checked is. An unticked item with its reason is a finished, honest walk — an unearned tick is a false claim in a report someone will act on. |
| "jscpd listed nothing, so nothing is duplicated" | jscpd matches copied token runs. Logic written again in other words, and a helper that already exists in a shared folder, reach the review only through the search of cross-file question 1 - the Grep tool over `target.snapshotDir`. |
| "This jscpd candidate is short / only similar" | A candidate is dismissed only on the grounds cross-file question 1 lists: a dictated shape, parallel data, or the same syntax around different calls and fields. Every other one is a 🔴 High finding, whatever its length or kind. |
| "Reading several files at once saves time" | Only the small files of one batch are read together (`target.batches`, Step 3 point 1), and each is still walked alone to its end, from its own Reads: with several files' code in front of you, the walk of each one drifts into a skim of all of them. Only the next batch's Reads may ride with the current batch's Writes. |
| "`OK (pod X#n)` — the other item already reports it" | Code that breaks an item never passes it. When the two items are one requirement in two instructions, or two items of a `checklistPerFile` instruction, the finding names both and both are ticked `NARUSZENIE`; when they are two requirements, each gets its own finding (Step 3 point 3). |
| "One finding per area of the file is tidier — list everything under it" | Each defect is its own finding. Items of one instruction in one `**Reguła:**` are refused by the part check: they are separate requirements, and a merged block reports one of them. Only a `checklistPerFile` instruction is one finding per file. |
| "Both defects break the same item — one finding covers it" | An item names a rule; a finding names one fix. Two different changes under one item are two findings, each with its own lines, and the item's `NARUSZENIE` line carries both. |
| "The methods are trivial, the gate fails" | Triviality never fails a gate: a one-line setter is a method and a lone `.next()` call is behaviour. Only a file holding none of the constructs the gate names fails it. |
| "The check refused the part, tick the rest to get through" | The check refuses a false record, never an honest one: `[ ] … — NIEZWERYFIKOWANE: <narzędzie: / poza recenzją: / działająca aplikacja:> …` passes on every item no `FAKT` settles. Fix what it names in the draft with Edit: the hook checks the draft again and writes the part once it passes. |
| "The project has no spec / no i18n / no such file, so the item cannot be verified" | A requirement nothing satisfies is `NARUSZENIE`. `NIEZWERYFIKOWANE` names a tool not run, a file outside the review, or data of the running app — never an absence in the code under review. |
| "The bundle's `SONDA` line hit, so that is a finding" | A probe points; it never decides. Read the line: `NARUSZENIE` if it breaks the item, otherwise an `OK` that cites it and says why not. |
| "This annotation is redundant — the type is inferred anyway" | A claim about a type, signature or value declared in another file is checked at that declaration before it is written: open it. `getUsers()` returning `Observable<any>` makes the annotation the only real type on the line, not a redundant one. |


## The rulebook — addresses and plans

Never skip or skim the `## Plan` of a bundle: with the rulebook notes it is the review rulebook.

Every checklist item has an address, `<id>#<n>`: item `n` of instruction `<id>`, the same number in every kind that walks it.
Take addresses from the bundle only: never number, list or count items yourself, and never through Bash.
The bundle's plan (the context's `checklistPlans` entry of the file's kind) lists exactly the items its file is walked against, in the order they are walked, and its `pozycji planu:` is their sum (`checklistTotal`).
Walk exactly those numbers under the addresses it gives them, and never renumber a narrowed instruction from 1: `accessibility#12` is item 12 whether or not `#1-11` are in the plan.
A plan shorter than the rulebook is a decision, not an omission: an instruction or an item the plan does not list is not this file's rule - never walked, never ticked and never reported, not even when the file happens to break it.
A file no kind describes has no plan: it is reviewed against `CLAUDE.md` and the universal points only.
An instruction with a `Bramka:` line declares a gate (`checklistGates`), answered per file before its items (Step 3 point 2); one whose items are facets of one requirement (`checklistPerFile`) is a single finding per file (Step 3 point 3).
The project `CLAUDE.md` is a rulebook, not a numbered checklist: its rules decide verdicts and override conflicting instruction items, but they get no `<id>#<n>` line of their own.
<!-- walk:end -->
