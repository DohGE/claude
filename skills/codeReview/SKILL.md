---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, or a list of branches) - checks every changed file against global/local instruction checklists and writes one concise Polish Markdown report per branch with severity, real line numbers, violated rule and expected result
---

# codeReview — deterministic instruction-driven review

You produce review REPORTS only.
Never fix code, never commit, never checkout, never modify the reviewed project in any way.

Execute EVERY step of this skill yourself, in the current conversation.
Never dispatch sub-agents (Agent/Task/Explore tools) for any part of the run — not one per branch, not one per file, not for large diffs, not to save context or time.
Multiple targets are reviewed by you sequentially, one after another.

Coverage is non-negotiable: every file of every target and every checklist item of every applicable
instruction gets evaluated, on every run. Violating the letter of these steps is violating their spirit.

## Step 1 — Build the review context

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = current working directory.
2. Map the invocation arguments to the context script EXACTLY like this:
   - no arguments → `--mode=auto`
   - the single word `staged` → `--mode=staged`
   - anything else → `--mode=branches --branches="<arguments verbatim>"` (the script splits on `,` and `;`)
3. Run (Bash tool): `node "<SKILL_DIR>/scripts/review-context.cjs" --mode=<mode> [--branches="..."] --project="<PROJECT>"`
4. Parse the JSON from stdout:
   - Report every `errors[]` entry to the user immediately, in Polish.
   - No targets / exit code 1 → stop after reporting the errors.
   - Report every top-level `warnings[]` entry, in Polish.

## Step 2 — Load the rulebook (once per run)

1. Read EVERY file listed in `globalInstructions`.
2. Read EVERY file listed in `localInstructionsCatalog` (already deduplicated across targets;
   per-file `localInstructions` are INDEXES into this catalog).
3. If `claudeMd` is not null, read it and treat it as one more global instruction.
4. Precedence when rules conflict: project `CLAUDE.md` > local instruction > global instruction.
   Apply only the winning rule; never report a violation of the overridden rule.

Never skip or skim any of these files — they are the review rulebook.

## Step 3 — Analyze (per target, per file) and write findings as you go

Write the report header (Step 4 format) to `target.reportPath` first. Then process EVERY file in
`target.files`, one at a time, in the listed order. The script has already excluded everything
skippable (generated/binary → `target.skipped`), so `target.files` contains no file you may skip:
no exceptions for renames, formatting-only diffs, tests, configs, file size, diff size, or how many
files remain. A file whose `localInstructions` is empty still gets the complete global pass — zero
local matches usually means the file sits outside every dedicated location (the script surfaces
these files in `warnings[]`), not that the file may be skimmed. For each file:

1. Run its `diffCommand` (what changed) and its `showCommand` (full file content) with the Bash tool
   — `showCommand` pipes through `cat -n`, which needs a POSIX shell.
   `changedLines` (precomputed by the script from `git diff -U0`) is the authoritative list of the
   lines this diff touched, numbered exactly like the `cat -n` output, e.g. `"7, 12-15"`;
   `""` means the diff only deleted lines. Never re-derive these ranges from diff hunks yourself.
   Added files (`diffCommand: null`, `changedLines: null`) are reviewed from the `showCommand`
   output alone (every line is new); deleted files (`showCommand: null`) from the diff alone.
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
   Three rule families are historically under-reported; check them deliberately for every file their
   instructions match, even when the diff looks unrelated (they stay defined ONLY by their
   instruction files — never re-derive them from memory):
   - `computed()`/`pipe(map(...))` over facade values (component, feature-component and ngrx-facade instructions);
   - naming rules (general instruction) plus naming consistency across the diff;
   - structure rules: canonical area layout and `index.ts` barrel placement (architecture instruction).
3. Record only REAL findings — no speculative or cosmetic padding.
   One finding = one violation of one rule at one location. A rule broken in three places yields
   three findings, each with its own block and line number; a line breaking two different rules
   yields two findings. The SAME violation is reported ONCE, under the most specific instruction
   that covers it (local wins over global).
   A finding's line number is determined at the moment of writing it: locate the offending code in
   the `cat -n` output and cite the number printed there — never diff hunk numbering, never an
   estimate from memory. Cite one number, or one `<start>-<end>` span only when the single
   violation itself spans contiguous lines. Cross-check against `changedLines`: a finding whose
   line lies outside them must state in its description how the diff causes the problem there.
4. Append the file's findings section to `target.reportPath` IMMEDIATELY after analyzing the file —
   never hold findings in memory for later.

After the per-file pass, do ONE cross-file pass over the whole diff for point 3 and append any new
findings to the report. Answer each of these four questions explicitly, against the diff as a whole:
1. Duplication drift — is the same logic, formatting or literal implemented in two or more places
   of this diff, or re-implemented next to an existing shared util? Report every copy.
2. Layering — take every import edge between the diff's files (and from the diff into the project's
   layers) and check its direction against the architecture instruction; report each forbidden edge
   at the importing file.
3. Derived-data flow — does any state field, action payload or component binding carry a value
   computable from other state? Report every station of the flow (the action, the reducer field,
   the dispatching component), each under its own instruction.
4. Naming consistency — the same concept named differently across the diff's files, or one name
   reused for different concepts.

Coverage gate — before leaving Step 3 for a target: re-read `target.files` and confirm every entry
had its commands run and all five points evaluated; analyze any missed file now. A target with an
unanalyzed file is not done, regardless of diff size or session length.

## Step 4 — Report format (one file per target, ALWAYS in Polish)

`target.reportPath` (UTF-8) is written incrementally during Step 3 (header → per-file sections → cross-file findings), with this structure and nothing else:

    # Code Review: <branch> → <baseBranch> | <YYYY-MM-DD> <HH:mm>

    ## <file path>

    - <emoji> **<Severity>**
    - **Linia:** <N>
    - **Problem:** <description of this single violation>
    - **Reguła:** <instruction file → checklist item, or the violated point name>
    - **Expected Result:** <correct code state + concrete implementation proposal>

- Staged header instead: `# Code Review: staged (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Take the header date and time from the trailing `-YYYY-MM-DD-HH-mm` of `reportPath`, replacing the final dash of the time with `:` (e.g. `14-30` → `14:30`), so the header always matches the file name.
- If `target.skipped` is non-empty, add directly under the header the single line:
  `Pominięto pliki wygenerowane/binarne: <paths, comma-separated>`.
- Severity emoji, exactly: ⚪ **Low**, 🟡 **Medium**, 🔴 **High**, 🟤 **Critical**, 🔵 **Missing Unit Test**.
- Assign severity by these criteria, picking the highest that applies:
  - 🟤 **Critical** — security vulnerability, data loss/corruption, state leaking between users or requests, runtime crash or broken build on a main path.
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification).
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation.
  - ⚪ **Low** — readability, naming, style, redundant code, convention drift with no behavioral impact.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
- When the violated rule is behavioral, **Problem:** names the observable runtime consequence
  (infinite dispatch loop, race condition, subscription leak, crash on null, stale UI) — and
  severity is picked from that consequence, not from the rule's category.
- One finding = one such five-bullet block describing exactly one violation (Step 3 point 3);
  the next violation — even of the same rule, even on the same line — is its own block.
  A blank line separates consecutive blocks and precedes every `##` header.
- Each of the five fields is its own `- ` bullet line, in the order shown; a field never continues
  on the previous field's line. `**Linia:**` holds one number or one `<start>-<end>` span.
- Group findings under one `## <file path>` section per file; omit files without findings.
  The cross-file pass may append a second section for an already-reported path — that is acceptable.
- Expected Result describes ONLY the correct state of the code plus a concrete implementation proposal.
- No intros, no summaries, no closing remarks — findings only.
- No findings in the whole target → the report body is the single line `Nie wykryto problemów.`
- Empty diff (`files` empty) → the single line `Nie wykryto zmian do analizy.` (plus the skipped line, if any).

## Step 5 — Terminal summary (Polish)

After writing all reports print, in Polish: each report path + finding counts per severity, plus any errors/warnings from Step 1.
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
| "No local instruction matched this file" | Global checklists apply to every file; zero local matches often means the file sits outside every dedicated location — itself a violation. |
| "Context/time is running low" | Coverage outranks speed. Keep going file by file. |
