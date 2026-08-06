# /codeReview — deterministic instruction-driven code review

Part of the `doh` plugin.
Reviews git changes against instruction checklists and writes one concise report per reviewed branch — an interactive HTML page by default, Markdown with `--only-md`.
Reports are always written in Polish.
Report-only: the skill writes no code and makes no commits; the sole repo side effect is `git add .` in staged mode, which stages every pending change before reviewing it.
Single-agent: the invoking agent performs every step itself and never dispatches sub-agents, even for multiple branches or large diffs.
Full coverage: every file in the diff and every checklist item of every matched instruction is evaluated on every run — the reviewer never skips files or rules; only the context script excludes generated/binary files.
Reporting scope is narrower than coverage: only violations carried by the lines the diff touched are reported (see [Review scope](#review-scope)).

## Usage

| Invocation | Scope |
|---|---|
| `/codeReview` | current branch vs its auto-detected base branch |
| `/codeReview staged` | all pending changes (runs `git add .` first, then reviews the git index) |
| `/codeReview feature/a,feature/b;hotfix/c` | each listed branch (`,` or `;` separated) vs its own auto-detected base; one report per branch |
| `/codeReview [target] --only-md` | any of the above, but the report stays Markdown and no HTML is rendered |

`--only-md` may sit anywhere in the arguments and is stripped before the rest is mapped to a mode.
The two formats are mutually exclusive: HTML mode leaves no `.md` behind, `--only-md` renders no HTML.

Reports are grouped per branch: every report of a branch lands in `reports/{branch}/` inside this skill, named `{branch}-{YYYY-MM-DD}-{HH-mm}.html` (staged variant: `{branch}-staged-{YYYY-MM-DD}-{HH-mm}.html`, folder variant: `{branch}-folder-{path}-{YYYY-MM-DD}-{HH-mm}.html`), or the same name with `.md` under `--only-md`.
A multi-branch run writes one folder per reviewed branch. The branch stays in the file name too, so the HTML page's `localStorage` key (namespaced by file name) never collides between branches reviewed in the same minute.
When the reviewed project has its own `.claude/` folder, reports go to `<project>/.claude/doh/{branch}/` instead.
Branch names are sanitized for file and folder names (any character outside `A-Z a-z 0-9 . _ -` becomes `-`); the time uses `HH-mm` because `:` is not allowed in Windows file names.
Only the 30 newest reports are kept — older ones (either format, in any branch folder) are pruned automatically at the start of a run, and a branch folder emptied by that pruning is removed with them.
Generated and binary files (lockfiles, `*.min.*`, source maps, `dist/`/`build/`/`coverage/` output, images, fonts, media, executables) are excluded from review and listed in one `Pominięto pliki wygenerowane/binarne:` line of the report.

## Instructions

Review rules live in two folders inside this skill (they start empty — add your own):

- `instructions/global/**/*.md` — apply to every reviewed file (subfolders are scanned recursively; `applies-to` frontmatter is ignored here and reported as a warning).
- `instructions/local/**/*.md` — apply only to files matching the `applies-to` globs declared in their frontmatter (subfolders are scanned recursively).

The reviewed project's own `CLAUDE.md` (repo root, if present) is loaded as an additional global instruction.
Files with no matching local instruction are still reviewed against all global instructions and the universal points (cross-file consistency incl. architecture and naming, regressions, readability); performance, security, architecture, code quality (duplication, dead/unnecessary/boilerplate code, narrating comments, inconsistency — always 🟡 Medium) and test coverage are covered by the dedicated global instruction files.

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

## Review scope

Everything is evaluated, but only what the change touched is reported:

- A finding must be carried by a line of the file's `changedLines` — pre-existing violations on untouched lines are never reported, at any severity.
- Added files (and every file in folder mode) have no diff, so their whole content is in scope.
- Three carve-outs, each stating its link to the diff in `**Problem:**`: an obligation the changed lines create (missing spec case, missing teardown, missing required attribute), a regression the diff causes in untouched code, and the consequences of a deletion-only diff.
- REST endpoint paths and their `endpoints` keys are out of scope — their wording, casing, versioning, segments, slashes and changes are never reported. The one exception is an absolute URL inside the value (protocol + domain, `localhost`, IP with a port), reported as a hard-coded base URL.

## Base branch detection

Deterministic candidate order: the branch pointed to by `origin/HEAD`, then `main`, `master`, `develop`, `dev` — keeping only candidates that exist locally or as `origin/<name>`, excluding the reviewed branch itself.
The candidate with the fewest commits between its merge-base and the reviewed branch wins; ties resolve by candidate order.
No usable candidate → the run stops with a clear error.

## HTML report

The default output is one self-contained page — inline CSS and JS, no fonts, images or CDN requests — so it opens straight from disk over `file://` and survives being copied or attached somewhere else.
It follows the reader's light/dark theme.

- **Severity filter** — one toggle chip per severity present in the report, with a count.
- **Rule filter** — a two-level checkbox tree: instruction file, expanding to its concrete rules. Toggling the file toggles all of its rules; a partial selection shows an indeterminate parent. A finding stays visible while at least one of its rules is selected, so a finding citing two rules survives either way.
- **Grouping** — `Pliki` (one collapsible section per file, in report order) or `Globalnie` (one flat list sorted by severity, then path); the flat list labels each finding with its file.
- **Ignoring** — `Ukryj` hides one finding and updates every count; the toolbar shows `Zignorowane: N` and `Przywróć` brings them all back. Ignored ids are stored in `localStorage` under a key namespaced by the report's file name, so they survive a reload and never leak between reports.
- `Wyczyść filtry` re-checks every facet without touching what is ignored. Severity and rule counts are totals over everything not ignored — they react to hiding, not to filtering, and `Widoczne: X z Y` is what tracks the active filters.

Report text reaches the page as JSON data and is written into the DOM with `textContent`, so a finding quoting markup can never become markup; backtick spans render as `<code>`.

## Report format

The Markdown below is the report under `--only-md` and the intermediate representation the HTML is rendered from, so its structure is a contract — `render-report.cjs` parses it, and a deviation both degrades the HTML and makes the renderer keep the `.md` next to it as a signal.

Always Polish, findings only — no intros, summaries or closing remarks.
Header line: `# Code Review: <branch> → <base> | <YYYY-MM-DD> <HH:mm>` (staged variant: `# Code Review: staged (<branch>) | ...`).
One `## <file path>` section per file with findings.
Each finding is one block describing exactly one violation of one rule at one location — several violations never share a block.
The severity is a bold lead line; the other four fields follow as bullets, each on its own line, with one blank line before every block so each finding renders as its own vertically spaced section:

    🔴 **High**
    - **Linia:** 87
    - **Problem:** Brak obsługi błędu HTTP w subskrypcji
    - **Reguła:** instructions/local/angular-ts.md → "Obsługa błędów w subskrypcjach"
    - **Expected Result:** `catchError` z mapowaniem na stan błędu komponentu

Severity: ⚪ Low · 🟡 Medium · 🔴 High · 🟤 Critical · 🔵 Missing Unit Test.
Line numbers refer to the file's real content (read off the line-numbered `git show … | cat -n` output), never to diff hunk numbering.
The context script additionally precomputes each file's changed-line ranges (`changedLines`, from `git diff -U0`) as the authoritative list of lines the diff touched.
No findings → the report is the single line `Nie wykryto problemów.`; empty diff → `Nie wykryto zmian do analizy.`

## Mechanics

`scripts/review-context.cjs` (Node, zero dependencies) does all deterministic work: base-branch detection, changed-file listing, changed-line ranges, instruction matching, report paths and ready-to-run git commands.
Branch reviews never touch the working tree (`git diff base...branch`, `git show branch:path`); staged reviews first run `git add .`, then read index content (`git show :path`).

`scripts/render-report.cjs` (Node, zero dependencies) parses the assembled Markdown report and renders the HTML page, then removes the Markdown — but only after a warning-free parse.
Run it by hand with `node scripts/render-report.cjs --report=<path.md> [--out=<path.html>] [--keep-source]`.
It accepts the severity lead line with and without a leading `- ` (reports written before `ee76300` use the dashed form), and reads `**Reguła:**` whether the instruction is named with its `.md` extension, without it, or replaced by the violated point's name.

Tests: `node --test skills/codeReview/scripts/review-context.test.cjs skills/codeReview/scripts/render-report.test.cjs`
(paths are listed explicitly because PowerShell does not expand globs for native commands).
