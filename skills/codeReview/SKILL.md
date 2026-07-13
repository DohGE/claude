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

Write the report header (Step 4 format) to `target.reportPath` first. Then, for EVERY file in `target.files`:

1. Run its `diffCommand` (what changed) and its `showCommand` (full file content) with the Bash tool
   — `showCommand` pipes through `cat -n`, which needs a POSIX shell.
   Line numbers in findings are read directly off the `cat -n` output — never diff hunk numbering.
   Added files (`diffCommand: null`) are reviewed from the `showCommand` output alone (the whole file is new);
   deleted files (`showCommand: null`) from the diff alone.
2. Evaluate the file against every point below. Reason through them SILENTLY — do not print
   per-point notes or progress commentary; the only text a file produces is its findings (or nothing).
   Sampling checklists or skipping any point is forbidden:
   1. Compliance with every global instruction, checklist item by item.
   2. Compliance with every matched local instruction (its `localInstructions` indexes into
      `localInstructionsCatalog`), checklist item by item.
   3. Consistency with the other files of this diff (naming, patterns, architecture).
   4. Potential regressions.
   5. Readability problems.
   Performance, security, architecture and test coverage are enforced through their global
   instruction checklists in point 1 — do not invent extra criteria beyond the instructions.
3. Record only REAL findings — no speculative or cosmetic padding.
   Report each violation ONCE, under the most specific instruction that covers it (local wins over global).
4. Append the file's findings section to `target.reportPath` IMMEDIATELY after analyzing the file —
   never hold findings in memory for later.

After the per-file pass, do ONE cross-file pass over the whole diff for point 3 (mutual consistency,
architecture, naming) and append any new findings to the report.

## Step 4 — Report format (one file per target, ALWAYS in Polish)

`target.reportPath` (UTF-8) is written incrementally during Step 3 (header → per-file sections → cross-file findings), with this structure and nothing else:

    # Code Review: <branch> → <baseBranch> | <YYYY-MM-DD> <HH:mm>

    ## <file path>
    <emoji> **<Severity>** | linia <N> | <short problem description>
    Reguła: <instruction file → checklist item, or the violated point name>
    **Expected Result:** <correct code state + concrete implementation proposal>

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
- Group findings under one `## <file path>` section per file; omit files without findings.
  The cross-file pass may append a second section for an already-reported path — that is acceptable.
- Expected Result describes ONLY the correct state of the code plus a concrete implementation proposal.
- No intros, no summaries, no closing remarks — findings only.
- No findings in the whole target → the report body is the single line `Nie wykryto problemów.`
- Empty diff (`files` empty) → the single line `Nie wykryto zmian do analizy.` (plus the skipped line, if any).

## Step 5 — Terminal summary (Polish)

After writing all reports print, in Polish: each report path + finding counts per severity, plus any errors/warnings from Step 1.
Nothing else.
