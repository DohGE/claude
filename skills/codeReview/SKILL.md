---
name: codeReview
description: Use when the user wants an instruction-driven code review of git changes (current branch vs its base, staged files, or a list of branches) - checks every changed file against global/local instruction checklists and writes one concise Polish Markdown report per branch with severity, real line numbers, violated rule and expected result
---

# codeReview — deterministic instruction-driven review

You produce review REPORTS only.
Never fix code, never commit, never checkout, never modify the reviewed project in any way.

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
   - Report every `warnings[]` entry of every target, in Polish.

## Step 2 — Load the rulebook (once per run)

1. Read EVERY file listed in `globalInstructions`.
2. Read EVERY file listed in any `files[].localInstructions` (deduplicated).
3. If `claudeMd` is not null, read it and treat it as one more global instruction.
4. Precedence when rules conflict: project `CLAUDE.md` > local instruction > global instruction.
   Apply only the winning rule; never report a violation of the overridden rule.

Never skip or skim any of these files — they are the review rulebook.

## Step 3 — Analyze (per target, per file)

For EVERY file in `target.files`:

1. Run its `diffCommand` (what changed) and its `showCommand` (full file content).
   Line numbers in findings MUST be the 1-based line positions in the `showCommand` output — never diff hunk numbering.
   Deleted files (`showCommand: null`) are reviewed from the diff alone.
2. Evaluate the file against every point below, one point at a time.
   Batching points, sampling checklists or skipping any point is forbidden:
   1. Compliance with every global instruction.
   2. Compliance with every matched local instruction.
   3. Every single checklist item of those instructions, item by item.
   4. Consistency with the other files of this diff.
   5. Architectural consistency.
   6. Naming consistency.
   7. Potential regressions.
   8. Potential performance problems.
   9. Potential security problems.
   10. Readability problems.
   11. Missing unit tests.
   12. Violations of good practices described in the instructions.
3. Record only REAL findings — no speculative or cosmetic padding.

After the per-file pass, do ONE cross-file pass over the whole diff for points 4-6 (mutual consistency, architecture, naming).

## Step 4 — Write the report (one file per target, ALWAYS in Polish)

Write to `target.reportPath` (UTF-8), with this structure and nothing else:

    # Code Review: <branch> → <baseBranch> | <YYYY-MM-DD> <HH:mm>

    ## <file path>
    <emoji> **<Severity>** | linia <N> | <short problem description>
    Reguła: <instruction file → checklist item, or the violated point name>
    **Expected Result:** <correct code state + concrete implementation proposal>

- Staged header instead: `# Code Review: staged (<branch>) | <YYYY-MM-DD> <HH:mm>`.
- Take the header date and time from the trailing `-YYYY-MM-DD-HH-mm` of `reportPath`, replacing the final dash of the time with `:` (e.g. `14-30` → `14:30`), so the header always matches the file name.
- Severity emoji, exactly: ⚪ **Low**, 🟡 **Medium**, 🔴 **High**, 🟤 **Critical**, 🔵 **Missing Unit Test**.
- Assign severity by these criteria, picking the highest that applies:
  - 🟤 **Critical** — security vulnerability, data loss/corruption, state leaking between users or requests, runtime crash or broken build on a main path.
  - 🔴 **High** — functional bug or likely regression, memory/subscription leak, race condition, swallowed error on a user-facing path, stale UI (state change without a change-detection notification).
  - 🟡 **Medium** — performance problem, architecture/layering violation, missing null-safety on a reachable path, accessibility violation.
  - ⚪ **Low** — readability, naming, style, redundant code, convention drift with no behavioral impact.
  - 🔵 **Missing Unit Test** — new or changed behavior without the matching spec change (report it even when the same lines also carry findings of other severities).
- Group findings under one `## <file path>` section per file; omit files without findings.
- Expected Result describes ONLY the correct state of the code plus a concrete implementation proposal.
- No intros, no summaries, no closing remarks — findings only.
- No findings in the whole target → the report body is the single line `Nie wykryto problemów.`
- Empty diff (no files) → the single line `Nie wykryto zmian do analizy.`

## Step 5 — Terminal summary (Polish)

After writing all reports print, in Polish: each report path + finding counts per severity, plus any errors/warnings from Step 1.
Nothing else.
