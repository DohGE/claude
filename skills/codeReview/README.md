# /codeReview — deterministic instruction-driven code review

Part of the `doh` plugin.
Reviews git changes against instruction checklists and writes one concise Markdown report per reviewed branch.
Reports are always written in Polish.
Report-only: the skill never modifies the reviewed project.
Single-agent: the invoking agent performs every step itself and never dispatches sub-agents, even for multiple branches or large diffs.

## Usage

| Invocation | Scope |
|---|---|
| `/codeReview` | current branch vs its auto-detected base branch |
| `/codeReview staged` | files currently staged in the git index |
| `/codeReview feature/a,feature/b;hotfix/c` | each listed branch (`,` or `;` separated) vs its own auto-detected base; one report per branch |

Reports land in `reports/` inside this skill, named `{branch}-{YYYY-MM-DD}-{HH-mm}.md` (staged variant: `{branch}-staged-{YYYY-MM-DD}-{HH-mm}.md`).
Branch names are sanitized for file names (any character outside `A-Z a-z 0-9 . _ -` becomes `-`); the time uses `HH-mm` because `:` is not allowed in Windows file names.
Only the 30 newest reports are kept — older ones are pruned automatically at the start of a run.
Generated and binary files (lockfiles, `*.min.*`, source maps, `dist/`/`build/`/`coverage/` output, images, fonts, media, executables) are excluded from review and listed in one `Pominięto pliki wygenerowane/binarne:` line of the report.

## Instructions

Review rules live in two folders inside this skill (they start empty — add your own):

- `instructions/global/**/*.md` — apply to every reviewed file (subfolders are scanned recursively; `applies-to` frontmatter is ignored here and reported as a warning).
- `instructions/local/**/*.md` — apply only to files matching the `applies-to` globs declared in their frontmatter (subfolders are scanned recursively).

The reviewed project's own `CLAUDE.md` (repo root, if present) is loaded as an additional global instruction.
Files with no matching local instruction are still reviewed against all global instructions and the universal points (cross-file consistency incl. architecture and naming, regressions, readability); performance, security, architecture and test coverage are covered by the dedicated global instruction files.

An instruction may declare `audience: implement|review|both` in its frontmatter (default `both`):
`review`-audience files load only for this skill, `implement`-audience files only for the implementNewFeature coding rulebook (e.g. the developer persona in `guidelines.md`).

### Local instruction template

    ---
    name: Angular TS
    applies-to:
      - "**/*.component.ts"
      - "**/*.service.ts"
    ---
    ## Checklist
    - OnPush change detection for presentational components
    - No logic in constructors

A global instruction is the same file without the `applies-to` key.
List items under `applies-to:` must be indented; quotes around patterns are optional.
A local instruction without any `applies-to` pattern never matches and is reported as a warning.

### Glob subset

`**` matches any number of directories, `*` matches within one path segment, `?` matches a single character.
Matching is case-sensitive, against `/`-separated paths relative to the repo root.
Everything else is matched literally.

## Base branch detection

Deterministic candidate order: the branch pointed to by `origin/HEAD`, then `main`, `master`, `develop`, `dev` — keeping only candidates that exist locally or as `origin/<name>`, excluding the reviewed branch itself.
The candidate with the fewest commits between its merge-base and the reviewed branch wins; ties resolve by candidate order.
No usable candidate → the run stops with a clear error.

## Report format

Always Polish, findings only — no intros, summaries or closing remarks.
Header line: `# Code Review: <branch> → <base> | <YYYY-MM-DD> <HH:mm>` (staged variant: `# Code Review: staged (<branch>) | ...`).
One `## <file path>` section per file with findings; each finding looks like:

    🔴 **High** | linia 87 | Brak obsługi błędu HTTP w subskrypcji
    Reguła: instructions/local/angular-ts.md → "Obsługa błędów w subskrypcjach"
    **Expected Result:** `catchError` z mapowaniem na stan błędu komponentu

Severity: ⚪ Low · 🟡 Medium · 🔴 High · 🟤 Critical · 🔵 Missing Unit Test.
Line numbers refer to the file's real content (read off the line-numbered `git show … | cat -n` output), never to diff hunk numbering.
No findings → the report is the single line `Nie wykryto problemów.`; empty diff → `Nie wykryto zmian do analizy.`

## Mechanics

`scripts/review-context.cjs` (Node, zero dependencies) does all deterministic work: base-branch detection, changed-file listing, instruction matching, report paths and ready-to-run git commands.
Branch reviews never touch the working tree (`git diff base...branch`, `git show branch:path`); staged reviews read index content (`git show :path`).

Tests: `node --test skills/codeReview/scripts/review-context.test.cjs`
