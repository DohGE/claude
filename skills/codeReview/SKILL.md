---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, a list of branches, or every file under a folder) - checks every changed file against global/local instruction checklists and writes one concise Polish report per branch (interactive HTML by default, Markdown with --only-md) with severity, real line numbers, violated rule and expected result
---

# codeReview — deterministic instruction-driven review

You produce review REPORTS only.
Never fix code, never commit, never checkout, never edit the reviewed project's files.
Staged mode is the one exception to touching the repo at all: its context script runs `git add .`
to stage every pending change before reviewing — the index only, never a commit or a file edit.

Execute EVERY step of this skill yourself, in the current conversation.
Never dispatch sub-agents (Agent/Task/Explore tools) for any part of the run — not one per branch, not one per file, not for large diffs, not to save context or time.
Multiple targets are reviewed by you sequentially, one after another.

Coverage is non-negotiable: every file of every target and every checklist item of every applicable
instruction gets evaluated, on every run. Violating the letter of these steps is violating their spirit.
Coverage and reporting scope are two different things: everything is evaluated, but only violations the
diff itself touched are reported (Step 3 scope gate).

## Step 1 — Build the review context

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = current working directory.
2. If the arguments contain the exact token `--only-md`, remove it and set `OUTPUT=md`; otherwise
   `OUTPUT=html`. Do this FIRST and on the whole argument list, wherever the flag sits — an
   unstripped `--only-md` would be mapped below as a branch name.
3. Map the REMAINING arguments to the context script EXACTLY like this:
   - no arguments → `--mode=auto`
   - the single word `staged` → `--mode=staged` (the script first runs `git add .`, so the review
     covers every pending change — working-tree edits and untracked files staged as one set)
   - the word `folder` followed by one path → `--mode=folder --path="<path>"` (reviews every
     file currently in that folder of the working tree, no diff needed)
   - anything else → `--mode=branches --branches="<arguments verbatim>"` (the script splits on `,` and `;`)
4. Run (Bash tool): `node "<SKILL_DIR>/scripts/review-context.cjs" --mode=<mode> [--branches="..."] --output=<OUTPUT> --project="<PROJECT>"`
5. Parse the JSON from stdout:
   - Report every `errors[]` entry to the user immediately, in Polish.
   - No targets / exit code 1 → stop after reporting the errors.
   - Report every top-level `warnings[]` entry, in Polish.

## Step 2 — Load the rulebook (once per run)

1. Read EVERY file listed in `globalInstructions`.
2. Read EVERY file listed in `localInstructionsCatalog` (already deduplicated across targets;
   per-file `localInstructions` are INDEXES into this catalog).
3. If `claudeMd` is not null, read it and treat it as one more global instruction.
4. Issue every Read of points 1–3 as parallel tool calls in ONE message — the whole rulebook
   loads in a single turn, never one file per turn.
5. Precedence when rules conflict: project `CLAUDE.md` > local instruction > global instruction.
   Apply only the winning rule; never report a violation of the overridden rule.

Never skip or skim any of these files — they are the review rulebook.

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

**Endpoint names are out of scope.** Never report the wording, spelling, casing, versioning, path
segments, leading/trailing slashes, key names or CHANGES of REST endpoint paths and their `endpoints`
constants — the backend contract decides them, not this review. The one exception is an absolute URL
inside the value: protocol + domain (`https://api.example.com/...`), `localhost`, or an IP with a port —
that is reported as a hard-coded environment/base URL. Everything else about such a file (typing,
method naming, layering, `.pipe(...)` usage, secrets in query params) stays reviewable as usual.

Write the report header (Step 4 format) to `target.reportPath` first. Then process EVERY file in
`target.files`, one at a time, in the listed order. The script has already excluded everything
skippable (generated/binary → `target.skipped`), so `target.files` contains no file you may skip:
no exceptions for renames, formatting-only diffs, tests, configs, file size, diff size, or how many
files remain. A file whose `localInstructions` is empty still gets the complete global pass — zero
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
2. Evaluate the file against every point below, checklist-driven — never holistically. For points
   1 and 2, take each instruction file in turn and walk its checklist top-to-bottom: read an item,
   check the file's code against that one item, reach an explicit pass/violation verdict, record
   the finding(s) on violation, then move to the next item. The checklist drives the pass — never
   scan the file first and recall rules from memory afterwards. Reason through items SILENTLY — do
   not print per-point notes or progress commentary; the only text a file produces is its findings
   (or nothing). Sampling checklists, skipping items, or abandoning a checklist partway through a
   file is forbidden:
   1. Compliance with every global instruction, checklist item by item.
   2. Compliance with every matched local instruction (its `localInstructions` indexes into
      `localInstructionsCatalog`), checklist item by item.
   3. Consistency with the other files of this diff (naming, patterns, architecture).
   4. Potential regressions.
   5. Readability problems.
   Performance, security, architecture and test coverage are enforced through their global
   instruction checklists in point 1 — do not invent extra criteria beyond the instructions.
   An item counts as evaluated only after you checked the file's code against it and reached an
   explicit pass/violation verdict — "nothing jumped out at a glance" is not a verdict.
   Checklist items come in two shapes, and both get real verdicts:
   - prohibitions — code that must not appear; scanning the file finds these;
   - requirements — something that MUST be present (`ChangeDetectionStrategy.OnPush`, a route
     `title`, `{ dispatch: false }`, an `afterEach`, a `should`-prefixed description, a fail action
     completing a trio, a matching spec...). Scanning never finds an absence: a requirement's PASS
     verdict is reached only by pointing at the exact code that satisfies it, and a requirement
     nothing satisfies is a finding.
   Five rule families are historically under-reported; check them deliberately for every file their
   instructions match, even when the diff looks unrelated (they stay defined ONLY by their
   instruction files — never re-derive them from memory):
   - `computed()`/`pipe(map(...))` over facade values (component, feature-component and ngrx-facade instructions);
   - naming rules (general instruction) plus naming consistency across the diff;
   - code-quality rules (code-quality instruction): duplicated, unnecessary, unused and boilerplate
     code, functionality-narrating comments, inconsistency — full 🟡 Medium findings, never nits to skip;
   - structure rules: canonical area layout and `index.ts` barrel placement (architecture instruction);
   - test scaffolding rules (unit-tests instruction plus the matching per-type test instruction):
     spec and snapshot location, the prescribed setup instead of TestBed/MockStore, `ngMocks.faster()`
     with `beforeAll`, a state-restoring `afterEach`, `should`-prefixed descriptions, a lazily
     reassigned `actions$`, payload-asserting `toHaveBeenCalledWith(...)` — re-walked in full for
     EVERY spec file; the sixth spec gets the same item-by-item walk as the first.
3. Record only REAL findings — no speculative or cosmetic padding.
   One finding = one rule violated in one file. When the SAME rule is broken in several places of
   one file with the same consequence and severity, that is ONE finding whose `**Linia:**` lists
   every occurrence (`2, 8, 10-12`) — never one block per occurrence. An occurrence whose
   consequence or severity differs (one crashes, another is cosmetic) gets its own finding, as
   does a different rule broken on the same line. The SAME violation is reported ONCE, under the
   most specific instruction that covers it (local wins over global).
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
4. Persist findings per fetch batch, not per file and never all at the end: when the last file of
   the current batch (point 1) is analyzed, write the batch's findings sections — every file of
   the batch, in listed order — as the next sequential part file
   (`<reportPath minus .md>.part<NN>.md`, zero-padded, next to the report) with ONE Write call.
   Findings never wait beyond their own batch; earlier parts are never edited.

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

A target with no findings still gets a part file: write `Nie wykryto problemów.` (or
`Nie wykryto zmian do analizy.` for an empty diff) as `part01`, so the assembly below always has
something to concatenate.

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
warnings it keeps the Markdown too, which means the report drifted from the Step 4 format.

Coverage gate — before leaving Step 3 for a target: re-read `target.files` and confirm every entry
had its commands run and all five points evaluated; analyze any missed file now. A target with an
unanalyzed file is not done, regardless of diff size or session length.

## Step 4 — Report format (one file per target, ALWAYS in Polish)

`target.reportPath` (UTF-8) is assembled during Step 3 (header written first, findings as part files per batch, one concatenation at the end), with this structure and nothing else.
`render-report.cjs` parses exactly this structure to build the HTML report, so it is a contract, not a suggestion — every deviation degrades the HTML and makes the renderer keep the Markdown:

    # Code Review: <branch> → <baseBranch> | <YYYY-MM-DD> <HH:mm>

    ## <file path>

    <emoji> **<Severity>**
    - **Linia:** <N | N, M, X-Y>
    - **Problem:** <description of this single violation>
    - **Reguła:** <instruction file → checklist item, or the violated point name>
    - **Expected Result:** <correct code state + concrete implementation proposal>

- Staged header instead: `# Code Review: staged (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Folder header instead: `# Code Review: folder <target.folder> (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Take the header date and time from the trailing `-YYYY-MM-DD-HH-mm` of `reportPath`, replacing the final dash of the time with `:` (e.g. `14-30` → `14:30`), so the header always matches the file name.
- If `target.skipped` is non-empty, add directly under the header the single line:
  `Pominięto pliki wygenerowane/binarne: <paths, comma-separated>`.
- Severity emoji, exactly: ⚪ **Low**, 🟡 **Medium**, 🔴 **High**, 🟤 **Critical**, 🔵 **Missing Unit Test**.
- Assign severity by these criteria, picking the highest that applies:
  - 🟤 **Critical** — security vulnerability, data loss/corruption, state leaking between users or requests, runtime crash or broken build on a main path.
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification).
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation, and every code-quality finding (duplicated, unnecessary, unused or boilerplate code, functionality-narrating comment, inconsistency) — those stay Medium however cosmetic they look.
  - ⚪ **Low** — readability, naming-convention or style drift with no behavioral impact and not covered by the code-quality instruction.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
- When the violated rule is behavioral, **Problem:** names the observable runtime consequence
  (infinite dispatch loop, race condition, subscription leak, crash on null, stale UI) — and
  severity is picked from that consequence, not from the rule's category.
- One finding = one such block = one rule in one file (Step 3 point 3): every
  same-consequence occurrence of that rule shares the block through the `**Linia:**` list;
  a different rule — even on the same line — is its own block, as is an occurrence with a
  different consequence or severity.
  Separate every block from the next with exactly one blank line, and put one blank line before AND
  after every `##` header. The severity lead line below is what makes those blank lines render as
  real vertical spacing in a preview, so each finding shows up as its own visually separated section.
- The severity is a bold lead line — `<emoji> **<Severity>**` with NO leading `- ` — that opens the
  block; the other four fields follow it as `- ` bullet lines in the order shown. Each field is its
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
Nothing else.

## Skip rationalizations — all invalid

Catching yourself thinking any of these means STOP and return to the file or checklist item:

| Excuse | Reality |
|---|---|
| "Diff too large / too many files" | Scope never shrinks with size. Continue sequentially until the list is exhausted. |
| "Trivial / generated / config / test-only file" | The script already removed skippable files; everything in `target.files` gets the full pass. |
| "Rename or formatting-only change" | Moved code is re-reviewed at its new location — structure, naming and import rules break exactly there. |
| "A similar file already passed" | Every file gets its own per-item verdicts; similarity is not compliance. |
| "This rule is pedantic here" | Rule weight is expressed through severity, never through omission. |
| "I remember the instructions" | Verdicts come from the instruction files read this run, item by item — not from memory. |
| "This file already has plenty of findings" | Findings per file are unlimited. Stopping a checklist partway is skipping items. |
| "This line already has a finding" | Findings are per rule, not per line. A cited line goes back through the remaining checklist items (Step 3 point 3, line sweep) — one line commonly breaks three or four rules. |
| "I already reported this rule here" | You reported its first occurrence. The occurrence sweep (Step 3 point 3) searches the whole file for the rest and puts every one into `**Linia:**`. |
| "No local instruction matched this file" | Global checklists apply to every file; zero local matches often means the file sits outside every dedicated location — itself a violation. |
| "Context/time is running low" | Coverage outranks speed. Keep going file by file. |
