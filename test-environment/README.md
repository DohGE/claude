# codeReview test environment

A fake Angular/NgRx application (bootstrap + configuration files, a `user-panel` feature area and a
one-file `layout` area) in which nearly every file deliberately violates the checklists in
`skills/codeReview/instructions`. It exists to stress-test the `/codeReview` skill: run a review over
these files and score the report against the answer key, `skills/codeReview/test-key/answer-key.json` (see "Scoring a run").

The environment is 56 files plus this README.
Its key holds 473 findings, 21 bait spots and 13 cross-file entries.
It was minimised on 2026-10-03 from 61 files and 582 findings.
309 of the findings are the only violation of some checklist item, and 49 files hold at least one of those.

The environment is built so that **every instruction is walked by the file kind of at least one file
in it and broken at least once** — see the coverage map at the bottom.
Not every checklist item is: `score-review.cjs --lint-key` lists the items no violation of the key names (see "Scoring a run").
They are rules about the task or the process rather than the code (TDD, a spec run before commit, a snapshot reviewed before `-u`), permissions only another item can break (`mapResponse` accepted, `{} as X` acceptable), items the environment breaks only under another instruction's entry, and constructs it does not contain.
The code is not meant to compile — it only has to be realistic enough to review.

The app carries server-side-rendering constructs (`provideClientHydration(withIncrementalHydration())`,
`withHttpTransferCacheOptions`, an `isPlatformBrowser` branch, `ngSkipHydration`, `TransferState`), but the
instruction set no longer carries any SSR-only rule — those items were removed from the `performance`,
`security` and `app-config` instructions. Every SSR construct in the environment is therefore FALSE-POSITIVE
BAIT: see its entry in the key's `bait`. What survives is whatever a non-SSR rule still catches.

Accessibility entries in the key name the `accessibility` instruction and carry the WCAG 2.2 success
criteria they break in `wcag` (the `accessibility#<n>` items of the kinds in `instructions/`); every one of them must be reported as 🟡 **Medium**, and
none of them may be reported twice under the component-template or component-styles instructions.

Entries under `code-quality` that describe a duplicate — duplicated logic, value or markup, or a
copy-paste-with-a-tweak (e.g. the two byte-identical reload effects, the copy-pasted route entry,
the same URL under two `endpoints` keys) — must be reported as 🔴 **High**, whether the jscpd scan listed them or the
review found them.
The other code-quality entries (unused, unnecessary or boilerplate code, an added comment,
inconsistency) stay 🟡 **Medium**.
The key pins both in each entry's `severity`.

## How to run a review over it

The review needs a target that contains these files:

- `/codeReview folder test-environment` — folder mode (the literal word `folder`
  first: a bare path would be read as a branch name), and the only target that reviews
  these files and nothing else. Prefer it: the experiment stays scoped whatever else is uncommitted.
- commit them on a branch → `/codeReview` (branch vs base).
- `/codeReview staged` also works, but it is NOT scoped: the context script runs `git add .` itself,
  so staging this folder first changes nothing — every other pending change in the repo joins the
  review and stays staged afterwards.

`skipGlobs` excludes prose (`**/*.md`), so the review never reads this README: it is reported as a
skipped file and nothing more.
The answer key lives outside this folder, in `skills/codeReview/test-key/answer-key.json`, because folder mode also
reviews `.json` files.

## Scoring a run

The answer key is JSON and is read by a script, never by the session that ran the review:

- `findings` — one entry per expected violation: `files`, `instructions` (checklist ids), `items` (the
  checklist items the defect breaks, `<instruction>#<n>`, each under one of the entry's `instructions`),
  `severity` when the key pins one (`null` when any severity is acceptable), `wcag` for accessibility
  entries, and the prose `text`.
- `bait` — deliberately compliant spots that must produce no finding (`file` is `null` when the spot
  spans the environment).
- `crossFile` — findings the one cross-file pass should produce.

Dev loop:

1. Run the review in a separate context (a fresh session or `claude -p`), with `--only-md` and `--with-checklist`:
   `/codeReview folder test-environment --only-md --with-checklist`.
   Without `--with-checklist` the report keeps no coverage markers or checklist blocks, so the scorer can neither scope the entries to the walked files nor measure false OKs: it says so in a `scope: every entry` line and a `false OKs: not measured` line.
   To measure a run as users get it - PR fields included - leave out `--only-md` and score the `raport.html` it writes instead.
2. Score it: `node skills/codeReview/scripts/score-review.cjs --report <report .md or raport.html>`.
   A page is scored from the report data it carries; its parser warnings are counted from the Markdown the renderer keeps next to it when there were any.
   It prints recall, precision, bait hits, severity mismatches, the weakest instructions and a capped
   list of misses and unmatched findings; `--limit N` widens the lists, `--json` gives everything.
   Its false-OK list ranks the items of the entries' `items` by how often the report's checklist blocks
   for the entry's files ticked them without NARUSZENIE; `(found)` marks an entry the report still found
   through another finding, and an item the blocks never showed is counted apart as absent.
   The items whose false OK cost an entry are the ones `secondQuestion` in `instructions/` is chosen from.
3. Read only the scorer output.
   The match is heuristic, so an entry in the misses list is a lead to check in the report, not a verdict.
   A finding pairs with an entry of its file and instruction on evidence both sides share: the lines the
   key places the entry on, the code it quotes in backticks, the WCAG criteria it lists, a file the
   finding names, and rare words of the entry's prose that the finding or a checklist point it cites repeats.
   `--explain <entry id>` prints every pair of one entry with that evidence and how it counted.
   Checked by hand against the run of 2026-09-27, it reported 93.1% recall where 89.9% of the entries were
   found and 3.0% partly found: it credited 16 of the 40 missed entries - the report named their code or
   line for another defect - and missed 11 of the 507 found ones.
   The key has since dropped two entries (one contradicting `models#17`, one repeating `models#24`)
   and moved six to the instruction whose item they break; the same report now scores 93.6%.
   Both figures predate the 2026-10-03 minimisation, and no run has been scored against the reduced key yet.

Changing the environment means changing the key: edit `answer-key.json` together with the source
file, keeping `files` paths relative to this folder (`score-review.test.cjs` checks they exist).
Then run `node skills/codeReview/test-key/locate-lines.cjs`: it rewrites each entry's `lines` - where
in its files the code the entry quotes in backticks stands - which the scorer pairs findings by.
Never edit `lines` by hand; `score-review.test.cjs` fails while they are stale.
Quote in backticks only code that stands where the defect is: `locate-lines.cjs` turns every backticked quote into lines, so a quoted fix the file already uses elsewhere (the `@if` of "`*ngIf` instead of `@if`") points the entry at compliant code.
`node skills/codeReview/scripts/score-review.cjs --lint-key` lists the entries only their instruction
can carry - no name quoted and no lines, or a cross-file entry with fewer than two names.
Give such an entry a backticked name the code has.
`--lint-key` also lists the checklist items no violation names, for information, and the violations naming no checklist item and the items no instruction of their entry has.
`score-review.test.cjs` fails while either of the last two lists is not empty.

## Instruction coverage map

Every instruction - the `id` the file kinds in `instructions/*.json` share - and the file(s) in this
environment that break it:

| Instruction | Broken in |
| --- | --- |
| `accessibility` | feature, dialog and card templates, feature and dialog components, card scss, directive (never `models/`) |
| `architecture` | every layer — barrels, `user-panel.module.ts`, `user-panel-ui-state.service.ts`, interceptor, app config |
| `best-practices` | feature, dialog and card components + templates, both services, reducer, directive, pipe, guard, interceptor, routes, utils + util spec, `user-panel.module.ts`, initial-state const, app config |
| `code-quality` | state (actions, reducer, selectors, effects, facade, reducer spec), both services, feature, dialog and card components, card scss + spec, directive, pipe, both guards, interceptor, both routes files, helpers, barrel, `models/`, utils, i18n, `main.ts`, app config |
| `general` | everywhere; `.eslintrc.json` covers the "never weakens the toolchain" items |
| `performance` | effects, feature and dialog components + templates, card component (never `models/`) |
| `security` | service, effects, guard, interceptor, directive, util, shell routes, feature component + template, card template, app config (never `models/`) |
| `test-coverage` | every 🔵 entry above (never `models/`) |
| `app-config` | `src/main.ts`, `src/polyfills.ts`, `app.config.ts` |
| `http-service` | `user-panel.service.ts`, its spec, `user-panel-ui-state.service.ts`, the facade |
| `ngrx-actions` | `user-panel.actions.ts` |
| `ngrx-effects` | `user-panel.effects.ts` |
| `ngrx-facade` | `user-panel.facade.ts` |
| `ngrx-reducer` | `user-panel.reducer.ts` |
| `ngrx-selectors` | `users.selectors.ts` (itself misnamed) |
| `component` | feature, dialog and card components |
| `component-styles` | `ui-user-card.component.scss`, the feature component's inline `styles` |
| `component-template` | feature, dialog and card templates |
| `components-folder` | `user-panel.helpers.ts`, `highlight.directive.ts`, `ui/index.ts` |
| `feature-component` | `feature-user-panel*`, `feature-user-panel-dialog*` |
| `ui-component` | `ui-user-card.component.ts` |
| `models` | every file under `models/` but the compliant barrel, incl. `models/tests/` |
| `state-interface` | `user-panel-state.interface.ts`, `user-panel-initial-state.const.ts` |
| `directives` | `highlight.directive.ts` |
| `guards` | `user-panel.guard.ts` (+ its use in the routes file), `user-panel-init.guard.ts` |
| `interceptors` | `user-panel-auth.interceptor.ts` |
| `pipes` | `user-status.pipe.ts` |
| `routes` | `user-panel.routes.ts`, `user-panel-shell.routes.ts`, the routes spec |
| `utils` | all three util files + `shared/index.ts` |
| `i18n` | `en.json`, `pl.json`, `assets/i18n/tests/en.json.spec.ts` |
| `unit-tests` | every `*.spec.ts` in the diff but `models/tests/user-status.enum.spec.ts` (a spec that must not exist — see `models`), plus the util spec's snapshot |
| `component-unit-test` | `ui-user-card.component.spec.ts` |
| `util-guard-unit-test` | `build-user-table.util.spec.ts`, `user-panel.guard.spec.ts` |
| `ngrx-effects-unit-test` | `user-panel.effects.spec.ts` |
| `ngrx-facade-unit-test` | `user-panel.facade.spec.ts` |
| `ngrx-reducer-unit-test` | `user-panel.reducer.spec.ts` |
| `ngrx-selectors-unit-test` | `users.selectors.spec.ts` |

One of the checklist items `--lint-key` lists has no applicable target on purpose:

- `models` — "Existing endpoint interfaces are not modified unless the task explicitly states the API contract
  changed": this is a property of the *task*, not of the code, and cannot be encoded in a static fixture.
