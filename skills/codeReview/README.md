# /codeReview — deterministic instruction-driven code review

Part of the `doh` plugin.
Reviews git changes against instruction checklists and writes one concise report per reviewed branch — an interactive HTML page by default, Markdown with `--only-md`.
The report carries the findings; the checklists every file was walked against stay in it only with `--with-checklist`.
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
| `/codeReview [target] --with-checklist` | any of the above, but the report keeps every file's walked checklist and coverage marker (the page's **Pokrycie checklist** section) |
| `/codeReview [target] --no-batch` | any of the above, but every file is walked in a message of its own instead of small files together (see [Token cost](#token-cost)) |
| `/codeReview [target] --dedup-items` | any of the above, but an item an earlier bundle already showed reaches the reviewer as a reference to that bundle — opt-in until an A/B run shows it costs no finding (see [Token cost](#token-cost)) |
| `/codeReview [target] --project=<path>` | any of the above, but against the repository at `<path>` instead of the current directory |

A branch list is split on `,` and `;`. Git allows both characters inside a ref name, so a branch
literally called `feature/a,b` cannot be named in that list — it would be read as two branches and
reported as two "Branch not found" errors for names you never typed. Check that branch out and run
`/codeReview` with no arguments instead: auto mode reviews the current branch without naming it.

`--only-md`, `--with-checklist`, `--no-batch` and `--dedup-items` may sit anywhere in the arguments and are stripped before the rest is mapped to a mode.
The two formats are mutually exclusive: HTML mode leaves no `.md` behind, `--only-md` renders no HTML.
`--with-checklist` changes only what the finished report keeps: every file is walked, written and checked with its checklist either way, and without the flag the renderer cuts the checklists, the coverage markers and the cross-file `<!-- unverified:` block from it — from the page and from an `--only-md` Markdown alike.
The run's summary still states the coverage, read off the line the assembly prints.

`--project=<path>` moves the whole review to another repository: which tree is read and (in `staged`
mode) staged, where the reports land, and which `CLAUDE.md` and `.claude/doh/instructions/` bind.
Without it everything is relative to the current working directory. Pass it whenever the code you
want reviewed is not where your shell is — most importantly from a `git worktree`, which is how
implementNewFeature runs every task after the first; its review agent passes the task's own root on
every cycle, so one task's review can never stage or report on another task's tree.

Branch names are sanitised for the filesystem, so two branches can land on one name — `feature/x` and `feature-x` both become `feature-x`. Reviewing both in one run would overwrite the first report with the second and make them share one `--since-last` snapshot; the context script warns and names both branches, and the fix is to review them in separate runs.

When the reviewed project has its own `.claude/` folder, everything the review writes lives in `<project>/.claude/doh/codeReview/`; otherwise the same layout sits in `reports/` inside this skill:

```
runs/<YYYY-MM-DD-HH-mm-ss>/<branch>/raport.html | raport.md
cache/<branch>/.last-review-<kind>.json
               .review-context-<kind>.json
               checklists/<kind>/<id>.md
```

Every run gets a folder stamped with its start time, holding one folder per reviewed branch; the report inside is always named `raport` (`.html`, or `.md` under `--only-md`), in every mode.
While a run works, its part files (`raport.partNN.md`), import ledger (`raport.imports.txt`) and work folder (`raport.work/`) sit next to the report and are removed once it is assembled.
The HTML page's `localStorage` key is `<stamp>/<branch>/raport.html`, so it never collides between runs or branches.
`cache/<branch>/` keeps what outlives a run: the `--since-last` snapshot, the context of the latest run, and the numbered checklists it read.
Branch names are sanitized for folder names (any character outside `A-Z a-z 0-9 . _ -` becomes `-`); the time uses `HH-mm-ss` because `:` is not allowed in Windows file names.
Only the 30 newest branch folders under `runs/` are kept — older ones are pruned at the start of a run, together with a stamp folder emptied by that. `cache/` is never pruned.
Reports written before this layout (`.claude/doh/{branch}/{branch}-…md|html`) stay where they are; a `--since-last` snapshot found there is moved into `cache/<branch>/` on the next run.

`--since-last` turns a run into a re-review: every run records the post-image blob of each reviewed file in `cache/<branch>/.last-review-<kind>.json`, and the next incremental run drops the files whose blob has not moved (they are listed in a warning, and the previous report stays the reference for them).
It is meant for a target already reviewed in this session — the implementNewFeature review loop uses it from cycle 2 on; on a first review it warns and reviews everything.
The snapshot is recorded while the context is built, before the first file is analyzed, so it says what the previous run intended to review rather than what it completed. A run that died half-way still recorded every file, and the next `--since-last` will skip the ones it never reached — an unchanged tree then reports "nothing to review". After an interrupted review, re-run the target in full instead. The same applies once the previous report has been pruned away: the run warns that nothing on disk covers the skipped files any more.

An interrupted review resumes by itself: a run that died before its assembly leaves its part files (`raport.partNN.md`) in its run folder, and the next run of the same target picks them up.
The context script lists every file whose part already carries a coverage marker in `target.resume.doneFiles`, points `reportPath` at the interrupted report, and the review analyzes only the rest before writing the cross-file pass anew.
A part the check had refused and the run never promoted comes back as its draft (`target.resume.drafts`): the resumed run promotes it instead of walking that file again.
It resumes only while the `.last-review-<kind>.json` snapshot proves the target still holds the content that run reviewed; otherwise it warns, names the run folder to delete and starts from scratch.
In folder mode, where no content is recorded, it resumes only for the same folder and warns that it did not check the content.
A resumed run keeps the file list it started with, so `--since-last` is ignored for it.
After a break longer than an hour (a usage limit, a closed laptop) run `/clear` and then the same command instead of typing "continue": the finished files come back from their parts, while "continue" would re-read the whole old conversation at cache-write price.
A compaction in the middle of a run needs nothing from you: the plugin's hook tells the compacted session where the run stands and what to read again (see [Mechanics](#mechanics)).

Each analyzed file ends its block with the checklist it was walked against — one ticked line per item — and a coverage marker, `<!-- coverage: <path> <checked>/<total> -->`, `<total>` being the number of checklist items the context script counted for that file; the finished report keeps both only under `--with-checklist`. See [Checklist coverage](#checklist-coverage).
Three groups of files are excluded from review and listed in one `Pominięto pliki wygenerowane/binarne:` line of the report:

- **generated** — lockfiles, `*.min.*`, source maps, `dist/`/`build/`/`out/`/`coverage/`/`node_modules/`/`.angular/`/`.idea/` output, plus code generated INTO the source tree where the convention says so: `__generated__/`, `*.generated.*`, `*.gen.ts`, `*.g.ts`, `*.pb.ts`, `*_pb.{ts,js}`. A folder merely named `generated/` is NOT skipped — the name alone does not prove nobody maintains it by hand;
- **binary** — images and `*.svg`, fonts, archives, PDFs, audio/video, executables, `*.wasm`;
- **prose** — `*.md`, `*.markdown`, `*.txt`, `*.rst`, `*.adoc`, and `CHANGELOG`/`LICENCE`/`LICENSE`/`NOTICE`/`AUTHORS`.

The third group is the one to know about: a documentation-only change is never reviewed, and the report still files it under the "wygenerowane/binarne" label, which describes the other two groups rather than this one. Nothing is lost — the instruction checklists are about code — but do not read an untouched `README.md` in the skipped list as a claim that the file is generated.

## Token cost

Small files are walked in batches.
Consecutive files of at most 60 lines and 60 checklist items each form one, up to 6 files, 150 lines, 120 items and 50,000 characters of Reads (bundles, contents and diffs) in all; any other file is a batch of its own.
The size cap matters because a small file's bundle is most of what its batch reads: on the 61-file test target, a const file of 2 lines comes with a 15 KB bundle.
One message reads a whole batch — every file's bundle, content and diff — and one message writes its parts, together with the Reads of the next batch, which the batch's last bundle names under `## Dalej`.
Inside a batch every file is still walked on its own, one after another, against its own checklist, and every part is checked as before.
The context lists the batches in `target.batches`, and a bundle's `partia:` line names the files of its batch.
`--no-batch` makes every file a batch of its own.

`--dedup-items` shortens every bundle read after the first: an item an earlier bundle of the run already showed arrives as a reference to that bundle, while the facts and probe hits under it stay this file's own.
A compaction resets it, so the bundles read after one show every item in full again.
It is opt-in until an A/B run (`scripts/score-review.cjs --explain`, see `test-environment/README.md`) shows it costs no finding.

A compaction re-attaches only the head of `SKILL.md`, so that file is ordered by need rather than by step.
What the walk of every file needs comes first; Steps 1–2, which run once, stand after a `<!-- one-time:start -->` marker; the cross-file pass and the assembly are `references/cross-file.md` and `references/assembly.md`, read when the run reaches them.
After a compaction the plugin's hook names where the run stands and what to read again (see [Mechanics](#mechanics)).

Every MCP server of a session costs tokens on every request — its tool names and its instructions — while the review calls no MCP tool but headroom's `headroom_retrieve`, for a tool output the headroom proxy compressed.
A session that loads only that server is leaner:

    claude --strict-mcp-config --mcp-config review-mcp.json

with `review-mcp.json`:

    { "mcpServers": { "headroom": { "type": "stdio", "command": "headroom", "args": ["mcp", "serve"] } } }

`--strict-mcp-config` ignores every other MCP configuration, the claude.ai connectors included; the skill, its hooks and the plugins load as usual.
Without the headroom proxy, `{ "mcpServers": {} }` in that file starts the session with no MCP server at all.

## Instructions

The review rulebook is `instructions/`: one JSON file per **file kind** — a feature component, its template, an NgRx reducer, the spec of each, a config file, … — with `other` for every path no other kind identifies.
A kind says where its files live and carries the whole checklist such a file is walked against:

    {
      "kind": "ngrx-reducer",
      "pattern": "src/app/<area>/data-access/+state/<name>.reducer.ts",
      "role": "Reducer of a feature slice.",
      "itemCount": 65,
      "instructions": [
        {
          "id": "ngrx-reducer",
          "name": "NgRx Reducer",
          "selectedItems": "1-18",
          "checklistSize": 18,
          "items": [
            { "id": "ngrx-reducer#1", "text": "File lives in `<area>/data-access/+state/<area>.reducer.ts`; …" },
            …
          ]
        },
        …
      ]
    }

- `kind` names it, and `role` says in one line what such a file is; optional `notes` tell the reviewer what the checklist alone does not (why an unusual instruction is in the plan, what a finding there means).
- `pattern` is where the files live — one pattern or a list of them, see [Patterns](#patterns).
- `instructions` is the plan, in the order it is walked: one entry per instruction, holding the items this kind walks, every item under its address `<id>#<n>` and with its text.
  `selectedItems` (those numbers), `checklistSize` (how many items the instruction has in all) and the kind's `itemCount` are checks: a count that disagrees with the items listed is reported as a warning.

An item may carry seven more keys, each checked when the rulebook loads, so a typo warns instead of silently binding nothing:

- `facts` — the repository fact kinds (`scripts/repo-facts.cjs`) that contradict an OK on this item, e.g. `["export-unused", "barrel-unused"]`.
  A fact of such a kind found in a reviewed file is printed under the item in that file's bundle as a `FAKT` line, and the part check refuses a clean verdict that does not answer it.
- `probe` — one probe or a list: code that often breaks the item (`{ "pattern": "<regex>", "message": "…" }`), code that should be there and is not (`{ "absent": "<regex>", "anchor": "<regex>", "message": "…" }`), a built-in scan (`{ "builtin": "for-without-empty" }`) or a fact kind that points rather than contradicts (`{ "fact": "export-single-importer" }`).
  A hit is a `SONDA` line of the bundle: it never makes a finding by itself, it names a line the item's verdict must answer.
- `secondQuestion` — one question an OK on the item must also answer (`drugie pytanie: <answer>`).
  It is kept for the items the scorer's false-OK list (`scripts/score-review.cjs`, see `test-environment/README.md`) shows ticked OK where the answer key has them broken and the entry went unreported, and which no `facts` or `probe` of the item would have contradicted.
- `answer` — the script's answer to that question, computed from the whole repository: `repo-search` (every literal, condition with a value and label mapping of the file, with how many other files hold it) or `input-binding` (where `withComponentInputBinding()` is on, and where route parameters are read by hand).
  The bundle prints it under the question as `odpowiedź skryptu:`, so the review cites it instead of running that search again; a file the literal passes do not read (a spec, a stylesheet) gets no `repo-search` answer, and facts read from part of the repository give none at all.
- `severity` — the severity every finding naming the item is reported with (`critical`, `high`, `medium`, `low` or `missing-unit-test`), in place of its instruction's (see below); the bundle prints it under the item as `ważność stała:`.
- `sameAs` — the items one defect breaks together with this one, each naming this one back.
  A bundle whose plan holds both prints `ta sama wada:` under the item, and such a defect is ONE finding naming both addresses.
- `unverified` — the prepared `NIEZWERYFIKOWANE` reason of an item no review can settle from the files (the order the tests run in, a green spec run), opening with `narzędzie:`, `poza recenzją:` or `działająca aplikacja:`.
  The bundle prints the whole verdict line under the item as `gotowy werdykt:`, and the part copies it unless it reports a `NARUSZENIE`.

An instruction appears in every kind that walks any of it, and its items keep their numbers everywhere: `security#7` (no secrets in the diff) is the same rule in `ngrx-reducer`, which walks `security:7-8,13`, and in `other`, which walks `#7` alone.
So narrowing a checklist changes which numbers a kind lists, never what a number means.
Two kinds of one layer that disagree about an item's text or its other keys, or about an instruction's `name`, `gate`, `findings`, `preamble`, `checklistSize` or `severity`, are an edit that reached one copy only: it is reported, and the file first in path order wins.

`preamble` holds the paragraphs the reviewer reads before an instruction's items — what the instruction owns and what it leaves to another one.

An instruction may declare a one-line `gate` — a precondition the reviewer answers from the file's CONTENT before walking the items, for what a pattern cannot see (a `.ts` file holding no markup, a barrel carrying no behaviour).
A failed gate collapses the whole instruction into one ticked range line naming what is absent; an unclear answer means the gate holds and the items are walked.
Gates reach the reviewer as the top-level `checklistGates` map.

An instruction may also declare `findings: "per-file"` when its items are facets of one requirement rather than separate ones.
`test-coverage` does: a file without a spec leaves its branches, failure paths and edge cases untested at once, and that is one defect to fix.
A file's breaches of such an instruction are one finding naming every item broken, and the part check refuses a second one.
A test-coverage finding asks only for the tests the fixed code still needs: never for logic another finding moves out of the file or deletes as a duplicate, never for a spec an item forbids (`http-service#14`).
Code another finding calls consumer-less keeps every other finding, missing tests included.
Without the key every item is its own requirement, so the part check refuses a finding naming two items of one instruction.
The ids reach the reviewer as the top-level `checklistPerFile` list; any other value warns and is ignored.

An instruction may fix the severity of its findings the same way, with `severity` on the instruction; an item's own `severity` wins over it.
The bundle prints it under the instruction's heading as `Ważność stała:`.
A finding naming several addresses takes the highest severity they fix — or the reviewer's own, when one of its addresses fixes none and the reviewer's is higher.
The assembly sets that severity on every finding, whatever the part said, and prints how many it changed.

Performance, security, architecture, accessibility (WCAG 2.2 level AA — always 🟡 Medium), code quality (duplication, dead/unnecessary/boilerplate code, every added comment, inconsistency — always 🟡 Medium) and test coverage have instructions of their own, walked by every kind they concern.
The reviewed project's own `CLAUDE.md` (repo root, if present) is one more rulebook: its rules decide verdicts and override conflicting checklist items, but get no `<id>#<n>` of their own.
Every file is also reviewed against the universal points (cross-file consistency incl. architecture and naming, regressions, readability), whatever its kind.
A regression there is behavior the change breaks — a crash, a wrong result, a flow the user cannot finish.
A performance, security, architecture or test-coverage concern counts only through its own checklist, never as a universal point, so what none of its items names is not reported.

A reviewed project can also carry its own kinds in `<project>/.claude/doh/instructions/` (every `.json` under it), layered on top of the skill's:

- a project kind of the same `kind` name REPLACES the skill's kind — its pattern and its plan with it;
- any other project kind is one more kind;
- an instruction a project kind lists overrides, in every kind, only what it restates: its `name`, `gate`, `findings`, `preamble`, `checklistSize` or `severity`, and the texts of the items it lists.
  Everything else keeps the skill's text.

Markdown files in that folder are the rulebook format from before kinds existed: they are ignored, and named in a warning.
The folder is reported as `projectInstructionsDir` in the context JSON, the implementNewFeature coding rulebook layers it the same way, and the `.claude/doh/.gitignore` written for run artifacts explicitly un-ignores it so the rulebook can be committed and shared.

### Matching

A reviewed file walks the checklist of the ONE kind that describes its path most specifically, compared in this order:

1. the literal characters of the pattern's file-name segment — `<name>.component.html` beats `*.html` wherever both match;
2. a match of the whole path beats a match of the file name alone;
3. the literal characters of the pattern's folders.

A kind still matches by file name alone when the file sits somewhere its pattern does not expect: a `user.actions.ts` outside `+state/` is still NgRx actions, reviewed as such, and its misplacement is one of the kind's own items.
`"exactLocation": true` turns that off — the kind then covers only the paths its pattern spells out, which is how `component-folder-directive` takes a directive only while it sits in a components folder.
Two kinds describing a path equally well are a rulebook defect: the context warns, and the file is reviewed as the project's kind before the skill's, then as the one first by name.
A path no kind describes is warned about and reviewed only against `CLAUDE.md` and the universal points; with the shipped `other` kind that happens only when a project replaces `other` with a narrower pattern.

### Patterns

A pattern is a `/`-separated path, matched case-sensitively against the END of the path relative to the repo root, so `src/app/<area>/…` also covers the same tree inside a workspace (`apps/web/src/app/<area>/…`).

- `<name>` (any word in angle brackets) is one or more characters of one path segment; the word only documents what the segment holds.
- `*` is any run of characters within one segment, none included; `**` is a whole segment standing for any number of folders.
- `(a|b)` spells alternatives: `<name>.component.(scss|css)` is two patterns, and groups may nest.
- A list of patterns is one kind covering each of them; the best-matching one scores the path.
- Everything else is literal.

Braces (`{ts,html}`) and a leading `!` are errors: the kind is skipped with a warning naming the pattern.
Write `(ts|html)` instead, and let a more specific kind take the files you meant to exclude.

## Checklist coverage

The context script hands every file a `plan` index into `checklistPlans` — files of one kind share one entry, so the plans grow with the kinds in the diff, not with its files.
A plan names its `kind` and `role` (and `notes`, when the kind has any), and its `checklist` lists one `<id>:<items>` entry per instruction of that kind, in walking order, where `<items>` names WHICH items the file walks — `general:1-13` for a full checklist, `accessibility:6-17,19-21,23-24,27-29` for one the kind narrowed.
`checklistTotal` stays on the FILE and is their sum.
`instructionsCatalog` lists every instruction the run's plans walk, once: its `id`, `name`, `items` (the numbers any plan walks) and `numberedPath`, a copy of just those items kept for a lookup — so a diff of stylesheets never loads the TypeScript rulebook.
The reviewer reads only the instructions' preambles up front (`rulebookNotesPath`), and each item's text in the bundle of the file it is walked on (see [Mechanics](#mechanics)).
Item `<id>#<n>` keeps its number in every kind — the address the reviewer ticks it off under, whether or not the file walks every neighbour.

The reviewer walks that list item by item and writes the result next to the file's findings, as one HTML comment block per file:

    <!-- checklist: src/app/user.component.ts
    [x] accessibility#3,#10-11,#15-16 — BRAMKA: plik nie buduje DOM ani nie zarządza fokusem
    [x] general#1-5,#7-13 — OK (brak wystąpień)
    [x] general#6 importy między obszarami — NARUSZENIE (12, 18)
    [x] component#1 OnPush — NARUSZENIE (4)
    [x] component#2-14,#16-27 — OK (brak wystąpień)
    [ ] component#15 walidatory runtime — NIEZWERYFIKOWANE: poza recenzją: src/app/shared/base-form.component.ts
    -->
    <!-- coverage: src/app/user.component.ts 96/97 -->

Items of one instruction that share a verdict are collapsed into ONE line addressed by a range or list of ranges (`general#1-5,#7-13`); expanded, the block still holds exactly `<total>` items, each exactly once. `NARUSZENIE` and `NIEZWERYFIKOWANE` keep their own line and their own short label, while a collapsed OK or BRAMKA range needs none — the address is the reference.
`[x]` is set only for an item checked 100%: `OK (<lines or "brak wystąpień">)` when the file complies, `NARUSZENIE (<lines>)` when the item produced the finding above it, `BRAMKA: <what is absent>` when the instruction’s gate failed for this file.
Anything the reviewer could not verify stays `[ ]` with the reason — an honest gap, not a rounding error.
The reason names what was missing, after one of three prefixes: `narzędzie:` (a tool the run did not run), `poza recenzją: <path>` (a file outside the review — it must exist, and must not be reviewed itself) or `działająca aplikacja:` (data only the running app has).
The project lacking what an item requires is a `NARUSZENIE`, never a reason.
An item under which the file's bundle printed a fact, a probe hit or a second question gets a line of its own whose verdict answers them: an OK against a `FAKT` carries `fakt nie dotyczy: <why>`, every line a `FAKT`, `WSKAZÓWKA` or `SONDA` points at is cited, and an OK on an item with a second question carries `drugie pytanie: <answer>`.
An item left `[ ]` in 3 or more files is answered once more, for the whole target, in the cross-file part's `<!-- unverified:` block.
A file whose whole diff is mechanical writes `<!-- coverage: <path> mechanical -->` and no block: its walk was the gate's two questions, not the checklist.

The renderer expands every range and recounts the ticks instead of trusting the marker: a missing block, a block shorter than `<total>`, a marker the ticks do not back up, an item ticked twice by overlapping ranges, a malformed range, an id that matches no instruction file (a mistyped `a11y#1-30` would otherwise count toward coverage as if `accessibility` had been walked) and an unticked item all become warnings, and the ticked lines become the page's **Pokrycie checklist** section.
All of that happens under `--with-checklist`; without it the renderer cuts the blocks and markers before it parses, and the coverage is checked by `check-part.cjs` alone, which prints it once the parts pass (`check-part: pliki z pełnym przejściem checklisty: <full>/<files>`, then every file with an open item and its `<checked>/<total>`).

Any warning keeps the Markdown next to the HTML, but the two kinds mean opposite things.
A `nierozpoznana`/`nieczytelny` warning is a line the parser could not read: the report drifted from the format and the HTML lost that finding or that tick — worth fixing.
A `sprawdzono <checked>/<total>` warning is the parser succeeding: the block was read perfectly and simply carries an item left `[ ]` with its reason.
That is the honest gap above, working as designed — never close it by ticking an item nobody checked.
Only a `--with-checklist` run raises it, because otherwise the renderer cuts the blocks unread; the assembly's coverage line names the same gap either way.
(Two more warnings go to stderr only and never keep the Markdown, because neither says anything about the format: a `--with-checklist` report with no coverage markers at all, and a failure to detect the pull request.)

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

## Duplication scan

Every target is scanned for copy-paste by [jscpd](https://github.com/kucherenko/jscpd) before the review starts, and every duplication finding — whether jscpd listed it or the review found it — is reported as 🔴 **High**.

- **What is scanned** — the whole reviewed revision, not only the changed files, because a copy of an untouched file is found only when that file is scanned too: the branch's commit, the index for `staged`, the working tree for `folder` (tracked and untracked files, not the ignored ones). The revision is exported to a temporary folder outside the repository and deleted afterwards; the checkout, the index and every ref stay as they were. Paths the review skips and `.snap` files are left out.
- **What is kept** — only the clone pairs the diff wrote: one side has to be at least half made of changed lines. That side is the copy the finding is anchored on, the other one the source it repeats. Editing one line inside a clone that already existed is therefore not a candidate. jscpd's own `--baseline-from-ref` was measured and rejected for exactly that case: a one-literal edit changes the clone's fingerprint and reads as two new clones.
- **How it matches** — token runs of at least 30 tokens (`--min-tokens 30`), with renamed identifiers (`--ignore-identifiers`) and one or two inserted or dropped lines (`--max-gap-lines 2`) still matching. jscpd's default of 50 tokens was measured on 15 commits of an Angular monorepo: it listed 24 candidates against 67 at 30, and missed e.g. a nine-line mapping copied within one component. Import statements are skipped, because with identifiers ignored any two import lists match. The AST mode (`--similarity`) is off: on the same monorepo 212 of its 235 pairs were the CLI-generated spec skeleton matched against every other spec. The project's own `.jscpd.json` and `package.json#jscpd` are ignored, so its threshold and ignores never decide what the review sees.
- **What the review gets** — `target.duplicationCandidates`, at most 50 per target (the overflow is a warning): `{ path, lines, sources: ["<path>:<from>-<to>"], kinds: ["exact" | "renamed" | "similar"] }`. The reviewer opens both sides of each one and dismisses it only when the blocks share no logic: a shape the framework or a generator dictates (a TestBed skeleton, a module or route declaration, a generated `project.json` or `tsconfig`), parallel data (translation files), or the same syntax around different calls and fields.
- **What jscpd cannot see** — logic written again in other words, or a helper that already exists in a shared folder. For every exported function, class, pipe, directive, validator, util or constant the diff adds, the review therefore searches the reviewed revision itself with `target.commands.grep` (`git grep` over the branch's commit, the index, or the working tree, its matches written to a file of the target's work folder).
- **Running it** — `npx --yes jscpd@5.3.1`, pinned because the report shape is read as that version writes it. Nothing is installed into the project; the first run downloads jscpd into the npx cache, later runs are served from it. A scan that cannot run — no npx, offline on the first run, a timeout after 180 s — never stops the review: it becomes a warning, and duplication is then searched for by the review alone.

Step 1 runs only when a remote points at github.com, and needs no tooling at all — see [GitHub access](#github-access). A call that cannot be made warns once and the run starts at step 2.

## GitHub access

Two features talk to GitHub: the base branch taken from an open pull request, and the report's **Dodaj komentarze do PR** button. Both go straight to the REST API — the `gh` CLI is not required (and not used, beyond being one possible source of a token).

- **Reading** (is there an open PR, what does it target, what is its diff) works **unauthenticated on a public repository**, capped at GitHub's 60 requests/h per IP. A private repository needs a token.
- **Posting** the review always needs a token.

The token is looked up in this order, and the first hit wins:

1. `GH_TOKEN`, then `GITHUB_TOKEN` from the environment.
2. The credential git already stores for github.com — any HTTPS push puts one there (Windows Credential Manager, macOS keychain, `git credential-store`). Asked with `credential.interactive=false`, so a missing credential can never pop a prompt mid-review. Asked twice: once carrying the repository path, which is the only shape a `credential.useHttpPath=true` store matches, then once with the bare host.
3. `~/.netrc` (`_netrc` on Windows) — the `machine api.github.com` entry first, since that is the host these calls go to and the one a netrc written for the API names, then `machine github.com`, and only if neither is present the `default` catch-all. An explicit GitHub entry always outranks `default` whatever the file order, because handing another service's catch-all secret to GitHub is the one mistake this order exists to prevent. This is the first source that can answer for a repository cloned over SSH, since `git@github.com:` remotes never write an HTTPS credential.
4. gh's own `hosts.yml` (`GH_CONFIG_DIR`, `XDG_CONFIG_HOME/gh`, `%AppData%\GitHub CLI`, `~/.config/gh`) — so a machine that was once authenticated with gh keeps working after the binary leaves the PATH.
5. `gh auth token`, if the CLI happens to be installed.

None of these can be conjured for a private repository that has never been authenticated from this machine: there, `GH_TOKEN` is the answer.
The report says which of the two it is — a token was found and refused, or none was found at all — because a private repository answers an anonymous call with the same 404 it gives a token that cannot see it, and only one of those is fixed by setting `GH_TOKEN`.

The value is never logged and never passed on a command line: it reaches the request child on stdin. A repository whose remotes do not point at github.com is never asked and never warns.

## HTML report

The default output is one self-contained page — inline CSS and JS, no fonts, images or CDN requests — so it opens straight from disk over `file://` and survives being copied or attached somewhere else.
It follows the reader's light/dark theme, and a button in the top right corner of the header switches between the two by hand — the pick lands in `localStorage` under one key shared by every report, and is applied before the first paint so a remembered theme never flashes the other one.
The heading names the branches the review compares; when an open pull request was found, its own title and number go under them, and the title is appended to the page's `<title>` as well — the browser tab is where the branch names alone say the least.

- **Code snippet** — every finding carries a collapsible view of the cited lines with three lines of context. When those lines changed, it is a side-by-side diff like GitHub's split view: the file before the change on the left under its own line numbers, after it on the right, the k-th removal facing the k-th addition inside a change block and a blank cell facing whatever has no counterpart. Each side scrolls horizontally on its own. A snippet with nothing changed in it (a folder review, or a finding on a line the diff left alone) stays a single column. A switch in the snippet header swaps between the cited lines and the whole file; the full view renders under the same rules — split diff when the file changed, single column when it did not — highlights the cited lines, scrolls inside its own box and opens on the first highlight. Files over 3000 lines are not embedded, and their switch says so.
- **Pokrycie checklist** (only under `--with-checklist`) — a collapsed section under the findings: one row per analyzed file with its `<checked>/<total>`, opening to every checklist item the reviewer walked, marked ✓ compliant, ✗ reported or ○ unverified. A file that did not finish its walk shows its count in the High colour. It is the one part of the page no filter touches, and a report with no findings still carries it.
- **File tree** — the sidebar maps the whole change, not the review: every path in `git diff --name-status` between the base and the reviewed branch (or in the index, for a staged review), nested by directory, with chains of single-child directories folded into one row the way GitHub folds them. The name says what the change did to the file, in the diff's own colours: green for a file it introduced, yellow for one it only touched (a rename or a copy included — it appears solely under the name the change leaves it with), struck-through red for one it removed. A deleted file is otherwise left out, since it is not part of the structure the change ends with, unless it drew a finding — no finding is ever left without a row. Whether a file drew one is the icon's job instead: a file written about is marked with the severity badge of the worst finding the current filters leave in it, the same 🟤🔴🟡⚪🔵 the finding itself carries, followed by how many there are. Every row reserves the slot whether or not it fills it, so one icon never pushes its neighbours' names out of line. The counts and the badges move with the filters, the structure does not, and a file with nothing to show keeps its row. Clicking a file with findings opens and flashes its section. A folder review has no diff, and an older report was rendered before the tree carried one, so both fall back to the files that were reported on.
- **Severity filter** — one toggle chip per severity present in the report, with a count.
- **Rule filter** — a two-level checkbox tree: instruction file, expanding to its concrete rules. Toggling the file toggles all of its rules; a partial selection shows an indeterminate parent. A finding stays visible while at least one of its rules is selected, so a finding citing two rules survives either way.
- **Grouping** — `Pliki` (one collapsible section per file, in report order) or `Globalnie` (one flat list sorted by severity, then path); the flat list labels each finding with its file.
- **Accepting** — `Akceptuj` collapses a finding to its head line, marks it as belonging to the pool that goes to the PR (`✓ W puli komentarzy PR`) and turns itself into `Cofnij akceptację`, which restores the previous state. The toolbar shows `Zaakceptowane: N`; the accepted ids live in `localStorage` next to the ignored ones. That pool is the only thing **Dodaj komentarze do PR** sends — nothing accepted means no comment is posted.
  Next to the count, `Kopiuj ID` copies the bare ids of the accepted findings, comma-separated and in report order — the same list the PR command carries in `--include`, for anyone assembling that call by hand. It is disabled while the pool is empty, and says `Skopiowano` or `Nie udało się skopiować` for a moment afterwards instead of leaving the press unanswered. The command block itself is plain selectable text: select a word or a fragment of it like anywhere else on the page, and use `Kopiuj polecenie` for the whole line.
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
The severity is a bold lead line; the other seven fields (four under `--only-md`, which has no PR comment to write) follow as bullets, each on its own line, with one blank line before every block so each finding renders as its own vertically spaced section:

    🔴 **High**
    - **Linia:** 87
    - **Problem:** Gałąź błędu efektu kończy się `EMPTY`, więc porażka żądania nie dociera do reduktora
    - **Reguła:** ngrx-effects#5
    - **Expected Result:** `catchError` zwracający `of(loadUsersFailure({ error }))` wewnątrz `switchMap`
    - **PR Problem:** The `loadUsers$` effect swallows the failure: its `catchError` returns `EMPTY`, so no failure action ever reaches the reducer. The `loading` flag stays `true`, the spinner never stops and the user is told nothing.
    - **PR Expected:** A failed request should end in a failure action that clears `loading` and fills the error state. Return `of(loadUsersFailure({ error }))` from `catchError` inside the `switchMap`, handle that action in the reducer and render it through the existing error branch of the template.
    - **PR Locations:** `user-panel.effects.ts` → `loadUsers$`, `user-panel.reducer.ts` → `loadUsersFailure`, `user-panel.effects.spec.ts` → failing-request case

`**Reguła:**` holds the `<id>#<n>` address of the violated checklist item — the address the checklist block ticks — and `render-report.cjs` prints the item's own words in its place; an address the rulebook does not hold is a parser warning.
A finding no checklist item covers (the cross-file pass, a `CLAUDE.md` rule) names its source in prose instead: `CLAUDE.md → brak console.log`.
`PR Problem`, `PR Expected` and `PR Locations` are the only English fields, written for the PR comment and used nowhere else on the page; an `--only-md` report leaves them out.
They are written for a reviewer who never opens the report: `PR Problem` gets two sentences (what is wrong + the consequence), `PR Expected` two to three (the target state + how to reach it), and `PR Locations` lists every file and symbol the fix touches — every concrete name the Polish fields propose has to appear in them.

Severity: ⚪ Low · 🟡 Medium · 🔴 High · 🟤 Critical · 🔵 Missing Unit Test.
A missing spec is 🔵 whichever item flags it.
Every file's part also carries its ticked checklist and coverage marker as HTML comments, and the finished report keeps them only under `--with-checklist` — see [Checklist coverage](#checklist-coverage).
Line numbers refer to the file's real content (as the Read of the file's `contentPath` numbers it), never to diff hunk numbering.
The context script additionally precomputes each file's changed-line ranges (`changedLines`, from `git diff -U0`) as the authoritative list of lines the diff touched, and carries the source path of a renamed file (`oldPath`, from the rename pair `git diff --raw` reports) so the rename can be checked against the naming rules.
No findings → the report is the single line `Nie wykryto problemów.`; empty diff → `Nie wykryto zmian do analizy.`

## Mechanics

`scripts/review-context.cjs` (Node, zero dependencies) does all deterministic work: base-branch detection, changed-file listing, changed-line ranges, file-kind matching, report paths, the files the reviewer reads and a ready-to-run search command.
It writes the full context to `cache/<branch>/.review-context-<kind>.json`, in the cache folder of the run's first target, and prints only a summary (`contextPath`, `errors`, `warnings`, one line per target), which the skill then Reads — tool output can be compressed on its way into the conversation, a Read file is not.
It also writes each target's import ledger (`<report>.imports.txt`, one `<file>:<line> → <specifier>` edge per line, read from the reviewed revision) for the cross-file layering question; files in a language it has no extractor for are named on a `# not parsed` line.
It writes each target's work folder (`<report>.work/`, the context's `workDir`): every reviewed file's content in the reviewed revision (`contentPath`) and its own section of the target's diff (`diffPath`), both taken from git once and Read by the reviewer file by file.
Next to them sits each file's bundle (`bundlePath`, `NN-<name>.bundle.md`): its plan with every item's text under its address — so the reviewer takes every address from the bundle instead of numbering anything itself — the facts and probe hits bound to those items, the consumers of its exports and its jscpd candidates.
The cross-file pass has a bundle of its own (`crossBundlePath`): the facts that span files, the items that pass reports under, the candidates.
The facts behind the bundles are in `facts.json` (`factsPath`), which the part check reads.
A folder review reads the working tree, so its `contentPath` is the file itself and it has no diff.
`target.commands.grep` searches the reviewed revision into a file of that folder and prints only the match count and the file's path.
A resumed run rewrites the work folder but keeps the drafts of parts the check refused and the run never wrote, listed in `target.resume.drafts`.
Next to the context it writes `checklists/<kind>/<id>.md` (the catalog entry's `numberedPath`), a copy of every instruction the run walks with the items its plans walk, kept for a lookup of one item, and `rulebook-notes.md` (`rulebookNotesPath`), the preambles the reviewer reads before the first file.
`scripts/rulebook.cjs` loads the kinds and their item keys, `scripts/repo-facts.cjs` computes the facts from the whole reviewed revision (export consumers, a barrel nobody imports through, a guard no route uses, a pipe used in one template or none, i18n keys missing, unused or duplicated, relative imports that leave their area, repeated literals and conditions, one label mapping implemented twice, NgRx action trios and loading flags, spec inputs and outputs, snapshot placement, an area routed from both `shared/routes/` and `shell/`) and the answers to second questions (`answer`), and runs the probes, and `scripts/review-bundle.cjs` binds both to plan items and renders the bundles.
A fact binds to the first item of the file's plan whose `facts` names its kind; one no item names is listed under `## Fakty spoza planu (bez wymogu)` and requires nothing.
When the facts could be drawn from part of the repository only (a size limit, a git failure), every fact merely points, like a probe hit.
A write failure there drops the targets it concerns, and a run with no target left exits 1.
It runs the [duplication scan](#duplication-scan) through `scripts/duplication-scan.cjs`, which fetches jscpd with npx at run time instead of depending on it.
Branch reviews never touch the working tree: the file list comes from `git diff --raw base...branch`, and every file's content from its blob in that list, read through one `git cat-file --batch`; staged reviews first run `git add .`, then read the index blobs of `git diff --cached --raw` the same way.

`scripts/check-part.cjs` (Node, zero dependencies) checks the report's part files against the context, with the grammar `render-report.cjs` parses.
As a PreToolUse hook registered in the plugin's `hooks/hooks.json` it runs on every Write or Edit of a `<report>.partNN.md` file: a failing part is not written (exit 2), and the reviewer gets the list of problems back.
The plugin registers it, not the skill's frontmatter, because frontmatter hooks stop after a compaction: the parts written after one used to pass unchecked until the assembly refused them.
Outside a run it finds no context and returns at once.
It also sees every Bash command of the review and refuses one that writes a part — a redirect or heredoc into it, `tee`, `cp` or `mv` onto it, `sed -i` on it, a `cd` into the report's folder followed by any of these — since the check would never see that part.
It refuses, too, a command that prints a reviewed file, its diff or its bundle (`cat`, `head`, `sed`, `awk` and 23 more readers, over the files of every run whose work folder still exists, with braces, globs and `for` loops expanded): shell output may reach the reviewer compressed and without the line numbers a part cites.
`grep` and `wc` pass, and so does `sed -n '<N>p' <file>` for a line longer than the 2,000 characters Read shows.
A part that fails is saved as a draft, `<workDir>/<stem>.partNN.draft.md`, so a fix is an Edit of the lines named instead of the whole part sent again: after every Edit of a draft, the skill's PostToolUse hook checks it again and, once it passes, moves it into place together with the drafts waiting behind it; `--context=<contextPath> --promote=<draft>` does the same by hand.
A part written less than 2 seconds after the part before it is refused unless both belong to one batch of `target.batches` (see [Token cost](#token-cost)): one message writes one batch, with the next batch's Reads riding along.
A part refused for that alone waits in its draft, unchanged, for the promote.
Run with `--context=<contextPath> --report=<reportPath>`, it checks the whole target before the assembly and exits 1 on any problem, which leaves the parts on disk; once everything passes it rewrites the numbers of every coverage marker from the block above it, so a miscounted marker is never a refusal, sets the fixed severities (see [Instructions](#instructions)) on the findings, and prints the target's coverage line.
It holds the part numbering and order, a checklist block covering exactly the file's plan, verdict lines that name their evidence (never another item's address), a finding behind every `NARUSZENIE`, at most one item of each instruction per finding (two items of one checklist are two defects, so two findings) except for a `findings: per-file` instruction, which is instead one finding per file, gates only where an instruction declares one, and cited lines that exist in the file.
An OK's evidence answers one item: lines of the file (`OK (L12, L18)`), never a span of half or more of a file of 20+ lines nor a line past its end, or the path of an existing file that meets the requirement (`OK (tests/a.spec.ts)`), looked up from the reviewed file's folder, the facts' root or the context's `project` root.
Only `OK (brak wystąpień)` closes a range of items, since lines that answer one item say nothing about the next.
From `facts.json` it holds each item to what its bundle showed: `NARUSZENIE`, or an OK with `fakt nie dotyczy:` against a `FAKT` (never `NIEZWERYFIKOWANE`), every line a fact or probe points at cited by a clean verdict, no `brak wystąpień` where lines are pointed at, `drugie pytanie:` where the item asks one, and a line of its own for such an item.
A `NIEZWERYFIKOWANE` reason starts with `narzędzie:`, `poza recenzją:` or `działająca aplikacja:`, and a `poza recenzją:` path must exist and lie outside the review.
An OK on the lines that a finding of its `sameAs` partner breaks is refused: one defect breaks both items, so the item joins that finding with a `NARUSZENIE`.
An item with a prepared verdict (`gotowy werdykt:`) takes that line word for word or a `NARUSZENIE`, never an OK.
The cross-file part's `<!-- unverified:` block holds exactly the items left `[ ]` in 3 or more file parts, prepared ones aside, each once, never with `BRAMKA`, and every `NARUSZENIE` there has a finding of that part.
A finding of the cross-file part whose lines a file part's finding already covers, under the same address or its `sameAs` partner, is refused; a part whose two findings over the same lines name the two sides of a `sameAs` pair is written with a note asking to merge them.

`scripts/review-hooks.cjs` (Node, zero dependencies) holds the skill's other hooks, one `--event` each; none of them ever breaks a session, since a failure ends in no output.
`--event=read` runs before every Read.
Reading a run's context or one of its bundles ties the session to that run; before the cross-file bundle is read, its live section is rewritten from the parts on disk — what the file parts already report, and which addresses the `<!-- unverified:` block must answer; under `--dedup-items` a file bundle's Read is pointed at a copy in which an item an earlier bundle showed is a reference to that bundle.
`--event=draft` runs after every Write or Edit and promotes a draft that now passes.
`--event=compact` runs when a session is compacted, from the plugin's `hooks/hooks.json`, since a skill's frontmatter cannot register a SessionStart hook.
It names the target and where it stands, the Reads that resume it (the next batch, the cross-file pass or the assembly), the drafts waiting, and the lines of `SKILL.md` between the re-attached head and the `<!-- one-time:start -->` marker to read again.
Its state is one small JSON file per session.

`scripts/render-report.cjs` (Node, zero dependencies) parses the assembled Markdown report and renders the HTML page, then removes the Markdown — but only after a warning-free parse.
Run it by hand with `node scripts/render-report.cjs --report=<path.md> [--project=<repo root>] [--mode=branch|staged|folder] [--branch=<name>] [--base=<name>] [--out=<path.html>] [--keep-source] [--only-md] [--with-checklist]`.
Without `--with-checklist` it first cuts the checklist blocks, coverage markers and the `<!-- unverified:` block, so the page has no **Pokrycie checklist** section and a Markdown it leaves behind (a drift, `--keep-source`) carries none either; `--only-md` does only that cut, in place, and renders nothing.
Under `--with-checklist` it reads the per-file checklist blocks and coverage markers too, and reconciles them: the ticks are recounted, and a short walk, a missing or malformed block or a marker the ticks contradict warns (and keeps the Markdown), while `<!-- coverage: <path> mechanical -->` is the complete proof for a file the mechanical-change gate narrowed to its two questions. Any other multi-line HTML comment in the report is swallowed whole instead of being read as findings.
Every finding also carries a collapsible code snippet showing the cited lines with three lines of context, highlighted in the finding's severity colour.
The cited lines come from `**Linia:**`: bare numbers and spans, plus the other spellings of the same list (`L12`, an em dash or minus sign between the ends, `;` between entries, backticks); a note in parentheses is set aside whole.
Any other entry warns and names itself, and a field that points at no line at all warns too.
`--mode` decides what the snippet is: `branch` reads `git show <branch>:<path>` plus `git diff -U0 <base>...<branch>`, `staged` reads the index plus `git diff -U0 --cached`, and both render a real before/after split diff; `folder` (and a missing `--mode`) renders the working-tree file with no diff markers.
The old-file line numbers the left side prints are derived from the `-U0` hunk headers, which state how far the old numbering runs ahead of the new one from each hunk on.
The full source of every file with a finding is embedded once per file, so a file with four findings carries one copy, not four.
Files longer than 3000 lines are left out and the `Cały plik` button reports the count instead — the fragment still renders.
`--project` names the root the report paths are relative to; when it is omitted the root is recovered from a report living under `<project>/.claude/doh/`, and a file that cannot be read simply renders without a snippet.
It accepts the severity lead line with and without a leading `- ` (reports written before `ee76300` use the dashed form), and reads `**Reguła:**` as `<id>#<n>` addresses, and — in older reports and prose rules — whether the instruction is named with its `.md` extension, without it, or replaced by the violated point's name.

`scripts/github.cjs` (Node, no dependencies) is the only place that talks to GitHub: the owner/repo read off the remote URL, the token lookup, and the three calls the skill needs (find the open PR, read its diff, post the review).
`fetch` is asynchronous while every script around it is not, so the request runs in a child copy of that file — the parent hands it a JSON request on stdin and reads the JSON response off stdout, which keeps the calling scripts synchronous.

`scripts/post-pr-comments.cjs` (Node, no dependencies) posts the *accepted* findings of a rendered HTML report as a PR review.
The report page cannot do it itself — a `file://` page has no GitHub credentials — so when an open PR exists for the reviewed branch the renderer adds a **Dodaj komentarze do PR #n** button that hands over the ready command, carrying the accepted pool of that browser as `--include=<ids>` — those findings, and only those, are posted.
Finding the PR needs no credentials on a public repository; a private one needs a token for the lookup as well, and posting the review always does (see [GitHub access](#github-access)). When the lookup cannot run, the reason is printed to stderr *and* shown on the report page itself, so a missing button is never left unexplained.
Run it by hand with `node scripts/post-pr-comments.cjs --report=<path.html> --include=<ids> [--project=<repo root>] [--pr=<number>] [--dry-run]`.
`--include` is the accepted pool and the only thing that ever reaches GitHub: a finding nobody accepted is never posted, and a command without `--include` refuses to run. `--all` is the deliberate way past that for a command run by hand with no page to accept anything in, and only then does `--exclude=<ids>` mean anything.
A comment body carries the finding's English `PR Problem` and `PR Expected` wording (`**Expected result:** …`) plus its `PR Locations` list (`**Where to change:** …`), so the reviewer sees what is wrong, what the result should be and which files and symbols the fix touches — but no severity, no violated rule and no Polish; the Polish report keeps all of that for the reader.
Findings anchored on lines the PR diff shows become inline review comments (a whole cited range becomes a multi-line comment); the rest are listed in the review body, because GitHub rejects an inline comment outside the diff. Reviews are posted in batches of 50 comments. A summary too long for one review body (GitHub caps it at 65 536 characters, which a folder review of a large area can reach) is split across further reviews, and the posts are spaced a second apart so GitHub's secondary rate limit does not land half of them. If one is refused anyway, the message says how many already reached the PR.

The button is tied to the *branch*, not to the review mode: a `staged` or `folder <path>` review run on a branch that has an open PR gets it too.
That is intentional but worth knowing — those modes review code the PR diff need not contain, so most or all of their findings end up in the review body rather than pinned to lines.

Tests: `node --test skills/codeReview/scripts/review-context.test.cjs skills/codeReview/scripts/rulebook.test.cjs skills/codeReview/scripts/repo-facts.test.cjs skills/codeReview/scripts/review-bundle.test.cjs skills/codeReview/scripts/render-report.test.cjs skills/codeReview/scripts/check-part.test.cjs skills/codeReview/scripts/review-hooks.test.cjs skills/codeReview/scripts/score-review.test.cjs skills/codeReview/scripts/post-pr-comments.test.cjs skills/codeReview/scripts/github.test.cjs skills/codeReview/scripts/duplication-scan.test.cjs`
(paths are listed explicitly because PowerShell does not expand globs for native commands).
