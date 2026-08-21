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
| `/codeReview` | current branch vs its base — the target branch of its open PR, else the branch it was created from (see [Base branch detection](#base-branch-detection)) |
| `/codeReview staged` | all uncommitted changes (runs `git add .` first, then reviews the git index against `HEAD`) |
| `/codeReview feature/a,feature/b;hotfix/c` | each listed branch (`,` or `;` separated) vs its own detected base; one report per branch |
| `/codeReview [target] --only-md` | any of the above, but the report stays Markdown and no HTML is rendered |

`--only-md` may sit anywhere in the arguments and is stripped before the rest is mapped to a mode.
The two formats are mutually exclusive: HTML mode leaves no `.md` behind, `--only-md` renders no HTML.

Reports are grouped per branch: every report of a branch lands in `reports/{branch}/` inside this skill, named `{branch}-{YYYY-MM-DD}-{HH-mm}.html` (staged variant: `{branch}-staged-{YYYY-MM-DD}-{HH-mm}.html`, folder variant: `{branch}-folder-{path}-{YYYY-MM-DD}-{HH-mm}.html`), or the same name with `.md` under `--only-md`.
A multi-branch run writes one folder per reviewed branch. The branch stays in the file name too, so the HTML page's `localStorage` key (namespaced by file name) never collides between branches reviewed in the same minute.
When the reviewed project has its own `.claude/` folder, reports go to `<project>/.claude/doh/{branch}/` instead.
Branch names are sanitized for file and folder names (any character outside `A-Z a-z 0-9 . _ -` becomes `-`); the time uses `HH-mm` because `:` is not allowed in Windows file names.
Only the 30 newest reports are kept — older ones (either format, in any branch folder) are pruned automatically at the start of a run, and a branch folder emptied by that pruning is removed with them.
Pruning counts only run-stamped report names (`…-YYYY-MM-DD-HH-mm.md|html`), so it shares `.claude/doh/` with implementNewFeature's session folders and the project's `instructions/` without ever touching them.

`--since-last` turns a run into a re-review: every run records the post-image blob of each reviewed file in `.last-review-<kind>.json` next to the report, and the next incremental run drops the files whose blob has not moved (they are listed in a warning, and the previous report stays the reference for them).
It is meant for a target already reviewed in this session — the implementNewFeature review loop uses it from cycle 2 on; on a first review it warns and reviews everything.

Each analyzed file ends its block with a coverage marker — `<!-- coverage: <path> <checked>/<total> -->`, `<total>` being the number of checklist items the context script counted for that file. The renderer keeps the marker out of the HTML, warns when `<checked>` is smaller, and says so when a report carries no markers at all.
Generated and binary files (lockfiles, `*.min.*`, source maps, `dist/`/`build/`/`coverage/` output, images, fonts, media, executables) are excluded from review and listed in one `Pominięto pliki wygenerowane/binarne:` line of the report.

## Instructions

Review rules live in two folders inside this skill (they start empty — add your own):

- `instructions/global/**/*.md` — apply to every reviewed file (subfolders are scanned recursively; `applies-to` frontmatter is ignored here and reported as a warning).
- `instructions/local/**/*.md` — apply only to files matching the `applies-to` globs declared in their frontmatter (subfolders are scanned recursively).

A reviewed project can also carry its own rules in `<project>/.claude/doh/instructions/`, with the same `global/` + `local/` layout.
That folder is layered on top of the skill's tree: a file at the same relative path (`global/security.md`) replaces the skill's version, any other file is one more instruction.
It is reported as `projectInstructionsDir` in the context JSON, the implementNewFeature coding rulebook layers it the same way, and the `.claude/doh/.gitignore` written for run artifacts explicitly un-ignores it so the rulebook can be committed and shared.

The reviewed project's own `CLAUDE.md` (repo root, if present) is loaded as an additional global instruction.
Files with no matching local instruction are still reviewed against all global instructions and the universal points (cross-file consistency incl. architecture and naming, regressions, readability); performance, security, architecture, accessibility (WCAG 2.2 level AA — always 🟡 Medium), code quality (duplication, dead/unnecessary/boilerplate code, narrating comments, inconsistency — always 🟡 Medium) and test coverage are covered by the dedicated global instruction files.

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
- Four carve-outs, each stating its link to the diff in `**Problem:**`: a file with no diff at all (`changedLines: null` — an added file, or any file in folder mode), an obligation the changed lines create (missing spec case, missing teardown, missing required attribute), a regression the diff causes in untouched code, and the consequences of a deletion-only diff.
- REST endpoint paths and their `endpoints` keys are out of scope — their wording, casing, versioning, segments, slashes and changes are never reported. The one exception is an absolute URL inside the value (protocol + domain, `localhost`, IP with a port), reported as a hard-coded base URL.
- A line whose only change is mechanical — an import, a renamed identifier, a renamed file, folder or selector, pure formatting — counts as untouched, so a violation that was already sitting there stays unreported. A file whose whole diff is mechanical gets no logic pass at all; it is reviewed for two things only: what the change **broke** (a template, spec, barrel, route, style, translation or import still using the old name or path) and how the change itself **breaks an instruction** (a name against the naming rules, a renamed component whose selector, folder, file name and `.html`/`.scss`/`.spec.ts` siblings did not follow, a moved file in the wrong layer). The rename pair is on the file entry as `oldPath → path`, because a path-limited diff renders every rename as a brand-new file.

## Base branch detection

Only branch targets have a base: `staged` reviews the uncommitted changes themselves (the index against `HEAD`) and `folder` reviews the working tree, so neither compares branches.

For a branch, the base is the first of these that answers:

1. **The target branch of its open pull request** — asked straight of the GitHub REST API, so the review diffs exactly what GitHub shows. Resolved to `origin/<base>` when that ref exists, rather than to a possibly stale local branch of the same name. A PR base that was never fetched is reported as a warning and the detection falls through to step 2.
2. **The branch it was created from** — among the 60 most recently updated local and `origin/` branches, the one the reviewed branch is fewest commits ahead of. Ties go to the conventional names of step 3, in their order, then to a local ref over its `origin/` twin. A feature branch that already contains the whole reviewed branch is skipped, so a branch created *from* the reviewed one never becomes its base; the same from a conventional name is kept, because there it means the branch has not diverged from the trunk yet (or is already merged into it) and an empty diff is the honest answer. This step is skipped entirely when the reviewed branch *is* one of the conventional names — `master` was not forked from anything, and every feature branch merged into it would otherwise look like a very near fork point.
3. **The conventional candidates** — the branch pointed to by `origin/HEAD`, then `main`, `master`, `develop`, `dev`, nearest merge-base first. This is also the answer for a branch already merged everywhere: its diff is empty, which is the truth about it.

No usable candidate → the run stops with a clear error.
The terminal summary names the base and which of the three steps picked it.

Step 1 runs only when a remote points at github.com, and needs no tooling at all — see [GitHub access](#github-access). A call that cannot be made warns once and the run starts at step 2.

## GitHub access

Two features talk to GitHub: the base branch taken from an open pull request, and the report's **Dodaj komentarze do PR** button. Both go straight to the REST API — the `gh` CLI is not required (and not used, beyond being one possible source of a token).

- **Reading** (is there an open PR, what does it target, what is its diff) works **unauthenticated on a public repository**, capped at GitHub's 60 requests/h per IP. A private repository needs a token.
- **Posting** the review always needs a token.

The token is looked up in this order, and the first hit wins:

1. `GH_TOKEN`, then `GITHUB_TOKEN` from the environment.
2. The credential git already stores for github.com — any HTTPS push puts one there (Windows Credential Manager, macOS keychain, `git credential-store`). Asked with `credential.interactive=false`, so a missing credential can never pop a prompt mid-review. Asked twice: once carrying the repository path, which is the only shape a `credential.useHttpPath=true` store matches, then once with the bare host.
3. `~/.netrc` (`_netrc` on Windows) — the `machine github.com` entry. This is the first source that can answer for a repository cloned over SSH, since `git@github.com:` remotes never write an HTTPS credential.
4. gh's own `hosts.yml` (`GH_CONFIG_DIR`, `XDG_CONFIG_HOME/gh`, `%AppData%\GitHub CLI`, `~/.config/gh`) — so a machine that was once authenticated with gh keeps working after the binary leaves the PATH.
5. `gh auth token`, if the CLI happens to be installed.

None of these can be conjured for a private repository that has never been authenticated from this machine: there, `GH_TOKEN` is the answer.
The report says which of the two it is — a token was found and refused, or none was found at all — because a private repository answers an anonymous call with the same 404 it gives a token that cannot see it, and only one of those is fixed by setting `GH_TOKEN`.

The value is never logged and never passed on a command line: it reaches the request child on stdin. A repository whose remotes do not point at github.com is never asked and never warns.

## HTML report

The default output is one self-contained page — inline CSS and JS, no fonts, images or CDN requests — so it opens straight from disk over `file://` and survives being copied or attached somewhere else.
It follows the reader's light/dark theme, and a button in the top right corner of the header switches between the two by hand — the pick lands in `localStorage` under one key shared by every report, and is applied before the first paint so a remembered theme never flashes the other one.

- **Code snippet** — every finding carries a collapsible view of the cited lines with three lines of context. When those lines changed, it is a side-by-side diff like GitHub's split view: the file before the change on the left under its own line numbers, after it on the right, the k-th removal facing the k-th addition inside a change block and a blank cell facing whatever has no counterpart. Each side scrolls horizontally on its own. A snippet with nothing changed in it (a folder review, or a finding on a line the diff left alone) stays a single column. A switch in the snippet header swaps between the cited lines and the whole file; the full view renders under the same rules — split diff when the file changed, single column when it did not — highlights the cited lines, scrolls inside its own box and opens on the first highlight. Files over 3000 lines are not embedded, and their switch says so.
- **Severity filter** — one toggle chip per severity present in the report, with a count.
- **Rule filter** — a two-level checkbox tree: instruction file, expanding to its concrete rules. Toggling the file toggles all of its rules; a partial selection shows an indeterminate parent. A finding stays visible while at least one of its rules is selected, so a finding citing two rules survives either way.
- **Grouping** — `Pliki` (one collapsible section per file, in report order) or `Globalnie` (one flat list sorted by severity, then path); the flat list labels each finding with its file.
- **Accepting** — `Akceptuj` collapses a finding to its head line, marks it as belonging to the pool that goes to the PR (`✓ W puli komentarzy PR`) and turns itself into `Cofnij akceptację`, which restores the previous state. The toolbar shows `Zaakceptowane: N`; the accepted ids live in `localStorage` next to the ignored ones. That pool is the only thing **Dodaj komentarze do PR** sends — nothing accepted means no comment is posted.
- **Ignoring** — `Ukryj` hides one finding and updates every count; the toolbar shows `Zignorowane: N` and `Przywróć` brings them all back. Ignored ids are stored in `localStorage` under a key namespaced by the report's file name, so they survive a reload and never leak between reports.
- **Context menu** — right-clicking anywhere in the report opens a one-item menu, `Przywróć ostatnio ukryte znalezisko`, which does what the toolbar's `Przywróć` does without aiming at it; the item is disabled while nothing is hidden. Escape, a click elsewhere, scrolling or resizing closes it, and Shift+right-click still opens the browser's own menu.
- `Wyczyść filtry` re-checks every facet without touching what is ignored. Severity and rule counts are totals over everything not ignored — they react to hiding, not to filtering, and `Widoczne: X z Y` is what tracks the active filters.

Report text reaches the page as JSON data and is written into the DOM with `textContent`, so a finding quoting markup can never become markup; backtick spans render as `<code>`.

## Report format

The Markdown below is the report under `--only-md` and the intermediate representation the HTML is rendered from, so its structure is a contract — `render-report.cjs` parses it, and a deviation both degrades the HTML and makes the renderer keep the `.md` next to it as a signal.

Always Polish, findings only — no intros, summaries or closing remarks.
Header line: `# Code Review: <branch> → <base> | <YYYY-MM-DD> <HH:mm>` (staged variant: `# Code Review: staged (<branch>) | ...`).
One `## <file path>` section per file with findings.
Each finding is one block describing exactly one violation of one rule at one location — several violations never share a block.
The severity is a bold lead line; the other seven fields follow as bullets, each on its own line, with one blank line before every block so each finding renders as its own vertically spaced section:

    🔴 **High**
    - **Linia:** 87
    - **Problem:** Brak obsługi błędu HTTP w subskrypcji
    - **Reguła:** instructions/local/angular-ts.md → "Obsługa błędów w subskrypcjach"
    - **Expected Result:** `catchError` z mapowaniem na stan błędu komponentu
    - **PR Problem:** The `loadUsers()` subscription passes no error callback, so a failing HTTP call never reaches the component. The view stays on the loading spinner for good and the user is given no way to retry.
    - **PR Expected:** A failed request should leave the component in its error state instead of loading. Pipe `catchError` into the `loadUsers()` stream, map the failure to the component's `error` field and clear `loading`, then render it through the existing error branch of the template.
    - **PR Locations:** `user-panel.component.ts` → `loadUsers()`, `user-panel.component.html` → error branch, `user-panel.component.spec.ts` → failing-request case

`PR Problem`, `PR Expected` and `PR Locations` are the only English fields, written for the PR comment and used nowhere else on the page.
They are written for a reviewer who never opens the report: `PR Problem` gets two sentences (what is wrong + the consequence), `PR Expected` two to three (the target state + how to reach it), and `PR Locations` lists every file and symbol the fix touches — every concrete name the Polish fields propose has to appear in them.

Severity: ⚪ Low · 🟡 Medium · 🔴 High · 🟤 Critical · 🔵 Missing Unit Test.
Line numbers refer to the file's real content (read off the line-numbered `git show … | cat -n` output), never to diff hunk numbering.
The context script additionally precomputes each file's changed-line ranges (`changedLines`, from `git diff -U0`) as the authoritative list of lines the diff touched, and carries the source path of a renamed file (`oldPath`, from the rename pair `git diff --raw` reports) so the rename can be checked against the naming rules.
No findings → the report is the single line `Nie wykryto problemów.`; empty diff → `Nie wykryto zmian do analizy.`

## Mechanics

`scripts/review-context.cjs` (Node, zero dependencies) does all deterministic work: base-branch detection, changed-file listing, changed-line ranges, instruction matching, report paths and ready-to-run git commands.
Branch reviews never touch the working tree (`git diff base...branch`, `git show branch:path`); staged reviews first run `git add .`, then read index content (`git show :path`).

`scripts/render-report.cjs` (Node, zero dependencies) parses the assembled Markdown report and renders the HTML page, then removes the Markdown — but only after a warning-free parse.
Run it by hand with `node scripts/render-report.cjs --report=<path.md> [--project=<repo root>] [--mode=branch|staged|folder] [--branch=<name>] [--base=<name>] [--out=<path.html>] [--keep-source]`.
It reads the per-file coverage markers too: `<!-- coverage: <path> <checked>/<total> -->` warns (and keeps the Markdown) when the walk fell short, while `<!-- coverage: <path> mechanical -->` is the complete proof for a file the mechanical-change gate narrowed to its two questions.
Every finding also carries a collapsible code snippet showing the cited lines with three lines of context, highlighted in the finding's severity colour.
`--mode` decides what the snippet is: `branch` reads `git show <branch>:<path>` plus `git diff -U0 <base>...<branch>`, `staged` reads the index plus `git diff -U0 --cached`, and both render a real before/after split diff; `folder` (and a missing `--mode`) renders the working-tree file with no diff markers.
The old-file line numbers the left side prints are derived from the `-U0` hunk headers, which state how far the old numbering runs ahead of the new one from each hunk on.
The full source of every file with a finding is embedded once per file, so a file with four findings carries one copy, not four.
Files longer than 3000 lines are left out and the `Cały plik` button reports the count instead — the fragment still renders.
`--project` names the root the report paths are relative to; when it is omitted the root is recovered from a report living in `<project>/.claude/doh/<branch>/`, and a file that cannot be read simply renders without a snippet.
It accepts the severity lead line with and without a leading `- ` (reports written before `ee76300` use the dashed form), and reads `**Reguła:**` whether the instruction is named with its `.md` extension, without it, or replaced by the violated point's name.

`scripts/github.cjs` (Node, no dependencies) is the only place that talks to GitHub: the owner/repo read off the remote URL, the token lookup, and the three calls the skill needs (find the open PR, read its diff, post the review).
`fetch` is asynchronous while every script around it is not, so the request runs in a child copy of that file — the parent hands it a JSON request on stdin and reads the JSON response off stdout, which keeps the calling scripts synchronous.

`scripts/post-pr-comments.cjs` (Node, no dependencies) posts the *accepted* findings of a rendered HTML report as a PR review.
The report page cannot do it itself — a `file://` page has no GitHub credentials — so when an open PR exists for the reviewed branch the renderer adds a **Dodaj komentarze do PR #n** button that hands over the ready command, carrying the accepted pool of that browser as `--include=<ids>` — those findings, and only those, are posted.
Finding the PR needs no credentials on a public repository; a private one needs a token for the lookup as well, and posting the review always does (see [GitHub access](#github-access)). When the lookup cannot run, the reason is printed to stderr *and* shown on the report page itself, so a missing button is never left unexplained.
Run it by hand with `node scripts/post-pr-comments.cjs --report=<path.html> --include=<ids> [--project=<repo root>] [--pr=<number>] [--dry-run]`.
`--include` is the accepted pool and the only thing that ever reaches GitHub: a finding nobody accepted is never posted, and a command without `--include` refuses to run. `--all` is the deliberate way past that for a command run by hand with no page to accept anything in, and only then does `--exclude=<ids>` mean anything.
A comment body carries the finding's English `PR Problem` and `PR Expected` wording (`**Expected result:** …`) plus its `PR Locations` list (`**Where to change:** …`), so the reviewer sees what is wrong, what the result should be and which files and symbols the fix touches — but no severity, no violated rule and no Polish; the Polish report keeps all of that for the reader.
Findings anchored on lines the PR diff shows become inline review comments (a whole cited range becomes a multi-line comment); the rest are listed in the review body, because GitHub rejects an inline comment outside the diff. Reviews are posted in batches of 50 comments.

Tests: `node --test skills/codeReview/scripts/review-context.test.cjs skills/codeReview/scripts/render-report.test.cjs skills/codeReview/scripts/post-pr-comments.test.cjs skills/codeReview/scripts/github.test.cjs`
(paths are listed explicitly because PowerShell does not expand globs for native commands).
