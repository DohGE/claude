# /codeReview — deterministic instruction-driven code review

Part of the `doh` plugin.
Reviews git changes against instruction checklists and writes one concise report per reviewed branch — an interactive HTML page by default, Markdown with `--only-md`.
Reports are always written in Polish.
Report-only: the skill writes no code and makes no commits; the sole repo side effect is `git add .` in staged mode, which stages every pending change before reviewing it.
Single-agent: the invoking agent performs every step itself and never dispatches sub-agents, even for multiple branches or large diffs.
Full coverage: every file in the diff and every checklist item of every instruction in that file’s plan is evaluated on every run — the reviewer never skips files or rules; only the context script excludes generated, binary and prose files.
Reporting scope is narrower than coverage: only violations carried by the lines the diff touched are reported (see [Review scope](#review-scope)).

## Usage

| Invocation | Scope |
|---|---|
| `/codeReview` | current branch vs its base — the target branch of its open PR, else the branch it was created from (see [Base branch detection](#base-branch-detection)) |
| `/codeReview staged` | all uncommitted changes (runs `git add .` first, then reviews the git index against `HEAD`) |
| `/codeReview feature/a,feature/b;hotfix/c` | each listed branch (`,` or `;` separated) vs its own detected base; one report per branch |
| `/codeReview folder src/app/user-panel` | every file currently in that folder of the working tree — no diff needed, so every line counts as changed |
| `/codeReview [target] --only-md` | any of the above, but the report stays Markdown and no HTML is rendered |
| `/codeReview [target] --project=<path>` | any of the above, but against the repository at `<path>` instead of the current directory |

A branch list is split on `,` and `;`. Git allows both characters inside a ref name, so a branch
literally called `feature/a,b` cannot be named in that list — it would be read as two branches and
reported as two "Branch not found" errors for names you never typed. Check that branch out and run
`/codeReview` with no arguments instead: auto mode reviews the current branch without naming it.

`--only-md` may sit anywhere in the arguments and is stripped before the rest is mapped to a mode.
The two formats are mutually exclusive: HTML mode leaves no `.md` behind, `--only-md` renders no HTML.

`--project=<path>` moves the whole review to another repository: which tree is read and (in `staged`
mode) staged, where the reports land, and which `CLAUDE.md` and `.claude/doh/instructions/` bind.
Without it everything is relative to the current working directory. Pass it whenever the code you
want reviewed is not where your shell is — most importantly from a `git worktree`, which is how
implementNewFeature runs every task after the first; its review agent passes the task's own root on
every cycle, so one task's review can never stage or report on another task's tree.

Branch names are sanitised for the filesystem, so two branches can land on one name — `feature/x` and `feature-x` both become `feature-x`. Reviewing both in one run would overwrite the first report with the second and make them share one `--since-last` snapshot; the context script warns and names both branches, and the fix is to review them in separate runs.

Reports are grouped per branch: every report of a branch lands in `reports/{branch}/` inside this skill, named `{branch}-{YYYY-MM-DD}-{HH-mm}.html` (staged variant: `{branch}-staged-{YYYY-MM-DD}-{HH-mm}.html`, folder variant: `{branch}-folder-{path}-{YYYY-MM-DD}-{HH-mm}.html`), or the same name with `.md` under `--only-md`.
A multi-branch run writes one folder per reviewed branch. The branch stays in the file name too, so the HTML page's `localStorage` key (namespaced by file name) never collides between branches reviewed in the same minute.
When the reviewed project has its own `.claude/` folder, reports go to `<project>/.claude/doh/{branch}/` instead.
Branch names are sanitized for file and folder names (any character outside `A-Z a-z 0-9 . _ -` becomes `-`); the time uses `HH-mm` because `:` is not allowed in Windows file names.
Only the 30 newest reports are kept — older ones (either format, in any branch folder) are pruned automatically at the start of a run, and a branch folder emptied by that pruning is removed with them.
Pruning counts only run-stamped report names (`…-YYYY-MM-DD-HH-mm.md|html`), so it shares `.claude/doh/` with implementNewFeature's session folders and the project's `instructions/` without ever touching them.

`--since-last` turns a run into a re-review: every run records the post-image blob of each reviewed file in `.last-review-<kind>.json` next to the report, and the next incremental run drops the files whose blob has not moved (they are listed in a warning, and the previous report stays the reference for them).
It is meant for a target already reviewed in this session — the implementNewFeature review loop uses it from cycle 2 on; on a first review it warns and reviews everything.
The snapshot is recorded while the context is built, before the first file is analyzed, so it says what the previous run intended to review rather than what it completed. A run that died half-way still recorded every file, and the next `--since-last` will skip the ones it never reached — an unchanged tree then reports "nothing to review". After an interrupted review, re-run the target in full instead. The same applies once the previous report has been pruned away: the run warns that nothing on disk covers the skipped files any more.

Each analyzed file ends its block with the checklist it was walked against — one ticked line per item — and a coverage marker, `<!-- coverage: <path> <checked>/<total> -->`, `<total>` being the number of checklist items the context script counted for that file. See [Checklist coverage](#checklist-coverage).
Three groups of files are excluded from review and listed in one `Pominięto pliki wygenerowane/binarne:` line of the report:

- **generated** — lockfiles, `*.min.*`, source maps, `dist/`/`build/`/`out/`/`coverage/`/`node_modules/`/`.angular/`/`.idea/` output, plus code generated INTO the source tree where the convention says so: `__generated__/`, `*.generated.*`, `*.gen.ts`, `*.g.ts`, `*.pb.ts`, `*_pb.{ts,js}`. A folder merely named `generated/` is NOT skipped — the name alone does not prove nobody maintains it by hand;
- **binary** — images and `*.svg`, fonts, archives, PDFs, audio/video, executables, `*.wasm`;
- **prose** — `*.md`, `*.markdown`, `*.txt`, `*.rst`, `*.adoc`, and `CHANGELOG`/`LICENCE`/`LICENSE`/`NOTICE`/`AUTHORS`.

The third group is the one to know about: a documentation-only change is never reviewed, and the report still files it under the "wygenerowane/binarne" label, which describes the other two groups rather than this one. Nothing is lost — the instruction checklists are about code — but do not read an untouched `README.md` in the skipped list as a claim that the file is generated.

## Instructions

Review rules live in two folders inside this skill (they start empty — add your own):

- `instructions/global/**/*.md` — apply to every reviewed file, unless the file itself narrows that with `applies-to` globs (subfolders are scanned recursively).
- `instructions/local/**/*.md` — apply only to files matching the `applies-to` globs declared in their frontmatter (subfolders are scanned recursively).

A reviewed project can also carry its own rules in `<project>/.claude/doh/instructions/`, with the same `global/` + `local/` layout.
That folder is layered on top of the skill's tree: a file at the same relative path (`global/security.md`) replaces the skill's version, any other file is one more instruction.
It is reported as `projectInstructionsDir` in the context JSON, the implementNewFeature coding rulebook layers it the same way, and the `.claude/doh/.gitignore` written for run artifacts explicitly un-ignores it so the rulebook can be committed and shared.

The reviewed project's own `CLAUDE.md` (repo root, if present) is loaded as an additional global instruction.
Files with no matching local instruction are still reviewed against all global instructions and the universal points (cross-file consistency incl. architecture and naming, regressions, readability); performance, security, architecture, accessibility (WCAG 2.2 level AA — always 🟡 Medium), code quality (duplication, dead/unnecessary/boilerplate code, every added comment, inconsistency — always 🟡 Medium) and test coverage are covered by the dedicated global instruction files.

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

A global instruction is the same file placed under `instructions/global/`. It may declare `applies-to` too, and is then narrowed by path exactly like a local one — a global WITHOUT the key applies to every file, so narrowing is opt-in and silence means everywhere (`accessibility.md` limits itself to templates, styles, components and directives this way).
List items under `applies-to:` must be indented, one `- pattern` per line; quotes around patterns are
optional. The block form is the ONLY form: a YAML flow sequence on one line — `applies-to: ["**/*.ts"]`
— parses to no patterns at all, and the two instruction kinds then fail in opposite directions.
A LOCAL with no pattern then matches nothing; a GLOBAL with no pattern is indistinguishable from a
global that never declared one, so it binds EVERY reviewed file — doing more than its author asked
rather than less. Both are reported: a declared `applies-to` that yields no pattern warns on its own,
naming which of the two directions this instruction just failed in.
Note the asymmetry that makes this easy to walk into: the inline form DOES work one level down, under
`scopes:` (`markup: ["**/*.html"]` parses fine), so an author whose `scopes:` line works has every
reason to expect `applies-to: [...]` to work too. It does not. Only `applies-to` insists on bullets.
A local instruction without any including `applies-to` pattern never matches and is reported as a warning.

**Checklist items must start with `- `, at the left margin.** That is what `<id>#<n>` counts, so the
marker is part of the format, not a style choice: an item written `* rule` or `+ rule` is not counted,
and a file whose items are ALL written that way has zero items — it is then dropped from every plan,
from `checklistIds` and from the catalog, because an instruction with nothing to check has nothing to
say. That drop is reported too: an instruction with no readable items warns by name, so the bullet
character is named as the cause instead of leaving you to debug the glob.
Indented `- ` sub-bullets under an item are safe: they are not counted and do not shift the numbering,
so an item may carry sub-points without moving `#12` to `#14`.

Any instruction may also declare a one-line `gate:` — a precondition the reviewer answers from the file’s CONTENT before walking the items, for what a glob cannot see (a `.ts` file holding no markup, a barrel carrying no behaviour). A failed gate collapses the whole instruction into one ticked range line naming what is absent; an unclear answer means the gate holds and the items are walked. Gates reach the reviewer as the top-level `checklistGates` map.

### Per-item scopes

`applies-to` narrows a whole instruction; `scopes:` narrows a single checklist item, so one topic can stay in one file while each of its rules is walked only where it can be answered.
A scope is a name and a glob list (inline or as an indented list, `!` excludes included), and an item opts into one or more of them with a leading `{tag}`:

    ---
    name: Accessibility — WCAG 2.2 level AA
    applies-to:
      - "**/*.html"
      - "**/*.scss"
    scopes:
      markup: ["**/*.html"]
      styles: ["**/*.scss", "**/*.css"]
    ---
    ## Checklist
    - {markup} Every `<img>` carries a text alternative
    - {markup, styles} Contrast ratios hold for every colour pair the diff introduces
    - Every rule without a tag is walked wherever the instruction applies

An item is walked when its instruction matches the file AND (it carries no tag OR the file matches one of its tagged scopes).
Numbering never moves: `<id>#<n>` stays the n-th bullet of the file, so narrowing a checklist changes which numbers a file walks, never what they mean.
An instruction every item of which is out of scope for a file drops out of that file's plan entirely — it is not read, walked or ticked for it.
A tag naming a scope the frontmatter does not declare keeps the item (a typo must never delete a rule) and is reported as a warning, as is a declared scope no item uses.

### Glob subset

`**` matches any number of directories, `*` matches within one path segment, `?` matches a single character.
Matching is case-sensitive, against `/`-separated paths relative to the repo root.
Everything else is matched literally. Brace alternation (`{ts,html}`) is therefore literal too — it matches nothing, and the context script warns about it rather than letting the instruction fall silent.

A pattern starting with `!` EXCLUDES what it matches, and an exclude always wins over an include — which is how a broad instruction carves out a folder it has nothing to say about (`test-coverage`, `performance`, `security` and `accessibility` all declare `"!**/models/**"`, because a folder of consts, interfaces, enums and types has no behaviour to test, no render cost, no attack surface and no UI).
A global with only excluding patterns covers everything except them; a local still needs at least one INCLUDING pattern, or it never matches and is reported as a warning.

## Checklist coverage

The context script hands every file its own ticking plan: `checklist` lists one `<id>:<items>` entry per instruction that applies to that file (globals first, then the matched locals), where `<items>` names WHICH items the file walks — `general:1-13` for a full checklist, `accessibility:6-9,12-14,17,20` for one the file's kind narrowed. `checklistTotal` is their sum, and the top-level `checklistIds` says which instruction file each id stands for.
Globals narrowed by `applies-to` drop out of the plans of files they do not cover, and `globalInstructionsSkipped` names them per file so a shorter plan reads as a decision rather than an omission; `globalInstructions` itself lists only the globals at least one reviewed file walks, so a diff of stylesheets never loads the TypeScript rulebook.
Item `<id>#<n>` is the n-th top-level `- ` bullet of that instruction — the address the reviewer ticks it off under, whether or not the file walks every neighbour.

The reviewer walks that list item by item and writes the result next to the file's findings, as one HTML comment block per file:

    <!-- checklist: src/app/user.component.ts
    [x] accessibility#3,#10-11,#15-16 — BRAMKA: plik nie buduje DOM ani nie zarządza fokusem
    [x] general#1-5,#7-13 — OK (brak wystąpień)
    [x] general#6 nazwy const camelCase — NARUSZENIE (L12, L18)
    [x] component#1 OnPush — NARUSZENIE (L4)
    [x] component#2-14,#16-27 — OK (brak wystąpień)
    [ ] component#15 walidatory runtime — NIEZWERYFIKOWANE: formularz w klasie bazowej
    -->
    <!-- coverage: src/app/user.component.ts 96/97 -->

Items of one instruction that share a verdict are collapsed into ONE line addressed by a range or list of ranges (`general#1-5,#7-13`); expanded, the block still holds exactly `<total>` items, each exactly once. `NARUSZENIE` and `NIEZWERYFIKOWANE` keep their own line and their own short label, while a collapsed OK or BRAMKA range needs none — the address is the reference.
`[x]` is set only for an item checked 100%: `OK (<lines or "brak wystąpień">)` when the file complies, `NARUSZENIE (<lines>)` when the item produced the finding above it, `BRAMKA: <what is absent>` when the instruction’s gate failed for this file.
Anything the reviewer could not verify stays `[ ]` with the reason — an honest gap, not a rounding error.
A file whose whole diff is mechanical writes `<!-- coverage: <path> mechanical -->` and no block: its walk was the gate's two questions, not the checklist.

The renderer expands every range and recounts the ticks instead of trusting the marker: a missing block, a block shorter than `<total>`, a marker the ticks do not back up, an item ticked twice by overlapping ranges, a malformed range, an id that matches no instruction file (a mistyped `a11y#1-30` would otherwise count toward coverage as if `accessibility` had been walked) and an unticked item all become warnings, and the ticked lines become the page's **Pokrycie checklist** section.

Any warning keeps the Markdown next to the HTML, but the two kinds mean opposite things. A `nierozpoznana`/`nieczytelny` warning is a line the parser could not read: the report drifted from the format and the HTML lost that finding or that tick — worth fixing. A `sprawdzono <checked>/<total>` warning is the parser succeeding: the block was read perfectly and simply carries an item left `[ ]` with its reason. That is the honest gap above, working as designed — never close it by ticking an item nobody checked. (Two more warnings go to stderr only and never keep the Markdown, because neither says anything about the format: a report with no coverage markers at all, and a failure to detect the pull request.)

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
- **Pokrycie checklist** — a collapsed section under the findings: one row per analyzed file with its `<checked>/<total>`, opening to every checklist item the reviewer walked, marked ✓ compliant, ✗ reported or ○ unverified. A file that did not finish its walk shows its count in the High colour. It is the one part of the page no filter touches, and a report with no findings still carries it.
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
    - **Problem:** Gałąź błędu efektu kończy się `EMPTY`, więc porażka żądania nie dociera do reduktora
    - **Reguła:** instructions/local/code/+state/ngrx-effects.md → "Ścieżka błędu nigdy nie kończy się `EMPTY`"
    - **Expected Result:** `catchError` zwracający `of(loadUsersFailure({ error }))` wewnątrz `switchMap`
    - **PR Problem:** The `loadUsers$` effect swallows the failure: its `catchError` returns `EMPTY`, so no failure action ever reaches the reducer. The `loading` flag stays `true`, the spinner never stops and the user is told nothing.
    - **PR Expected:** A failed request should end in a failure action that clears `loading` and fills the error state. Return `of(loadUsersFailure({ error }))` from `catchError` inside the `switchMap`, handle that action in the reducer and render it through the existing error branch of the template.
    - **PR Locations:** `user-panel.effects.ts` → `loadUsers$`, `user-panel.reducer.ts` → `loadUsersFailure`, `user-panel.effects.spec.ts` → failing-request case

`PR Problem`, `PR Expected` and `PR Locations` are the only English fields, written for the PR comment and used nowhere else on the page.
They are written for a reviewer who never opens the report: `PR Problem` gets two sentences (what is wrong + the consequence), `PR Expected` two to three (the target state + how to reach it), and `PR Locations` lists every file and symbol the fix touches — every concrete name the Polish fields propose has to appear in them.

Severity: ⚪ Low · 🟡 Medium · 🔴 High · 🟤 Critical · 🔵 Missing Unit Test.
Every file also carries its ticked checklist and coverage marker as HTML comments — see [Checklist coverage](#checklist-coverage).
Line numbers refer to the file's real content (read off the line-numbered `git show … | cat -n` output), never to diff hunk numbering.
The context script additionally precomputes each file's changed-line ranges (`changedLines`, from `git diff -U0`) as the authoritative list of lines the diff touched, and carries the source path of a renamed file (`oldPath`, from the rename pair `git diff --raw` reports) so the rename can be checked against the naming rules.
No findings → the report is the single line `Nie wykryto problemów.`; empty diff → `Nie wykryto zmian do analizy.`

## Mechanics

`scripts/review-context.cjs` (Node, zero dependencies) does all deterministic work: base-branch detection, changed-file listing, changed-line ranges, instruction matching, report paths and ready-to-run git commands.
Branch reviews never touch the working tree (`git diff base...branch`, `git show branch:path`); staged reviews first run `git add .`, then read index content (`git show :path`).

`scripts/render-report.cjs` (Node, zero dependencies) parses the assembled Markdown report and renders the HTML page, then removes the Markdown — but only after a warning-free parse.
Run it by hand with `node scripts/render-report.cjs --report=<path.md> [--project=<repo root>] [--mode=branch|staged|folder] [--branch=<name>] [--base=<name>] [--out=<path.html>] [--keep-source]`.
It reads the per-file checklist blocks and coverage markers too, and reconciles them: the ticks are recounted, and a short walk, a missing or malformed block or a marker the ticks contradict warns (and keeps the Markdown), while `<!-- coverage: <path> mechanical -->` is the complete proof for a file the mechanical-change gate narrowed to its two questions. Any other multi-line HTML comment in the report is swallowed whole instead of being read as findings.
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
Findings anchored on lines the PR diff shows become inline review comments (a whole cited range becomes a multi-line comment); the rest are listed in the review body, because GitHub rejects an inline comment outside the diff. Reviews are posted in batches of 50 comments. A summary too long for one review body (GitHub caps it at 65 536 characters, which a folder review of a large area can reach) is split across further reviews, and the posts are spaced a second apart so GitHub's secondary rate limit does not land half of them. If one is refused anyway, the message says how many already reached the PR.

The button is tied to the *branch*, not to the review mode: a `--staged` or `--path` review run on a branch that has an open PR gets it too.
That is intentional but worth knowing — those modes review code the PR diff need not contain, so most or all of their findings end up in the review body rather than pinned to lines.

Tests: `node --test skills/codeReview/scripts/review-context.test.cjs skills/codeReview/scripts/render-report.test.cjs skills/codeReview/scripts/post-pr-comments.test.cjs skills/codeReview/scripts/github.test.cjs`
(paths are listed explicitly because PowerShell does not expand globs for native commands).
