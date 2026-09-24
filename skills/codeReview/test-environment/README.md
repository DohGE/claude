# codeReview test environment

A fake Angular/NgRx application (bootstrap + configuration files, a `user-panel` feature area and a
one-file `layout` area) in which nearly every file deliberately violates the checklists in
`skills/codeReview/instructions`. It exists to stress-test the `/codeReview` skill: run a review over
these files and score the report against the answer key, `../test-key/answer-key.json` (see "Scoring a run").

The environment is built so that **every reviewable instruction file has at least one file it applies
to, and every checklist item of every instruction is broken at least once** — see the coverage map at
the bottom. The code is not meant to compile — it only has to be realistic enough to review.

The app is wired for server-side rendering (`provideClientHydration(withIncrementalHydration())`,
`app.config.server.ts`, an `isPlatformBrowser` branch, `ngSkipHydration`, `TransferState`), but the
instruction set no longer carries any SSR-only rule — those items were removed from `performance.md`,
`security.md` and `app-config.md`. Every SSR construct in the environment is therefore FALSE-POSITIVE
BAIT: see its entry in the key's `bait`. What survives is whatever a non-SSR rule still catches.

Accessibility entries in the key name the `accessibility` instruction and carry the WCAG 2.2 success
criteria they break in `wcag` (`instructions/global/accessibility.md`); every one of them must be reported as 🟡 **Medium**, and
none of them may be reported twice under the component-template or component-styles instructions.

Entries under `code-quality` that describe a duplicate — duplicated logic, value or markup, or a
copy-paste-with-a-tweak (e.g. the providers copied from `app.config.ts`, the copy-pasted route entry,
the two `app-nav` divs) — must be reported as 🔴 **High**, whether the jscpd scan listed them or the
review found them.
The other code-quality entries (unused, unnecessary or boilerplate code, an added comment,
inconsistency) stay 🟡 **Medium**.
The key pins both in each entry's `severity`.

## How to run a review over it

The review needs a target that contains these files:

- `/codeReview folder skills/codeReview/test-environment` — folder mode (the literal word `folder`
  first: a bare path would be read as a branch name), and the only target that reviews
  these files and nothing else. Prefer it: the experiment stays scoped whatever else is uncommitted.
- commit them on a branch → `/codeReview` (branch vs base).
- `/codeReview staged` also works, but it is NOT scoped: the context script runs `git add .` itself,
  so staging this folder first changes nothing — every other pending change in the repo joins the
  review and stays staged afterwards.

`skipGlobs` excludes prose (`**/*.md`), so the review never reads this README: it is reported as a
skipped file and nothing more.
The answer key lives outside this folder, in `../test-key/answer-key.json`, because folder mode also
reviews `.json` files.

## Scoring a run

The answer key is JSON and is read by a script, never by the session that ran the review:

- `findings` — one entry per expected violation: `files`, `instructions` (checklist ids), `severity`
  when the key pins one (`null` when any severity is acceptable), `wcag` for accessibility entries, and the prose `text`.
- `bait` — deliberately compliant spots that must produce no finding (`file` is `null` when the spot
  spans the environment).
- `crossFile` — findings the one cross-file pass should produce.

Dev loop:

1. Run the review in a separate context (a fresh session or `claude -p`), with `--only-md`:
   `/codeReview folder skills/codeReview/test-environment --only-md`.
2. Score it: `node skills/codeReview/scripts/score-review.cjs --report <report .md>`.
   It prints recall, precision, bait hits, severity mismatches, the weakest instructions and a capped
   list of misses and unmatched findings; `--limit N` widens the lists, `--json` gives everything.
3. Read only the scorer output.
   The match is heuristic (same file, same instruction, shared backticked identifiers), so an entry in
   the misses list is a lead to check in the report, not a verdict.

Changing the environment means changing the key: edit `answer-key.json` together with the source
file, keeping `files` paths relative to this folder (`score-review.test.cjs` checks they exist).

## Instruction coverage map

Every reviewable instruction file, and the file(s) in this environment that break it:

| Instruction | Broken in |
| --- | --- |
| `global/accessibility.md` | `index.html`, feature template + component, card template + scss, dialog template (never `models/`) |
| `global/architecture.md` | every layer — barrels, `user-panel.module.ts`, `user-panel-ui-state.service.ts`, interceptor, app configs |
| `global/best-practices.md` | feature + card components, facade, service, directive, pipe, interceptor, app config |
| `global/code-quality.md` | reducer, selectors, effects, card scss, utils, i18n, `index.html`, app config |
| `global/general.md` | everywhere; `tsconfig.json` + `.eslintrc.json` cover the "never weakens the toolchain" items |
| `global/performance.md` | feature component + template, card component (never `models/`) |
| `global/security.md` | service, effects, interceptor, directive, feature component, app config (never `models/`) |
| `global/test-coverage.md` | every 🔵 entry above (never `models/`) |
| `global/guidelines.md` | `audience: implement` — never loaded by a review run, so nothing targets it |
| `local/code/app-config.md` | `src/main.ts`, `src/polyfills.ts`, `app.config.ts`, `app.config.server.ts` |
| `local/code/+state/http-service.md` | `user-panel.service.ts`, `user-panel-ui-state.service.ts`, its spec |
| `local/code/+state/ngrx-actions.md` | `user-panel.actions.ts` |
| `local/code/+state/ngrx-effects.md` | `user-panel.effects.ts` |
| `local/code/+state/ngrx-facade.md` | `user-panel.facade.ts` |
| `local/code/+state/ngrx-reducer.md` | `user-panel.reducer.ts` |
| `local/code/+state/ngrx-selectors.md` | `user-panel.selectors.ts` |
| `local/code/components/component.md` | feature, dialog and card components |
| `local/code/components/component-styles.md` | `ui-user-card.component.scss` |
| `local/code/components/component-template.md` | feature, dialog and card templates |
| `local/code/components/components-folder.md` | `user-panel.helpers.ts`, `highlight.directive.ts`, `ui/index.ts` |
| `local/code/components/feature-component.md` | `feature-user-panel*`, `feature-user-panel-dialog*` |
| `local/code/components/ui-component.md` | `ui-user-card.component.ts` |
| `local/code/models/models.md` | every file under `models/`, incl. `models/tests/` |
| `local/code/models/state-interface.md` | `user-panel-state.interface.ts`, `user-panel-initial-state.const.ts` |
| `local/code/shared/directives.md` | `highlight.directive.ts` |
| `local/code/shared/guards.md` | `user-panel.guard.ts` (+ its use in the routes file), `user-panel-init.guard.ts` |
| `local/code/shared/interceptors.md` | `user-panel-auth.interceptor.ts` |
| `local/code/shared/pipes.md` | `user-status.pipe.ts` |
| `local/code/shared/routes.md` | `user-panel.routes.ts`, `user-panel-shell.routes.ts`, the routes spec |
| `local/code/shared/utils.md` | all four util files + `shared/index.ts` |
| `local/i18n.md` | `en.json`, `pl.json`, `assets/i18n/tests/en.json.spec.ts` |
| `local/unit-tests/unit-tests.md` | every `*.spec.ts` in the diff |
| `local/unit-tests/component-unit-test.md` | `ui-user-card.component.spec.ts` |
| `local/unit-tests/util-guard-unit-test.md` | `build-user-table.util.spec.ts`, `user-panel.guard.spec.ts` |
| `local/unit-tests/+state/ngrx-effects-unit-test.md` | `user-panel.effects.spec.ts` |
| `local/unit-tests/+state/ngrx-facade-unit-test.md` | `user-panel.facade.spec.ts` |
| `local/unit-tests/+state/ngrx-reducer-unit-test.md` | `user-panel.reducer.spec.ts` |
| `local/unit-tests/+state/ngrx-selectors-unit-test.md` | `user-panel.selectors.spec.ts` |

Two checklist items have no applicable target on purpose, because creating one would add a file that breaks nothing else:

- `component-unit-test.md` — "the route mock exposes a typed `jest.fn<ReturnType, [ArgType]>` for query-param access":
  no component in the environment injects `ActivatedRoute` (the feature component reads `location.search` by hand,
  which is its own finding), so there is no route mock to get wrong.
- `models.md` — "Existing endpoint interfaces are not modified unless the task explicitly states the API contract
  changed": this is a property of the *task*, not of the code, and cannot be encoded in a static fixture.
