# codeReview test environment — answer key

A fake Angular/NgRx application (bootstrap + configuration files, a `user-panel` feature area and a
one-file `layout` area) in which nearly every file deliberately violates the checklists in
`skills/codeReview/instructions`. It exists to stress-test the `/codeReview` skill: run a review over
these files and diff the report against the inventory below.

The environment is built so that **every reviewable instruction file has at least one file it applies
to, and every checklist item of every instruction is broken at least once** — see the coverage map at
the bottom. The code is not meant to compile — it only has to be realistic enough to review.

The app is wired for server-side rendering (`provideClientHydration(withIncrementalHydration())`,
`app.config.server.ts`, an `isPlatformBrowser` branch, `ngSkipHydration`, `TransferState`), but the
instruction set no longer carries any SSR-only rule — those items were removed from `performance.md`,
`security.md` and `app-config.md`. Every SSR construct in the environment is therefore FALSE-POSITIVE
BAIT: see the dedicated bait entry below. What survives is whatever a non-SSR rule still catches.

Accessibility entries below are labelled `accessibility:` and carry the WCAG 2.2 success criterion they
break (`instructions/global/accessibility.md`); every one of them must be reported as 🟡 **Medium**, and
none of them may be reported twice under the component-template or component-styles instructions.

## How to run a review over it

The files must appear in a git diff to be reviewed:

- `git add skills/codeReview/test-environment` → `/codeReview staged`, or
- commit them on a branch → `/codeReview` (branch vs base).

This README is the answer key, and `skipGlobs` now excludes prose (`**/*.md`), so the review never
reads it: it is reported as a skipped file and nothing more. Committing it separately is no longer
necessary for a clean experiment — a reviewer that somehow parroted it would still betray itself
through missing real line numbers and rule references.

## Deliberately compliant spots (false-positive bait)

- `layout/data-access/+state/layout.actions.ts` is a **fully compliant** actions file (single export,
  `source: 'Layout Navigation'`, `'Verb subject'` event keys, `emptyProps()` where there is no payload).
  It must produce **zero** findings under `ngrx-actions.md`. Only the *relative cross-area import* of it is a finding, and it is
  anchored in the importing files (`user-panel.effects.ts`, `feature-user-panel.component.ts`), never here.
- `ui-user-card.component.ts` sets `ChangeDetectionStrategy.OnPush` and has separate `.html`/`.scss` files.
- `ui-user-card.component.ts` `validityChanged = output<boolean>()` is a correct output name (past tense,
  no `on` prefix, no native-event collision) — the `onSelect` and `change` outputs next to it are the findings.
- `user-panel.actions.ts` imports `UserDto` through the models barrel (correct import direction).
- `user-panel.effects.ts` `searchAfterDialog$` returning an **action array** from one effect is the
  prescribed form for multiple resulting actions — not a finding. Its `mapResponse` usage in
  `refreshUsers$` is also an accepted form; only the `error` branch returning nothing is the defect.
- `user-panel.effects.ts` class name `UserPanelEffects` and the `searchUsersFail` → `of(fail)` inside
  `catchError` inside `mergeMap` in `searchUsers$` (correct catchError placement there).
- `user-panel-ui-state.service.ts` field naming (`private readonly _selectedUser$`, exposed through
  `asObservable()`) is idiomatic — the finding is the hand-rolled-store *pattern*, not the naming.
- `feature-user-panel.component.html`: `[compareWith]="compareWithId"` is a function reference passed
  UNINVOKED, which the component-template instruction explicitly allows — it is not a "method call in a
  binding". The finding lives in the TS file (the field's shape), never here.
- `user-panel.effects.ts`: the short `tap`/`map` bodies inside `searchUsers$`, and `buildResultLabel` itself,
  are single-consumer logic under ~10 lines — "extract this into a `shared/utils/` function" is explicitly
  never a finding. What IS a finding is `buildResultLabel` being a *private method* instead of a module-level
  function, and its duplication of the reducer's `switch`.
- All four `+state` specs, the util spec and the guard spec live in `tests/` folders (correct location).
- The `should be created` / `should be defined` / `should create` / `should return the Active label` /
  `should match the stored snapshot` descriptions comply with the `should`-prefix naming rule — those
  tests are flagged as existence-only or as specs that must not exist, never for their names.
- `models/index.ts`'s `// types` line is one of the four barrel section headers the models instruction
  prescribes — a barrel header is never a "comment added by the diff" finding. The finding is the three
  *missing* headers and the wrong order.
- Prettier-owned formatting anywhere in this environment (indentation, wrapping, quotes, semicolons,
  trailing commas, blank lines) is NEVER a finding.
- `ui-user-card.component.ts` declaring an input named `title` (colliding with the native HTML attribute)
  is not itself a violation — only the parent template's plain-attribute binding of it is.
- `build-user-table.util.ts` exporting two related user-table functions from one file is NOT a violation
  (`utils.md`: "never report a cohesive multi-function util file"). What IS a violation there is
  `formatUserRow` being a pass-through wrapper over `deepClone` — and, by contrast,
  `build-user-summary.util.ts` groups two functions with nothing in common, which IS a finding.
- The endpoint path text in `user-panel.service.ts` — segments, wording, casing, versioning, leading/trailing
  slash, key names — is out of review scope entirely. Only the absolute base URL inside the value, and the
  fact that two keys hold the *same* URL, are reportable.
- `user-panel.service.ts` not using `resource()`/`httpResource()` is never a modernization finding.
- `feature-user-panel.component.html`: the third action button carries `aria-label="Save changes and close the panel"`
  over the visible text `Save changes` — the accessible name CONTAINS the visible label, so 2.5.3 Label in Name
  is satisfied (bait sitting right next to the button that really breaks it).
- **Nothing under `models/` is walked against `accessibility`, `performance`, `security` or `test-coverage`** —
  all four exclude `**/models/**` by `applies-to`. A folder of consts, interfaces, enums and types has no
  behaviour to test, no render cost, no attack surface and no UI, so a finding from one of those four
  instructions anchored in `models/` is a rule the reviewer invented. `models/` files still walk
  `architecture`, `best-practices`, `code-quality`, `general` and `models.md` — and break plenty there.
- **Every SSR construct in the environment is bait.** No instruction covers server-side rendering any more,
  so none of these may be reported, at any severity: `provideClientHydration(withIncrementalHydration())` and
  `@defer` blocks without a `hydrate` trigger; `ngSkipHydration` on the panel root; the `@if (isBrowser)`
  `isPlatformBrowser` branch; hydration-invalid markup (`<table>` without `<tbody>`, `<div>` inside `<p>`,
  nested `<a>`); `withHttpTransferCacheOptions({ includeHeaders: [...] })`; `transferState.set(...)` of user
  data; the mutable `useValue` singleton in `app.config.server.ts`; `inject(DOCUMENT)` never being used.
  Four of those lines still carry a NON-SSR finding, which is the one to report: `isBrowser` is a mutable
  field bound in the template (performance), the `<table>` header row has no `<th>`/`scope` (accessibility
  1.3.1), the nested `<a>` is raw in-app navigation instead of `routerLink` (general), and `document`/`window`
  in the constructor breaks the component instruction.
- `feature-user-panel.component.html`: `tabindex="-1"` on the overlay container is NOT a violation — only
  positive `tabindex` values are (the overlay's real defects are its missing focus management, listed below).
- `ui-user-card.component.html`: `<h3>` for the user name inside a card is a plausible heading level for a
  card — the heading-order violations live in the feature template, not here.

## Violation inventory (per file)

### src/main.ts

- app-config: `platformBrowserDynamic().bootstrapModule(UserPanelModule)` — bootstrap must be
  `bootstrapApplication(App, appConfig)` with a flat providers array; no root `NgModule`, no `platformBrowserDynamic()`.
- general: the failure is swallowed by `.catch(() => {})`.
- architecture: this is untouched Angular-CLI generator output (together with `user-panel.module.ts` and its
  `CommonModule` import) — scaffolding is conformed to these instructions before commit, not shipped as generated.

### src/polyfills.ts

- app-config: `zone.js` is still imported although `app.config.ts` provides `provideZonelessChangeDetection()`
  — the provider together with a live polyfill is the finding.

### src/app/app.config.ts

- best-practices: file-level `/* eslint-disable */` — widest possible scope, no justification, no rule named.
- general: SCREAMING_SNAKE consts (`API_BASE_URL`, `POLL_INTERVAL_MS`, `SEARCH_DEBOUNCE_MS`, `APP_CLIENT_SECRET`).
- security: `APP_CLIENT_SECRET = 'as_live_…'` — a secret in the diff (🟤 Critical).
- app-config: API base URL, poll interval and debounce time declared inline here instead of coming from the
  central app-config token — the effects' hard-coded `timer(0, 5000)` and the card's missing `debounceTime`
  are exactly the consumers that should read them.
- app-config: `provideHttpClient()` without `withFetch()` (SSR and resource-based APIs depend on it).
- security + app-config: `withNoXsrfProtection()`.
- app-config + interceptors: the interceptor is registered as a class through the `HTTP_INTERCEPTORS`
  multi-provider instead of `withInterceptors([userPanelAuthInterceptor])`.
- app-config + architecture: `provideRouter(routes)` with the feature area's `routes` imported **eagerly**
  (no `loadChildren`), and without `withComponentInputBinding()` — the feature component's hand-parsed
  `location.search` is the direct consequence.
- app-config + architecture: the ROOT store is not empty — `provideStore({ userPanel: reducer })` plus a root
  `provideEffects([UserPanelEffects])` register a feature slice globally instead of on its route.
- app-config: `runtimeChecks` declares only `strictActionWithinNgZone: true` — the five strict checks
  (`strictStateImmutability`, `strictActionImmutability`, `strictStateSerializability`,
  `strictActionSerializability`, `strictActionTypeUniqueness`) are missing, and the one that is there is
  invalid under `provideZonelessChangeDetection()` (every dispatch trips it).
- app-config: `provideAnimations()` instead of `provideAnimationsAsync()`.
- app-config: `importProvidersFrom(MatDialogModule)` appears twice for the same library, and is used for
  libraries that do ship standalone provider functions.
- code-quality: the `// material still ships no standalone provider function…` comment — the justification
  belongs in the PR description, and the diff adds no comments.
- app-config + security: no `provideBrowserGlobalErrorListeners()`; the custom `LoggingErrorHandler` logs the
  error together with the `authToken` read from `localStorage`.
- code-quality/architecture: `LoggingErrorHandler` is a class declared inside the configuration file.

### src/app/app.config.server.ts

- code-quality: `provideAnimations`, `provideRouter`, `provideStore` and `provideEffects` are duplicated verbatim
  from `app.config.ts` — copy-paste-with-a-tweak across the two files of this diff.
- general: SCREAMING_SNAKE const; a string injection token instead of an `InjectionToken`.
- app-config + architecture: the server config repeats the root-registered feature slice.

### tsconfig.json

- general: the diff weakens the compiler contract — `strict`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `strictTemplates` and `strictInjectionParameters` are all turned off, and
  `feature-user-panel.component.ts` is added to `exclude` so the new code builds. A flag turned off hides the
  same class of error in every other file of the repo.

### .eslintrc.json

- general: state-management lint rules must be errors — `@ngrx/no-store-subscription`,
  `@ngrx/avoid-dispatching-multiple-actions-sequentially` and `@ngrx/no-dispatch-in-effects` are downgraded to
  `warn` (each of them has a live violation in this diff), and `@typescript-eslint/no-explicit-any` is turned off.

### models/interfaces/user-panel-state.interface.ts

- state-interface: `?` optional fields instead of `| null` (`users?`, `selectedUser?`, `dialogResult?`, `lastError?`).
- state-interface: `readonly` on a state field (`selectedUser`).
- state-interface: derived fields in state (`filteredUsers`, `userCount`, `hasAnyErrors` — all computable from `users`).
- state-interface: function field in the state interface (`formatDisplayName`).
- state-interface: the API response is unpacked into a field per property (`selectedUserFirstName`,
  `selectedUserEmail`, `selectedUserCreatedAt`) instead of being stored whole and read out by selectors.
- state-interface + models: field types imported through the area's own barrel (`from '../index'`) — cycle risk.
- ngrx-actions (design leak): `dialogResult` parked in state only to pass a dialog result along.

### models/consts/user-panel-initial-state.const.ts

- models: two consts in one file (feature key + initial state).
- models: feature key value has no spaces / not descriptive (`'userPanel'`).
- general: SCREAMING_SNAKE_CASE const name (`USER_PANEL_INITIAL_STATE`).
- state-interface: initial state typed via `as` cast instead of explicit `: UserPanelState` annotation (compiler no longer enforces completeness).
- state-interface: incomplete vs the interface (missing `selectedUser`, `hasAnyErrors`, `formatDisplayName`,
  `lastError`, `searchResults`, `selectedUserFirstName`, `selectedUserEmail`, `selectedUserCreatedAt`); extra
  fields not in the interface (`createdAt`, `nested`).
- state-interface: loading flag initialized to `null` instead of `false`; `users: undefined`.
- models: logic inside a const (IIFE computing `createdAt`); nested object as `{}`.
- models: state type imported through the barrel instead of a concrete path.

### models/consts/user-panel-title.const.ts

- models: a single string used in exactly ONE place extracted into its own `.const.ts` file — a one-off value stays inline.
- general/i18n: hard-coded user-facing text (`'User management panel'`).
- code-quality: it duplicates the `<h1>` text in the feature template and the `page.userPanel.labels.panelHeading` translation.
- models: the barrel does not export it.

### models/interfaces/user-dto.interface.ts

- models: helper interface used only internally but exported (`ApiEnvelope`).
- models: `Dto` vocabulary in the type and file name (`UserDto`, `user-dto.interface.ts`) — every consumer inherits it.
- models: DTO with mixed camelCase/snake_case fields (`firstName` vs `last_name`) — API contract is snake_case.
- models: domain/UI type with snake_case fields (`UserVm`) — and, with `map-user-dto.util.ts`, an interface+mapper
  pair whose entire effect is re-spelling field names: a layer that changes nothing.
- general: type access through string index (`UserDto['user_status']`).
- models: several main exports in one file.

### models/interfaces/user-table-cell.interface.ts

- models: a helper interface whose only consumer is `UserTableRow` split away into its own one-declaration file —
  it belongs, unexported, next to the type that uses it.
- models: exported although used within one file only.
- models: the barrel does not list it.

### models/types/user-table.type.ts

- models: plain extensible object declared as `type` instead of `interface` (`UserTableRow`).
- models: incomplete table set — no `...DisplayedColumns` enum, no `SourceData`/`Cell` interfaces of its own.
- models: `...DisplayedColumnsLabels` enum values are texts, not i18n keys, and values ≠ keys.
- models: `UserTableDragSourceData` is a separate source-data interface duplicating the domain item —
  drag-and-drop table types are parameterized with the existing domain item type.
- models: several main exports in one file (type + interface + enum).

### models/consts/user-role-options.const.ts

- models: a `.const.ts` file holding an `interface` (`SelectOption`) — a const file declares constants only,
  and the type belongs in its own `.interface.ts` (or comes from the shared library).
- models: local duplicate of the shared-library option interface (`SelectOption`).
- models: option `label` values are raw texts, not i18n keys.

### models/enums/user-status.enum.ts

- models: numeric enum (`UserStatus`) — enums must be string enums with values equal to the API strings.
- models: `UserRole` keys in SCREAMING_SNAKE_CASE and values that are UI texts, not API strings.
- models: function (`userStatusLabel`) inside a models file — model files are purely declarative; its whole body
  is a `switch` translating one value into another, so it must become a `Record` mapper const in a
  `-mapper.const.ts` file, not a function; it also returns hardcoded UI texts instead of i18n keys.
- models: two enums plus a function — several main exports in one file.

### models/index.ts

- models: barrel missing the fixed commented sections in order (`// consts`, `// enums`, `// interfaces`, `// types`).
- models: barrel does not list every model file (all three `consts/` files, the enums file and `user-table-cell.interface.ts` are missing).
- models: declaration inside the barrel (`export const modelsVersion = 2`).

### models/tests/user-status.enum.spec.ts

- models: model files have no unit tests — they are verified by the compiler and by the reducer/selector specs.
- unit-tests: a `tests/` folder under `models/` exists at all.

### data-access/+state/user-panel.actions.ts

- ngrx-actions: more than one export — local `enum ActionTypes`, a constant (`DEFAULT_PAGE_SIZE`), plus the group.
- general: SCREAMING_SNAKE const (`DEFAULT_PAGE_SIZE`); PascalCase const (`UserPanelActions` — should be `userPanelActions`).
- ngrx-actions: `source: 'userPanel'` — not descriptive PascalCase words with spaces.
- ngrx-actions: event key `'loadUsers'` not a `'Verb subject'` sentence.
- ngrx-actions: `'Load users'` trio incomplete — success exists, fail missing (also breaks the reducer's loading-flag reset).
- ngrx-actions: `'Search users Success'` — capitalized suffix (generated prop `searchUsersSuccess` broken casing).
- ngrx-actions: fail props typed `unknown` instead of `HttpErrorResponse`.
- ngrx-actions: `props<{}>()` instead of `emptyProps()` (`Clear users`, `Toggle debug panel`).
- ngrx-actions: payload prop `data` does not match the state field `users`; optional `pageSize?`/`dialogResult?` instead of `| null`.
- ngrx-actions: verb `Fetch` outside the convention (should be `Load`); `'Set filtered users'` stores derived data (belongs in a selector).
- ngrx-actions: dialog result passed through state (`Set confirmation dialog result`) instead of through the trio.
- ngrx-actions: event order — reset (`Clear users`) first, trios not grouped.
- ngrx-actions: forbidden + unused import of the HTTP service (`UserPanelService`).
- ngrx-actions: `'Toggle debug panel'` consumed nowhere (no reducer `on`, no `ofType`, no facade dispatch).

### data-access/+state/user-panel.reducer.ts

- ngrx-reducer: exports named `initialState` + `reducer` — initial state belongs in `models/`, single export must be `userPanelReducer`.
- ngrx-reducer: initial state incomplete and typed via `as` cast.
- ngrx-reducer: no explicit `(state): UserPanelState =>` return types on any handler.
- ngrx-reducer: state mutation (`(state as any).isLoading = true; return state;`) + `as any`.
- ngrx-reducer: `state.filteredUsers.push(...mapped)` — array mutated with `push` instead of `[...]`/`map`/`filter`.
- general: narrating comment (`// set the loading flag to true`); commented-out handler code.
- ngrx-reducer: impure `Date.now()` in a handler (`refreshedAt`).
- ngrx-reducer: blind append on `loadUsersSuccess` (duplicates seeded items in edit mode — no upsert by id), and the
  upsert is nowhere implemented as the one shared `shared/utils/` function every refreshing reducer reuses.
- ngrx-reducer: derived value stored in state (`userCount`); extra fields not in the interface (`refreshedAt`, `resultLabel`, `selectedUserName`).
- ngrx-reducer: the persisted derived field `userCount` is recomputed ONLY in `loadUsersSuccess` — `searchUsersSuccess`
  and `setFilteredUsers` change its inputs and leave it stale.
- ngrx-reducer: `setConfirmationDialogResult` unpacks the selected user into three flat fields
  (`selectedUserFirstName`, `selectedUserEmail`, `selectedUserCreatedAt`) instead of leaving the object whole.
- ngrx-reducer: default selection `selectedUser: data[0]` — no `state.selectedX ?? list[0] ?? null` chain, overwrites the edit-mode choice, `undefined` when empty.
- ngrx-reducer: missing fail handler for `Load users` → `isLoading` stuck `true` on error.
- ngrx-reducer: `searchUsers` start handler does not clear previous results → stale UI while reloading.
- ngrx-reducer: identical handlers not merged (`searchUsers` and `fetchUserDetails` both only set `isLoading: true`).
- ngrx-reducer: inline `for` loop mapping + inline id concatenation (`firstName + '-' + last_name`) + `switch` mapping inside the reducer — belongs in utils/mappers.
- general/i18n: hard-coded user-facing texts in the reducer (`'No results'`, `' results'`).
- ngrx-reducer: `state.selectedUser.firstName` without a null guard (no `if (!state.x) return state;`).
- ngrx-reducer: `searchResults` is modelled `UserDto[] | null` ("none" is a distinct UI state) but the handler empties it to `[]`.
- ngrx-reducer: `clearUsers` spreads the whole initial state for a partial reset instead of listing cleared fields.
- ngrx-reducer: handler order does not mirror the actions file — `fetchUserDetails` sits inside the search trio and
  `clearUsers` is last although its action is first.
- ngrx-reducer: forbidden import of the selectors file (unused too).

### data-access/+state/user-panel.selectors.ts

- ngrx-selectors: feature selector exported (must be local, non-exported); feature key as inline magic string.
- ngrx-selectors: selector named without the `select` prefix (`getUsers`) and exported directly outside a query object.
- ngrx-selectors: plain arrow function selector bypassing memoization (`selectUserCount`).
- ngrx-selectors: impure selector — `console.log` + `Date.now()` (`selectSelectedUserName`).
- ngrx-selectors: `state.selectedUser.firstName` throws on null — no `?.`/`?? null`, return type not widened.
- ngrx-selectors: `selectSortedUsers` mutates its input (`Array.prototype.sort` in place).
- ngrx-selectors: `selectVisibleUsers` rebuilds every element (`users.map((user) => ({ ...user }))`) so no unchanged
  reference survives — memoization is defeated and every OnPush consumer re-renders.
- ngrx-selectors: derived selectors read the raw feature state instead of composing selectors; projector args/returns untyped.
- ngrx-selectors: wizard gate misnamed (`selectNextStepAllowed`, not `selectCanGoToNextStep<Step>`), composed from raw state instead of flag selectors.
- ngrx-selectors: parameterized selector for a value obtainable by composition (`selectUserById`).
- ngrx-selectors: UI-data selector builds the table inline instead of delegating to a shared `form*`/`generate*` util; duplicated literal (`['name', 'status']` twice).
- ngrx-selectors: `buildSummaryPayload` is an exported, non-`_`-prefixed module-level builder declared at the TOP of
  the file — payload builders are private `_`-prefixed functions at the bottom.
- ngrx-selectors: `selectHeaderSummary` composes `UserPanelTableQuery.selectTableData` although that query object is
  declared BELOW it (the referenced query export must be defined above the usage).
- ngrx-selectors: query object misnamed and PascalCase (`UserPanelSelectors` instead of `userPanelQuery`;
  `UserPanelTableQuery` instead of `userPanelTableQuery`), and its export order is alphabetical instead of thematic.
- code-quality: `selectTableData` is exported twice — through `UserPanelSelectors` and through `UserPanelTableQuery`.
- ngrx-selectors: `selectOrphan` belongs to no query object — dead code.
- ngrx-selectors: forbidden import of the actions file.

### data-access/+state/user-panel.effects.ts

- ngrx-effects + architecture: `@Injectable({ providedIn: 'root' })` on an effects class.
- ngrx-effects: dependency fields not `private readonly _camelCase`; `svc` is a shortened generic name; action stream named `actions` (not `_actions$`); effect `loadUsers`/`logLoadedUsers` missing the `$` suffix.
- ngrx-effects: forbidden facade injection; `store.dispatch(...)` inside the class; manual `subscribe()` in the constructor.
- ngrx-effects: `loadUsers` — `catchError` OUTSIDE `switchMap` (first error kills the stream) and swallowed via `EMPTY` (general: errors never swallowed; no fail action exists).
- ngrx-effects: `refreshUsers$` uses `mapResponse` whose `error` branch returns nothing (just a `console.log`) — the
  reducer never receives a fail action, `isLoading` stays `true` and the user is told nothing (🔴 High); the
  `console.log` is also leftover debug output (general).
- ngrx-effects: `searchUsers$`'s `catchError` opens a snackbar itself — the failure must reach the user through the
  state the fail action writes.
- ngrx-effects: `withLatestFrom` instead of `concatLatestFrom`.
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2 — import from `rxjs`).
- ngrx-effects: truthiness state guard (`!!users.length`) where `0` is a valid value.
- ngrx-effects: `mergeMap` for a search (races/out-of-order results — should be `switchMap`).
- ngrx-effects: `tap` mutates the action payload and runs domain logic (`buildResultLabel`).
- ngrx-effects: `Date.now()` in a success payload (+ `as any` to smuggle it).
- ngrx-effects: `reloadOnStepChange$` reacts to the cross-area `layoutActions.setActiveStep` with no `filter(...)`
  narrowing to this area/step — every sibling area reacts to the same layout event.
- ngrx-effects + code-quality: `reloadOnStepChange$` and `reloadOnNavigationReset$` are byte-identical bodies for two
  triggers — one `ofType(a, b)` effect.
- general: cross-area code imported through a relative path (`../../../layout/data-access/+state/layout.actions`)
  instead of a tsconfig path alias.
- ngrx-effects: `logLoadedUsers` has no `{ dispatch: false }` — re-emits `loadUsersSuccess` into the stream (infinite loop).
- security: token read from `localStorage` and logged (`console.log`); response data persisted to `localStorage` (PII in storage + leftover debug logging).
- ngrx-effects: polling with hard-coded `timer(0, 5000)` — interval not from central config, no `_stop$`/`takeUntil`, no stop effect (performance: unbounded async work), and no `ofType`/`filter` narrowing.
- ngrx-effects: dialog opened without the three generics; `afterClosed()` without a cancel `filter` — cancellation dispatches `dialogResult: undefined`; cast (`result as string`) instead of a type predicate.
- ngrx-effects: `confirmDetails$` merges the dialog component's `selected` output stream without
  `takeUntil(dialogRef.afterClosed())`, so that subscription outlives the dialog.
- ngrx-effects: `forkJoin` composing two identical requests instead of returning an action array (also a duplicate backend request — performance).
- ngrx-effects: pure helper (`buildResultLabel`) as a private method instead of a module-level function.
- architecture: component imported into the data-access layer via the forbidden `ui` barrel (`UserCardComponent` as dialog target).

### data-access/+state/user-panel.facade.ts

- ngrx-facade + architecture: `@Injectable({ providedIn: 'root' })` on a facade.
- ngrx-facade: actions object exposed publicly (`readonly actions`).
- ngrx-facade: signal name ≠ selector name (`list` vs `selectUsers`-style); `isLoading` wired to an unrelated selector (`selectSelectedUserName`) — copy-paste regression.
- ngrx-facade: raw `select()` observable in the public API (`users$`).
- ngrx-facade: `computed()` inside the facade (`summary`) — derivation belongs in selectors.
- ngrx-facade: local caching of state (`cachedUsers`).
- ngrx-facade: signal order is not thematic — the loading flag comes last, after the collections and the derived
  `summary`, and the methods do not follow the signal order either.
- best-practices: constructor DI instead of `inject()`; store `public`, not `private readonly _store`.
- ngrx-facade + http-service + architecture: HTTP service injected and called directly from the facade (`searchAndReturn`) — effects are the only HTTP consumers.
- ngrx-facade: method takes a destructured object param with `?` instead of positional `| null` params.
- ngrx-facade: method contains logic (`if`) and multi-dispatch; `searchAndReturn` returns an `Observable` without the wait-until-effect-completes helper and has a side effect in `map`.

### data-access/+state/index.ts

- architecture: barrel `index.ts` outside `models/` is forbidden (and it re-exports the whole state layer to the world).
- code-quality: no file in the repo imports through this barrel — every consumer already uses a concrete path, so the file is dead on arrival.

### data-access/services/user-panel.service.ts

- security: hardcoded API key (`API_KEY = 'sk_live_...'`) — secret in the diff; also SCREAMING_SNAKE (general).
- security + http-service: key appended to query params and an `Authorization` header hand-built per request (must come from the interceptor).
- http-service: `endpoints` exported (must be module-level, non-exported); hard-coded absolute base URL (private endpoint); URL interpolation outside `endpoints` (string concatenation in methods). The path text itself — including the leading slash in `searchUsers` — is out of scope and must NOT be reported.
- http-service + code-quality: `endpoints.users` and `endpoints.usersList` hold the SAME URL — one entry serves several verbs, the entry is never duplicated.
- http-service: local interface declared in the service (`SearchResponse`).
- http-service: `@Injectable()` without `providedIn: 'root'` (inverse of the facade rule).
- http-service + best-practices: constructor injection in a new service; store injected into an HTTP service.
- http-service: `Observable<any>` (+ `get<any>`) — no honest response generic; `pageSize ?? 25` instead of a default parameter value.
- http-service: `.pipe(map, catchError, tap)` inside the service — mapping/error handling belong to reducer/effects; `catchError(() => of([]))` swallows failures (general); `tap` + `console.log` logging.
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2 — import from `rxjs`).
- http-service: method names `getUsers`/`deleteUser` instead of `loadUsers`/`removeUser`; `firstValueFrom` forbidden.
- best-practices + http-service: `loadUserList()` uses `toPromise()` (removed in RxJS 8) and returns a promise from an HTTP service.
- security: `withCredentials: true` on the users request with no reviewed, documented cross-origin case.
- security: user email as a query param (`?email=` — PII in URL).
- models: `UserDto` imported by concrete path from outside `models/` (must go through the barrel).
- http-service: a spec exists for a pure HTTP wrapper (see below) — forbidden.

### data-access/services/user-panel-ui-state.service.ts

- architecture: self-contained local UI state kept in a hand-rolled `BehaviorSubject` service — it must be an
  `@ngrx/signals` `signalStore()` provided in `@Component.providers` and mutated only through `patchState`.
- architecture: `selectedUser` is feature-slice state, so it belongs in the NgRx store, not in a component-level store at all.
- architecture: `@Injectable({ providedIn: 'root' })` makes this "local" state a global singleton shared by every route instance.
- http-service: a file matching `data-access/services/*.service.ts` that executes no request and keeps state —
  the folder is HTTP-only and "keeping state" is explicitly forbidden there.
- architecture + feature-component: injected directly by the feature component (components reach state only through the facade).
- code-quality: `isOverlayOpen$` duplicates the component's own `isOverlayOpen` field; `selectedUser$` duplicates the `selectedUser` state field.
- test-coverage: no spec (🔵).

### data-access/services/user-panel.service.spec.ts

- unit-tests: spec next to the code instead of a sibling `tests/` folder.
- unit-tests: existence-only test (`toBeDefined`); `{} as unknown as X` double cast.
- http-service: pure HTTP wrapper must have no spec at all.

### data-access/+state/tests/user-panel.reducer.spec.ts

- ngrx-reducer-test: TestBed + `provideMockStore` in a reducer spec (no TestBed, no mocks allowed).
- ngrx-reducer-test: shared `STATE` referencing the exported const directly — inputs must be fresh spreads per test; `{} as UserPanelState` used as input.
- unit-tests: SCREAMING_SNAKE test const (`STATE`).
- unit-tests: no `it` description starts with `should` (`'sets loading on load users'`, `'stores users on success'`, `'stores search results'`, `'keeps the filtered users'`, `'clears the users'`).
- general + unit-tests: `xit('clears the users')` — a skipped test committed to the diff (🔴 High).
- ngrx-reducer-test: single-field assertions (`state.isLoading`, `users.length`, `filteredUsers.length`) instead of whole-state `toEqual({ ...initialState, ... })`.
- ngrx-reducer-test: no `it.each` success/fail loading-reset dataset; no fail-action test at all.
- ngrx-reducer-test: incomplete fixture `{ id: '1' } as UserDto` where the handler reads fields.
- ngrx-reducer-test (absences): no anti-duplication upsert test, no null-guard no-op test, no reset-lists-fields test, no edit-mode seeding tests, no default-selection fallback tests.
- unit-tests: the spec is zone-based (`TestBed.configureTestingModule` without `provideZonelessChangeDetection()`) although `app.config.ts` provides it.
- test-coverage: branches of `searchUsersSuccess` (`switch` 0/default) and `setConfirmationDialogResult` untested.

### data-access/+state/tests/user-panel.selectors.spec.ts

- ngrx-selectors-test: MockStore + `store.select` instead of `.projector(...)` (no TestBed/MockStore allowed).
- ngrx-selectors-test: pass-through selector tested (`getUsers`).
- ngrx-selectors-test: derived selector fed a full state object instead of its input selectors' outputs (`selectNextStepAllowed.projector({...state})`).
- ngrx-selectors-test: boolean selector has only the `true` case; gate selector lacks one false-test per AND clause.
- ngrx-selectors-test: `toEqual` asserting a passed-through reference where `toBe` is required (`selectSortedUsers`).
- unit-tests: `describe('user panel selectors')` — a descriptive title starting with a lowercase word.
- unit-tests: no `it` description starts with `should` (`'selects users'`, `'allows next step'`, `'builds table data'`, `'sorted users returns the same list'`, `'builds the search summary'`).
- unit-tests: the `subscribe(...)` in `'selects users'` is not bounded with `take(1)`.
- unit-tests: the same fixture literal (`{ id: '1', firstName: 'Jan', last_name: 'Kowalski' }`) is hand-written three times instead of being defined once and reused/spread.
- ngrx-selectors-test (absences): no edit-mode safety test, no parameterized-selector two-step test (`selectUserById`),
  nothing for `selectVisibleUsers`/`selectHeaderSummary`.

### data-access/+state/tests/user-panel.effects.spec.ts

- ngrx-effects-test: `actions$` assigned eagerly at module level with `of(...)` — must be a lazily reassigned-per-`it` variable.
- ngrx-effects-test: HTTP simulated with `of()` instead of per-endpoint `Subject`s.
- ngrx-effects-test: service mock typed with `as unknown as UserPanelService` instead of `satisfies Partial<...>`; variable named `svc` (unit-tests: full descriptive names).
- unit-tests: no `it` description starts with `should` (`'loads users'`, `'reloads after the dialog'`).
- ngrx-effects-test: `fakeAsync`/`tick` instead of the `(done)` callback + `pipe(take(1))`; the second test uses a bare untyped `(done)` instead of `(done: jest.DoneCallback)` and an unbounded `subscribe`.
- ngrx-effects-test: bare `toHaveBeenCalled()` — payload not asserted.
- ngrx-effects-test: `searchAfterDialog$` emits two actions but the test asserts only the first — a multi-action effect
  is buffered with `bufferCount(actionCount)` and every action asserted.
- ngrx-effects-test: no `afterEach` (`jest.clearAllMocks`, `resetSelectors`); no `ngMocks.faster()`; setup in `beforeEach` not `beforeAll`; no `store: MockStore` field.
- unit-tests: `fakeAsync`/`tick` do not exist without the zone.js polyfill the app no longer needs — the spec must run the app's zoneless mode.
- ngrx-effects-test (absences): no error test for any HTTP effect, only two of ten effects tested, no non-emission `filter` tests, no `{ dispatch: false }`/`tap` side-effect tests, no dialog-cancel test.

### data-access/+state/tests/user-panel.facade.spec.ts

- ngrx-facade-test: TestBed instead of `MockBuilder(Facade).mock(Store, storeMock)`; store mock cast with `as unknown as Store` instead of `Partial<Store>`.
- ngrx-facade-test: nested `describe`s for a proxy class (must be flat `it`s).
- ngrx-facade-test: bare `toHaveBeenCalled()` instead of `toHaveBeenCalledWith(actions.x({ ...payload }))`.
- ngrx-facade-test: signals tested (`facade.list()`); `expect.objectContaining` used.
- unit-tests: `it` descriptions do not start with `should` (`'dispatches'`, `'exposes the user list'`).
- ngrx-facade-test: no `afterEach` with `jest.clearAllMocks()`; no null-parameter variant tests; `searchAndReturn` untested.

### shared/guards/user-panel.guard.ts

- guards: class guard implementing `CanActivate` instead of a functional `const <predicate>Guard: CanActivateFn`; file name is not a predicate.
- guards: the role check is an access decision that must not even load the lazy chunk — it belongs in a `CanMatchFn`,
  not a `CanActivateFn` (which runs only after the bundle is fetched).
- guards: injects the store and an HTTP service (facades only); fires an HTTP request from a guard.
- guards: navigation targets as magic strings (`'/users/step-2'`, `'/forbidden'`) instead of the step enum; side effect through Router instead of the layout facade.
- guards: returns `Observable<boolean>` instead of reading facade signals and returning `boolean`.
- guards: `userPanelStepGuardFactory` returns a bare untyped arrow, not a `CanActivateFn`, and the routes file passes
  the factory itself (uninvoked) into `canActivate`.
- code-quality: two exports in a guard file the name promises holds one predicate.
- security: authorization decided from a client-side `localStorage` value.
- best-practices: constructor DI instead of `inject()` in the guard body.

### shared/guards/user-panel-init.guard.ts

- guards + test-coverage: no spec in the sibling `tests/` folder — every guard file has one (🔵).
- guards: injects the `Store` and dispatches an action from a guard (facades only, and a guard reads state, it does not write it).
- guards: navigation target as a magic string (`'/users/step-1'`) instead of the step enum, and the navigation goes
  through `Router` instead of the layout facade.
- guards: only one branch of the conditional navigation exists — the `else` path is implicit in the unconditional `return true`.
- security: an initialization/authorization decision taken from a client-side `localStorage` value.
- code-quality: exported but consumed by no route in the repo — dead code (the shell routes that should use it declare no `canActivate` at all).
- architecture: a second guard in the same folder as `user-panel.guard.ts` that partly duplicates its "load users if
  missing" purpose.

### shared/guards/tests/user-panel.guard.spec.ts

- general + unit-tests: `fdescribe` — a committed focused suite silently reduces CI to one file (🔴 High).
- unit-tests: `describe('user panel guard')` — descriptive title starting with a lowercase word.
- unit-tests: `it('returns something')` does not start with `should`; existence-only assertion (`toBeDefined`).
- unit-tests: SCREAMING_SNAKE const (`FACADE`); `as unknown as UserPanelFacade` double cast plus three `as never` casts.
- util-guard-test: the guard is constructed with `new` instead of being executed inside
  `TestBed.runInInjectionContext(() => guard(route, state))`.
- util-guard-test: the facade is not a `Partial<Facade>` `useValue` provider; no `afterEach` with
  `jest.clearAllMocks()` / `TestBed.resetTestingModule()`.
- util-guard-test: only one branch is exercised, and neither the returned value nor the exact `router.navigate(...)`
  call is asserted (`toHaveBeenCalledWith` / `toHaveBeenCalledTimes(1)`).

### shared/interceptors/user-panel-auth.interceptor.ts

- interceptors + best-practices: a class implementing `HttpInterceptor` registered through `HTTP_INTERCEPTORS` instead
  of a functional `const <purpose>Interceptor: HttpInterceptorFn` in `withInterceptors([...])`.
- interceptors + architecture: the file lives inside a feature area — an interceptor applies to every request by
  definition, so an area-scoped one is a layering violation.
- interceptors + best-practices: constructor DI instead of `inject()` inside the interceptor body.
- interceptors: mutable module-level state (`let refreshAttempts`).
- interceptors: `req.headers.set(...)` mutates the request instead of `req.clone({ ... })` — and because `HttpHeaders`
  is immutable the header silently never reaches the server.
- security + interceptors: the request URL, headers and body are logged, and so is every response.
- security + interceptors: the `Authorization` header is hand-built from `localStorage`, and `Cookie` is forwarded to a
  third-party origin (`analytics.thirdparty.example.com`).
- interceptors: `retry()` without an attempt count; `intercept()` calls itself recursively for the token refresh, and
  the refresh is fired once per request instead of being shared across in-flight requests.
- interceptors + general: `catchError` swallows the failure into `EMPTY`, opens a snackbar (renders UI) and dispatches
  a store action for a domain error.
- interceptors: `.subscribe()` inside the interceptor — a path that never returns the `next(...)` stream.
- test-coverage: no spec in a sibling `tests/` folder exercising the pass-through path and every error branch (🔵).

### shared/pipes/user-status.pipe.ts

- pipes: `name: 'UserStatusLabel'` is not camelCase and does not match the file name; class `UserStatusPipeClass` is not `<PascalCase>Pipe`.
- pipes + best-practices: `standalone: false` — the pipe is declared in `UserPanelModule` instead of being standalone.
- pipes: `pure: false` — an impure pipe re-runs on every change-detection cycle.
- pipes: `transform(value: any, mode?: any): any` — no explicit parameter/return types, `any` everywhere.
- pipes: injects the `Store`; `console.log`; DOM access (`document.title`).
- pipes + i18n: hard-coded user-facing text (`' account'`, and the labels it forwards from `userStatusLabel`).
- pipes + code-quality: duplicates `userStatusLabel` (models), `mapStatusToLabel` (util) and `buildResultLabel` (effects).
- pipes: used by exactly one template for something that is not a formatting concern — it belongs in a `computed()` or a selector.
- component: not listed in the feature component's `imports` array although its template uses it — the template breaks at runtime (🔴).
- test-coverage: no spec covering each branch of `transform` plus `null`/empty input (🔵).

### shared/utils/build-user-table.util.ts

- utils: export is a `const` arrow function and a `default` export (must be a named `export function`); missing explicit return types. (Grouping two related functions in one file is NOT the violation — see the bait list.)
- code-quality: `formatUserRow` only forwards to `deepClone` — a wrapper that adds no behavior.
- utils: impure — `Math.random()` inline id, `Date.now()`, and in-place `sort` mutating the argument.
- utils: `displayedColumns` hard-coded instead of `Object.values(<ColumnsEnum>)`; labels are texts, not i18n keys; rows lack an explicit row type; id not from the shared ID-generator util.
- security: new third-party dependency (`tiny-clone-x`) introduced silently.

### shared/utils/build-user-summary.util.ts

- utils: `buildUserSummary` is an arrow const export without explicit parameter and return types.
- utils: the two exports have nothing in common (a summary builder and a tag aggregator) — functions with nothing in
  common get their own file (contrast with the deliberate grouping bait in `build-user-table.util.ts`).
- utils: branching conditions written inline in the `if`s instead of well-named local flags; `const rows = []` is an
  untyped (implicit `any[]`) accumulator instead of an explicitly typed one.
- utils + i18n: displayed labels and yes/no-style values are hard-coded texts (`'Total users'`, `'Active users'`, `'Yes'`, `'User summary'`).
- utils: no null-safety — `users[0].firstName` throws on an empty array (no `?.`/`?? ''`).
- utils: `aggregateUserTags` deduplicates with a `for` loop and `indexOf` instead of a `Map` keyed by the identifier and
  a `reduce<ReturnType>` with an explicit accumulator type.
- utils + code-quality: the `Math.random()` id and the hard-coded `displayedColumns` array re-implement what
  `build-user-table.util.ts` already does — impure, and both must come from the shared ID generator / the columns enum.
- utils + test-coverage: no spec in the sibling `tests/` folder (🔵).

### shared/utils/map-user-dto.util.ts

- models: `mapUserDtoToVm` re-spells field names and nothing else (`id`→`user_id`, `firstName`→`display_name`) — the
  `UserVm` twin interface and this mapper are a layer that changes nothing; report as unnecessary code.
- models + general: `Dto` in the file name and in the function name.
- utils: arrow const export; a single consumer with a body far under ~10 lines — it stays inline at its call site.
- models + utils: `mapStatusToLabel` is a value→value `if` chain — it belongs in a `Record` mapper const
  (`user-status-label-mapper.const.ts`), not in a util function.
- code-quality: `mapStatusToLabel` is the fourth implementation of the same status/result label
  (`userStatusLabel`, `buildResultLabel`, `UserStatusPipeClass`).
- i18n: hard-coded labels (`'Active'`, `'Blocked'`, `'Unknown'`).
- utils + util-guard-test + test-coverage: no spec — an API→domain mapping util asserts the complete
  field-by-field mapping in one `toEqual` (🔵).

### shared/utils/tests/build-user-table.util.spec.ts (+ .snap)

- util-guard-test: TestBed in a util spec (plain `describe`/`it` only).
- unit-tests: SCREAMING_SNAKE fixture (`MOCK_USERS`); `as any` incomplete fixture; existence-only test; `it('builds table')` description not starting with `should`.
- util-guard-test: snapshot of impure output (id/timestamp change every run); `.snap` stored directly in `tests/` instead of `tests/__snapshots__/`.
- util-guard-test: the stored snapshot is also stale — it omits `rows` and `displayedColumnsLabels`, which the util returns, so the comparison fails even ignoring the non-deterministic fields.
- util-guard-test (absences): no empty/null edge cases; no `not.toBe(input)` copy assertion; `formatUserRow` untested.

### shared/utils/format-user-name.utils.ts

- utils: plural `.utils.ts` suffix (must be singular `.util.ts` — note: this also dodges the local glob; the naming/architecture rules must still catch it).
- utils: arrow const export, `any` parameter, no explicit return type, trivial single-consumer logic, duplicated inline name-joining already done in reducer/util (define once, reuse).
- utils + test-coverage: no spec (🔵).

### shared/index.ts

- architecture: a barrel `index.ts` in `shared/` is forbidden outright — `models/` is the only folder allowed to have one; every export here (both guards, the pipe and all four utils) must be imported from its concrete file.
- utils: the four util re-exports additionally break the utils rule that utils are never reached through a barrel.
- code-quality: nothing in the repo imports through it — dead on arrival.

### shared/routes/user-panel.routes.ts

- routes: export named `routes` and untyped (must be `userPanelRoutes: Routes`).
- routes + best-practices: eager `component:` import of the feature component instead of `loadComponent`.
- routes: simple-page variant carries `providers` (`provideState`/`provideEffects`/facade) and `canActivate` — must be thin and stateless.
- routes: no `title` on a user-navigable route.
- routes: helper function (`buildPath`) — no logic allowed in a routes file; it also returns `'/'` for an empty segment, so the route `path` is `'/'` instead of `''` and never matches.
- routes: `provideState('userPanel', reducer)` registers the slice under a magic string instead of the exported `userPanelFeatureKey` — it can drift from the key the feature selector uses.
- routes: `data` carries an untyped `Record<string, any>` bag (and it is `as`-cast into that type).
- guards: `userPanelStepGuardFactory` is passed into `canActivate` uninvoked — a guard factory is invoked inside the array.
- routes: no `withComponentInputBinding()` anywhere in the routing setup, so the feature component has no way to receive route params as `input()`s (it falls back to reading `location.search` by hand).
- architecture: area has BOTH `shared/routes/` and `shell/` (either, never both).

### shared/routes/tests/user-panel.routes.spec.ts

- routes: route files must have no unit specs.
- unit-tests: existence-only test; `describe('user panel routes')` starts with a lowercase word.

### shell/user-panel-shell.routes.ts

- routes: wizard variant with magic-string step paths (not the step enum), no `canActivate` guards (initialization + previous-step), no titles.
- routes: export has no `: Routes` type annotation, so route definitions are not type-checked.
- security: the two step routes are added with no guard at all — access control is enforced by route guards.
- code-quality: both steps load the exact same component with the same dynamic import — a copy-pasted route entry.
- architecture: duplicate routing variant for the area (see above).

### user-panel.module.ts

- best-practices: new `NgModule` (standalone only) — and it exists only to declare a pipe and a directive that must both be standalone.
- architecture: file outside every dedicated location (area root).

### components-user-panel/feature/feature-user-panel/feature-user-panel.component.ts

- feature-component: class `UserPanelComponent` (should be `FeatureUserPanelComponent`), selector `user-panel` (missing app prefix + `feature-` segment).
- component: no `changeDetection: ChangeDetectionStrategy.OnPush`.
- component: inline `styles: [...]` — no own `.scss` file; hard-coded color in it (component-styles).
- general: import order scrambled (relative first, framework last); `@angular/common` imported twice.
- general: cross-area code imported through a relative path (`../../../../layout/data-access/+state/layout.actions`).
- architecture: models imported by concrete paths from outside `models/` (`../../../models/enums/user-status.enum`, `../../../models/consts/user-panel-title.const`) instead of through the models barrel.
- component: `imports` array not matching the template in BOTH directions — `NgOptimizedImage` unused; `ReactiveFormsModule` missing though `[formControl]` is used; the `translate` pipe, the `UserStatusLabel` pipe and the `highlight` directive used by the template have no entry (🔴 — the template breaks at runtime).
- component: `CommonModule` in `imports` — the native control flow and `[class.x]`/`[style.x]` bindings replace it.
- component: every member is public — template-only members must be `protected`, internals (`destroy$`, `sub`, `usersBackup`, `childFormsValid`) `private`.
- best-practices: a writable signal published on the public surface (`selectedTab`, `isLocked`, `formSnapshot`) — expose `asReadonly()`/`computed()`.
- best-practices: explicit `standalone: true`; `@Input()`/`@Output()` decorators with `!` definite assignment and `EventEmitter<any>` instead of `input.required`/`output()`.
- best-practices: `@ViewChild('panelRoot', { static: true })` — view queries are the signal function `viewChild.required()`, and `{ static: true }` never appears.
- best-practices: redundant type annotation on a typed call (`facade: UserPanelFacade = inject(UserPanelFacade)`).
- feature-component + architecture: store injected + `store.dispatch`, actions/selectors imported, HTTP service injected and called, plus the hand-rolled `UserPanelUiStateService` injected — components may talk only to the facade.
- component: injected fields public and unprefixed (`facade`, `store`, `svc` — generic name, `cdr`, `zone`, `uiState`), not `private readonly _...`.
- component: `dataTestPrefix` equals the selector (must be a stable descriptive name).
- general/i18n: hard-coded user-facing strings (`toastMessage` values, `banners`, template texts).
- performance: mutable class fields bound in the template (`title`, `resultCount`, `showTooltip`, `isOverlayOpen`, `activeTab`, `toastMessage`, `bannerIndex`, `banners`, `rowCounter`, `secondsLeft`, `isBrowser`); `resultCount` mutated in `ngDoCheck` every CD cycle; `ngDoCheck` itself forbidden.
- performance: state mutated inside `ngAfterViewInit` (`resultCount` from the DOM) — ExpressionChangedAfterItHasBeenChecked.
- performance: change-detection escape hatches — `NgZone.run()` wrapping `ChangeDetectorRef.detectChanges()`.
- performance: `effect()` writing signals to emulate derivation (`selectedTab.set(...)` from `users()`) — that is a `computed()`.
- best-practices: `effect(..., { allowSignalWrites: true })` — the option stopped doing anything in v19 and is dead config.
- performance: an `effect()` starting a `setInterval` without registering teardown through the `onCleanup` callback — every re-run stacks another timer.
- performance: an `effect()` reading signals it only samples (`users()`, `selectedTab()`) while reacting to `isLocked()` without wrapping them in `untracked()` — the accidental dependency turns the effect into a loop.
- performance: an `effect()` reading the DOM (`getBoundingClientRect()`) — render-phase work that must re-run on a signal change is `afterRenderEffect()`, and a plain `effect()` measures the previous frame.
- general: string-index type access (`UserPanelState['users']`).
- component: `location.search`/`window`/`document` read in field initializers, the constructor and `ngOnInit` — browser-only work belongs in `afterNextRender`/`afterEveryRender`.
- feature-component: `computed()` wrapping a facade signal (`filtered`) and `pipe(map(...))` on a facade stream (`userNames$`) — derived state belongs in a selector (historically under-reported rule).
- architecture: `httpResource()` fetching feature-slice data in a component — an area's server state travels component → facade → action → effect → HTTP service → reducer.
- performance: `httpResource` read via `.value()` without `hasValue()` guard (in `onSave` and `ngOnInit`); resource params read a non-signal `@Input`.
- component: manual `Subject`/`Subscription` cleanup pattern + `ngOnDestroy` (must be `takeUntilDestroyed`/`DestroyRef`); `destroy$` never `.complete()`d; inner subscription in `valueChanges` never cleaned (leak).
- feature-component: the on-exit flush (`facade.loadUsers(...)`) lives in `ngOnDestroy` instead of `inject(DestroyRef).onDestroy(...)`.
- performance: `toSignal()` inside a getter — new subscription per read.
- component: local state behind a setter (`set pageSize`) instead of a `signal()`; `get currentPageSize()` is a getter that only returns a field (code-quality: boilerplate); `ngAfterContentInit()` is an empty lifecycle hook (code-quality).
- component: constructor does loads/dispatches and logging (only `effect()` allowed); `effect()` writes state (`resultCount`) and patches the form without `{ emitEvent: false }` (feedback loop with the `valueChanges` subscription).
- best-practices: `inject()` inside a method (`onSave`) — NG0203 runtime error.
- feature-component: route/query params read by hand via `URLSearchParams(location.search)` instead of arriving as signal `input()`s bound by `withComponentInputBinding()`; edit-mode has only the id-present branch (no else), and it is a `ngOnInit` branch rather than a signal read.
- best-practices: `subscribe()` nested inside `subscribe()` (the inner stream escapes the outer `takeUntil`).
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2).
- best-practices: `toSignal()` called without `initialValue`/`requireSync`, so the signal type silently widens with `undefined`.
- best-practices: a bare `// @ts-ignore` in `runReport` — no justification, and `@ts-expect-error` is the form that fails once the problem is fixed.
- performance: hard-coded `setInterval` polling, never cleared, resubscribing a cold HTTP observable each tick.
- component: untyped form (`UntypedFormGroup`/`UntypedFormControl`) instead of `_fb.nonNullable.group` with explicit generics; `addValidators` without `updateValueAndValidity()`; `valueChanges` without `distinctUntilChanged(isEqual)`.
- component: the lock effect calls `form.disable()`, so `onSave` reading `this.form.value` silently drops every disabled control from the payload — it must be `getRawValue()` (🔴 High).
- feature-component: aggregate child-form validity hand-rolled (`childFormsValid` array + `registerChildForm`) instead of the shared forms-validity service pattern (components-reference token, `debounceTime` from the central config, `distinctUntilChanged()`, `takeUntilDestroyed(...)`).
- feature-component: `goToNextStep()` re-implements the wizard gate inline instead of combining the facade's gate selector with local form validity, and its label (`'You can continue to the next step'`) is a hard-coded text, not an i18n key.
- feature-component: `registerChildForm`/`goToNextStep`/`onSave` are handlers with business logic, not thin proxies to facade methods.
- component: `compareWithId` is a method, not a `readonly` arrow field, and it is not null-safe (`?.`) although the template binds it to `[compareWith]`.
- security: `setTimeout('this.refresh()', 500)` — string argument; `new Function('users', expression)` built from a caller-supplied string; `bypassSecurityTrustHtml(user.bio)` on API-derived data (Critical).
- security: `document.querySelector('#' + user.id)` — API-derived content used to build a selector.
- feature-component: handler with business logic (`onSave` filters users, dispatches, calls HTTP `deleteUser` with a floating promise); `saved.emit` of a double-cast payload (`as unknown as`).
- performance/template: `formatDate`/`greet` methods called from template bindings.
- best-practices: `@HostListener` instead of `host: {}`.
- i18n: greeting built by string concatenation (`buildGreeting(user) + ', ' + this.title`) instead of a translation with params.
- general: `console.log` calls; commented-out `refresh()` code block.
- component: enum alias renamed (`statuses = UserStatus` — must keep the enum name, `userStatus`); signals/aliases not `readonly`; member order broken (a setter and getters between fields, handlers before lifecycle hooks, fields interleaved).
- accessibility 2.1.4: `@HostListener('document:keydown.s')` — a single-character shortcut bound to the whole document, always active, with no way to turn it off or remap it (it also steals `s` from every text field).
- accessibility 2.4.3: `document.getElementById('panel-root')?.focus()` targets a `<div>` that has no `tabindex`, so the focus move silently does nothing and the user is left at the top of the document.
- accessibility 2.2.2: the second `setInterval` rotates the promo banner every 4 s with no pause/stop/hide control (and, like the polling one, is never cleared).
- accessibility 2.2.1: the third `setInterval` counts `secondsLeft` down and redirects to `/login` at zero — a time limit the user cannot turn off, adjust or extend, and no warning with at least 20 s to extend it.
- accessibility 3.2.2: `onRoleChange` navigates (`window.location.href = ...`) from the `change` event of a `<select>` — changing a setting must not change context by itself.
- accessibility 3.3.4: `deleteAccount()` and `removeUser()` call `deleteUser(...)` immediately — no confirmation, no undo for an irreversible operation.
- accessibility 2.5.1: `onPinchZoom` implements zooming as a multipoint `touchmove` gesture with no single-pointer alternative.
- accessibility 1.4.3: inline `styles` set `.promo { color: #cccccc; background: #ffffff; }` — about 1.6:1 against white, far under 4.5:1.
- accessibility 2.4.7: inline `styles` kill the focus ring for every button, link and the toolbar (`button:focus, a:focus, .toolbar:focus { outline: none; }`) with no `:focus-visible` replacement.
- accessibility 2.4.11: `.panel-actions { position: fixed; bottom: 0; height: 72px; }` — a fixed action bar with no matching `scroll-padding-bottom`, so it covers whatever the user tabs to at the bottom of the list.
- accessibility 2.5.8: `.icon-btn { width: 16px; height: 16px; }` and `.remove { width: 14px; height: 14px; }` — both under the 24×24 CSS px minimum, with no spacing exception.
- accessibility 1.4.10: `.panel { width: 1180px; }` — a fixed pixel width forces two-dimensional scrolling at 320 CSS px / 400% zoom.
- test-coverage: no spec for the whole component (🔵).

### components-user-panel/feature/feature-user-panel/feature-user-panel.component.html

- component-template: `*ngIf`/`*ngFor` instead of `@if`/`@for`; `[ngClass]`/`[ngStyle]` instead of `[class.x]`/`[style.x]`; hard-coded color in `ngStyle`.
- component-template: `*ngFor` without any stable `track`.
- performance: LCP hero image inside `@defer (on viewport)` (layout shift + deferred LCP); `<img>` without `ngSrc`, without `height`, no `priority`.
- performance: the inner `@defer (on viewport)` nested in the hero `@defer (on viewport)` repeats the outer trigger — identical triggers cascade into one simultaneous load and defeat the split.
- component-template: all three `@defer` blocks lack a `@placeholder` — the viewport trigger has no element to observe — and none declares `@loading`/`@error` although the wait and the failure are user-visible.
- component-template: `@switch (activeTab)` has no `@default`, so an unknown tab renders nothing.
- component-template: no `@let` at the top of the template although `users()` is read four times.
- component-template: `[(ngModel)]` template-driven binding (best-practices) mixed with reactive `[formControl]`; hard-coded placeholders.
- component-template: no `data-test` on any interactive native element despite `dataTestPrefix` — the only `data-test` in the template sits on the `<user-card>` component host tag, where it is forbidden (the selector already targets hosts).
- component-template: logic and state writes inline in the template — `facade.loadUsers({ pageSize: 25 })`, `showTooltip = true/false`, `activeTab = 'all'`, `isOverlayOpen = false`, and `(click)="removeUser(user); rowCounter = rowCounter + 1"` (two statements after a `;`).
- component-template: `rowCounter` is a counter signal/field maintained next to the loop and rendered as the row number — loop metadata comes from `$index`/`$count` of the `@for` block itself, and the same counter is threaded down into `<user-card [index]="rowCounter">`.
- component-template + architecture: a hand-built `<table>` (and hand-built `<input>`/`<select>`/`<button>`/tooltip) where the design system ships the equivalent component — the shared library must be searched and reused first.
- component-template: redundant global utility classes on the panel root (`mt-0 p-0`) that change nothing.
- component-template: `<user-card …></user-card>` projects no content and must be self-closing.
- performance: `[user]="{ id: user.id, firstName: user.firstName, last_name: user.last_name }"` rebuilds an object on every change-detection check inside a binding.
- general: in-app navigation as raw `<a href="/users">`/`/reports`/`/help`/`/docs/...` links instead of `routerLink` — every one of them reloads the app and discards router state.
- component-template: literal property binding `[title]="'Refresh'"` on a native `<button>` — still a defect, the input-name-collision exception covers component inputs only, not native elements (false-negative bait); facade call with logic inline in the template (`facade.loadUsers({ pageSize: 25 })`).
- component-template: `title="User details"` as a plain attribute on the `<user-card>` host — the `title` input collides with the native HTML attribute, so the binding form (`[title]="'User details'"`) is required; the plain attribute lands in the DOM and adds an unwanted browser tooltip (the value is also yet another hard-coded text — i18n).
- component-template: method calls in interpolations (`formatDate(...)`, `greet(...)`).
- security: `[innerHTML]` bound to sanitizer-bypassed API data; `target="_blank"` link without `rel="noopener noreferrer"`; `[href]="returnUrl"` straight from query params (open redirect); `[href]="user.homepage"` unvalidated API URL.
- component-template: duplicated branch markup (`Found ... users` + Export button twice) instead of `ng-template` + `ngTemplateOutlet`.
- component-template: `async` pipe (`userNames$ | async`).
- i18n + code-quality: `{{ 'page.userPanel.labels.userNameLabel' | translate }}` resolves to no key in `en.json` (the key there is `user_name_label`) — a renamed key whose consumers were never checked.
- accessibility 1.1.1: hero `<img alt="hero-users.png">` — the alternative is a file name; `<img [src]="captchaUrl">` has no `alt` at all; the icon-only 🔄 button and the ✖ remove control have no accessible name; decorative inline `<svg class="logo">` is exposed instead of `aria-hidden="true"`.
- accessibility 1.3.1 / 2.4.6: heading order jumps `h1` → `h4`, and `<div class="section-title">` is a heading styled by CSS only; the two `<input type="radio" name="role">` sit outside any `fieldset`/`legend` and their labels are bare text nodes; the `<table>` header row is built from `<td>` cells with no `<th>` and no `scope`.
- accessibility 2.4.1: no landmarks and no skip link — `<div class="nav">`, `<div class="footer">` and no `<main>` anywhere in the view.
- accessibility 3.1.2: `Zgadzam się na przetwarzanie moich danych osobowych.` is rendered inside an `<html lang>`-less English document with no `lang="pl"` of its own.
- accessibility 3.3.2 / 1.3.1: no control in the template has a label — search, email, confirm-email, password, captcha and the role `<select>` are identified by `placeholder`/`option` text only.
- accessibility 1.3.5: the search, email and confirm-email inputs declare no `autocomplete` token at all, and the password field opts out of autofill with `autocomplete="off"`.
- accessibility 1.4.1: required state is carried only by the red `<span class="req">*</span>`, and the row status only by `<span class="status-dot">` colored green/red — no text or icon equivalent (the error text is also styled through `.red-text`).
- accessibility 1.4.13: the ⓘ tooltip opens on `(mouseenter)` only — no focus trigger, no Escape dismissal, and it disappears the moment the pointer leaves, so it can never be hovered.
- accessibility 2.1.1: `(click)` on `<div class="toolbar">`, `<span class="chevron">` and the `role="tab"` divs, with no `tabindex` or keyboard handler — keyboard users cannot reach or fire them.
- accessibility 1.3.2 / 2.4.3: `tabindex="3"` on the toolbar — a positive value rewrites the focus order of the whole page.
- accessibility 2.5.7: the user list reorders through `draggable="true"` + `(dragstart)`/`(drop)` only — no button, arrow-key or select alternative.
- accessibility 2.5.1: the table's `(touchmove)` pinch-zoom is a multipoint/path-based gesture with no simple-pointer equivalent.
- accessibility 2.5.2: the ✖ remove control fires on `(mousedown)`, so the action commits before the pointer is released and cannot be aborted.
- accessibility 3.2.4: the same remove action is presented twice with different identification — a 🗑 button labelled `Erase` in the table and a ✖ span labelled `Remove` in the list.
- accessibility 4.1.2: `role="presentation"` on that same interactive ✖ span; `role="tab"` divs with no `tablist` parent, no `aria-selected` and no roving `tabindex`; static `aria-expanded="false"` never bound to state; misspelled `aria-lable="Active filter"` on the chip; `aria-hidden="true"` wrapping a focusable `<button>Legend</button>`.
- accessibility 4.1.2 / 3.3.1: `[disabled]="form.invalid"` on the primary action removes it from the tab order, and the reason it is blocked is nowhere in the DOM — an unavailable-but-explained control uses `aria-disabled`.
- accessibility 2.5.3: `aria-label="Submit form"` over the visible text `Save changes` — the accessible name does not contain the visible label, so voice control cannot activate it.
- accessibility 2.1.2 / 2.4.3: the `*ngIf="isOverlayOpen"` overlay is a dialog in everything but behavior — focus never moves into it, it has no `role="dialog"`/`aria-modal`, nothing outside it is inert, Escape does not close it and focus never returns to the trigger.
- accessibility 3.2.1 / 3.2.2: the email input opens that overlay on `(focus)` and submits the form on `(change)` — two context changes with no explicit activation.
- accessibility 3.3.1 / 3.3.3 / 4.1.3: `Email is required` is a floating `<div>` — not tied to the control (`aria-describedby`, `aria-invalid`), not announced (no `aria-live`, no shared alert), with no correction suggestion; the `toast` message has the same problem.
- accessibility 3.3.4: `Delete account` calls `deleteAccount()` straight from the click — an irreversible action with no confirmation, review or undo.
- accessibility 3.3.7: `Confirm your email (type it again)` re-asks for a value the user already entered in the same form instead of prefilling or reusing it.
- accessibility 3.3.8: the password input blocks paste (`(paste)="$event.preventDefault()"`) and disables autofill (`autocomplete="off"`), and the captcha image + `Retype the code from the image` field is a cognitive function test with no alternative path.
- accessibility 2.4.4: `<a class="more">Click here</a>` — link text that does not say where it leads; the `target="_blank"` Homepage link does not announce that it opens a new tab.
- accessibility 2.2.2: the promo banner rotates on a timer with no pause/stop/hide control (the rotation itself lives in the component).
- accessibility 2.2.1: `Session expires in {{ secondsLeft }} seconds` announces a time limit the user cannot extend.
- accessibility 1.4.2 / 1.2.2 / 1.2.5: `<video autoplay loop>` without captions or `<track>`, `<audio autoplay>` that cannot be stopped.
- accessibility 3.2.6: `Need help?` is rendered only under `*ngIf="userId"`, so the help mechanism disappears on every other entry into the panel.
- accessibility 3.2.3: the panel's own nav repeats the shell navigation in the opposite order (`Reports`, `Users` here vs `Users`, `Reports` in `index.html`).
- feature-component: rich presentation markup rendered directly in the feature (belongs in `ui-*` children); deferred `user-card` imported through the `ui` barrel `index.ts` (performance: barrel import keeps it in the main bundle).
- i18n: every user-facing text hard-coded; `page.userPanel.labels.greeting` exists in en.json but code concatenates instead.

### components-user-panel/feature/feature-user-panel/user-panel.helpers.ts

- architecture: non-`*.component.*` file next to a component (only component files + `tests/` allowed).
- architecture/models: interface (`HelperUser`) belongs in `models/`, const in `models/consts`, function in `shared/utils/`.
- general: SCREAMING_SNAKE const (`MAX_USERS`); hard-coded user-facing text built by concatenation (`'Welcome ' + user.name`) — i18n.
- code-quality: `MAX_USERS` has no consumer left in the repo.

### components-user-panel/feature/feature-user-panel/highlight.directive.ts

- components-folder + architecture + directives: a `.directive.ts` sitting next to a component file — only
  `*.component.*` files and a `tests/` folder may live there, and a directive lives in a shared location.
- directives: file name is not `<name>.directive.ts` in kebab-case of the directive, class `Highlight` is not
  `<PascalCase>Directive`, and the selector is an element selector without the app prefix instead of an attribute
  selector (`[appPrefixHighlight]`).
- directives + best-practices: `standalone: false` — declared in `UserPanelModule` instead of being standalone.
- directives + best-practices: `@Input()`/`@Output()` decorators instead of `input()`/`output()`; `@HostBinding`/`@HostListener` instead of `host: {}`.
- directives + best-practices: constructor DI instead of `inject()`.
- directives: direct `nativeElement` writes in `ngOnInit` (`innerHTML`, `style.background`) instead of `Renderer2`/a signal-driven host binding, and no `afterNextRender` for the DOM work.
- security: `nativeElement.innerHTML = '<b>' + … + '</b>'` — DOM injection bypassing Angular sanitization.
- directives: `document.addEventListener('scroll', …)` is never removed through `inject(DestroyRef).onDestroy(...)`.
- directives: two copy-pasted host bindings (`style.outline`, `style.background`) instead of composition through `hostDirectives`.
- directives + architecture: injects the area facade AND the HTTP service, calls `facade.loadUsers(...)` and subscribes to a request — a directive is a presentation concern with no domain state; `lastUserName` is domain state.
- directives: not listed in the `imports` array of the component whose template uses it.
- general/i18n: hard-coded color literal (`'#ffff00'`) duplicated in three places; component-styles: colors come from the theme palette.
- directives + test-coverage: no spec rendering it on a host component and asserting host bindings/outputs (🔵).

### components-user-panel/feature/feature-user-panel-dialog/feature-user-panel-dialog.component.ts (+ .html)

- feature-component: folder/file are not `feature-<segment>/feature-<segment>.component.*`, class is `UserPanelDialogComponent` (should be `FeatureUserPanelDialogComponent`), selector `user-panel-dialog` misses the app prefix and the `feature-` segment.
- component: no `changeDetection: ChangeDetectionStrategy.OnPush`; no `.scss` file and no `styleUrl`.
- feature-component + architecture: the facade is provided in `@Component.providers` — the facade, reducer and effects are provided on the route.
- feature-component + architecture: the store is injected and `store.dispatch(...)` called; the dialog result must be handed back through a facade method.
- feature-component: the dialog closes by removing the overlay from the DOM (`document.querySelector('.cdk-overlay-pane')?.remove()`) instead of through the injected dialog ref.
- feature-component + performance: dialog-local UI state kept in plain mutable fields (`isConfirmed`, `result`) instead of `signal()`s — and both are bound in the template.
- component: members are public and unprefixed; no `dataTestPrefix`; no `readonly`.
- component-template: `(click)="isConfirmed = false"` assigns state in the template; `<button>` without `type`; no `data-test` attributes.
- i18n: hard-coded texts (`Remove this user permanently?`, `Yes`, `No`).
- accessibility 1.3.1 / 4.1.2 / 2.1.2: the dialog has no `role="dialog"`/`aria-modal`, no accessible name, no focus management and no Escape handling.
- accessibility 3.3.4: `Yes` commits an irreversible removal with no review or undo step beyond the label.
- test-coverage: no spec (🔵).

### components-user-panel/ui/index.ts

- architecture: barrel `index.ts` in a components folder is forbidden (also enables the `@defer` barrel-import defect and the effects→component import).

### components-user-panel/ui/ui-user-card/ui-user-card.component.ts

- ui-component: class `UserCardComponent` (should be `UiUserCardComponent`), selector `user-card` (missing app prefix + `ui-` segment).
- component: the template uses the `translate` pipe but `imports` lists only `NgOptimizedImage` and `ReactiveFormsModule` — the missing entry breaks the template at runtime (🔴, and the strongest finding in this file).
- component: template-read members (`highlighted`, `form`, `isExpanded`, `index`) are public instead of `protected`.
- best-practices: `isExpanded` is a writable `signal()` published on the public surface — expose `asReadonly()`/`computed()`.
- best-practices: `expandedRows = model<number>(0)` — no parent binds it with `[(expandedRows)]`, so it is just a writable signal on the public API; one-way data plus a notification stays `input()` + `output()`.
- best-practices: `onSelect = output<CardUser>()` carries the forbidden `on` prefix and is not past tense; `change = output<void>()` reuses a native DOM event name, making the native bubbling event and the output indistinguishable at the call site.
- best-practices: `ngOnChanges` in a component with signal inputs — reacting to an input is `computed()`/`linkedSignal()`/`effect()`, never the string-keyed `SimpleChanges` bag.
- ui-component: facade injected + `loadUsers` called, Router injected + navigation — a presentational component must only render inputs and emit outputs.
- ui-component/models: local duplicate model (`CardUser`) instead of a `models/` type.
- component: input the template cannot render without is plain `input<CardUser>()` (with `!` assertions later) instead of `input.required`.
- best-practices: `@Input() set` accessor (`highlight`); output as a bare `EventEmitter` field instead of `output()`.
- performance: mutable field bound in the template (`highlighted`) — stale under OnPush.
- component: form not `_fb.nonNullable.group`, control without explicit generic; fields not `readonly`; member order broken (an `@Input()` setter between signal inputs and outputs).
- ui-component: `valueChanges` subscription in the constructor without `takeUntilDestroyed`, `debounceTime` (central config) or `distinctUntilChanged` — emits on every keystroke and leaks; the constructor is also supposed to hold `effect()` calls only.
- general: `as never` cast on the emitted value (also emits the form value typed as `CardUser` — wrong contract).
- component: `effect()` patching the form without `{ emitEvent: false }` — feedback loop with the subscription.
- ui-component: no `dataTestPrefix`; no form-reference tracking decorator though the form feeds a parent.
- ui-component: `removeTag` mutates the `input()` value in place (`user()!.tags = ...`) — a presentational child rewriting the parent's data instead of emitting an output.
- test-coverage: `openDetails`/`highlight`/`ngOnChanges` behaviors untested (spec below tests almost nothing).

### components-user-panel/ui/ui-user-card/ui-user-card.component.html

- accessibility 2.1.1: `(click)` on the root `<div class="card">` — no `role`, no `tabindex`, no keyboard handler, and it wraps every other control in the card.
- accessibility 1.1.1: neither `<img>` has an `alt` (avatar and fallback).
- component-template: `ngSrc` without `width`+`height` (performance: layout shift).
- component-template: hard-coded color in `[style.color]="'#3f51b5'"` (also a literal binding).
- component-template: `@for ... track tag` — reference identity on an object collection.
- component-template: the `@for` over `user()?.tags` has no `@empty` block, so a user without tags renders as blank space.
- component-template: no `@let` at the top although `user()` is read seven times.
- component-template + security-adjacent: HTML-bearing translation (`termsHtml`) rendered via interpolation instead of `[innerHTML]` (shows escaped `<b>` tags).
- component-template: `(click)="selected.emit(user()!)"` — an `emit(...)` composed in the template instead of one call to a class handler.
- component-template: hard-coded `Select user` text; `<button>` without `type`; no `data-test` attributes.
- ui-component: `[disabled]` bound on a reactive control instead of `effect(() => form.disable({ emitEvent: false }))`.
- accessibility 3.3.2: the note `<input>` has no label of any kind.
- accessibility 2.1.1 / 4.1.2: the tag remove `<button class="tag__remove">×</button>` sits inside the card-wide `(click)` handler, so activating it also opens the details view; its accessible name is the character `×`.
- accessibility 1.3.1: `NEW` is rendered as a bare styled `<span class="card__new-badge">` — the status it announces exists only as visual decoration.
- i18n: hard-coded `Rotate your device to see the card` text (the orientation lock it belongs to is a styles finding, see below).

### components-user-panel/ui/ui-user-card/ui-user-card.component.scss

- component-styles: hard-coded colors (`#3f51b5`, `rgb(66,66,66)`, `#ff0000`) instead of theme custom properties; no dark-mode counterparts.
- component-styles: class names not BEM with the component root block (`.card`, `.btnPrimary`, `.red-text`).
- component-styles: bare `::ng-deep` not wrapped in `:host`.
- component-styles: repeated magic number `13px` (no SCSS variable, no theme `@use`).
- component-styles: redundant `display: block` on an already-block element; `.red-text` duplicates a utility class.
- code-quality: `.btnPrimary` and `.red-text` are selectors the card template does not contain — dead rules.
- accessibility 1.4.3 / 1.4.11: `.card__meta` is `#b0b0b0` on `#ffffff` (~2.3:1) at 11px, and `.tag__remove` is bordered `#e8e8e8` on white (~1.1:1, under the 3:1 a control boundary needs).
- accessibility 2.5.8: `.tag__remove` is 16×16 CSS px — under the 24×24 minimum, with no spacing exception.
- accessibility 1.4.4 / 1.4.12: `.card__bio` is a 32px fixed-height box with `line-height: 1` and `overflow: hidden` around user text — the bio is cut off as soon as text size or line spacing grows.
- accessibility 2.4.7: `.card *:focus { outline: none; }` removes the focus ring from every control in the card with no `:focus-visible` replacement.
- accessibility 2.3.1: `.card__new-badge` runs `animation: blink 0.2s infinite` — five flashes per second, above the three-per-second threshold, and nothing in the file honours `prefers-reduced-motion`.
- accessibility 1.3.4: `@media (orientation: portrait) { .card { display: none } }` (plus the rotate hint it reveals) locks the content to landscape.
- accessibility 1.4.10: `.card { width: 980px; }` — a fixed pixel width forces two-dimensional scrolling at 320 CSS px / 400% zoom.
- accessibility 1.3.2 / 2.4.3: `.card__actions { flex-direction: row-reverse; }` shows `Select` before `Details` while the DOM (and the tab order) keeps the opposite order.

### components-user-panel/ui/ui-user-card/tests/ui-user-card.component.spec.ts

- component-test: DOM assertions via `fixture.debugElement.query(By.css(...))` (markup belongs to snapshots/e2e).
- component-test: facade mock cast `as unknown as UserPanelFacade` instead of `Partial<Facade>` with real `signal(...)` values; signal mocked as `jest.fn`.
- component-test: TestBed + `beforeEach` fixture instead of `MockBuilder`/`ngMocks.faster()` + one shared `MockRender` in `beforeAll`.
- unit-tests: SCREAMING_SNAKE fixture (`MOCK_USERS`); injected-dependency variable named `svc`; existence-only `should create` test; `it.each` dataset inline, unused in assertions (test asserts nothing per-case); `it`/`it.each` descriptions not starting with `should` (`'renders the card'`, `'renders %s %s'`, `'opens details'`, `'collapses the card'`, `'emits the note'`).
- general + unit-tests: `it.only('emits the note')` — a committed focused test silently reduces the suite to one case (🔴 High).
- component + unit-tests: `component['isExpanded']` reaches a member through string-index access to work around visibility.
- unit-tests: `'collapses the card'` calls `setInput(...)` and asserts without flushing change detection (`fixture.detectChanges()`/`TestBed.tick()`), so it reads the pre-effect state.
- component-test: bare `toHaveBeenCalled()` without arguments; no `afterEach` (`jest.clearAllMocks`, signal resets).
- component-test: `it('opens details')` calls `component.openDetails()` without ever setting the `user` input, so `this.user()!.id` dereferences `undefined` and the test throws `TypeError` (🔴 — the spec is broken, not merely weak). A signal `input()` is written with `MockRender(C, { user })` or `fixture.componentRef.setInput(...)`, never by property assignment.
- unit-tests: the spec is zone-based although `app.config.ts` provides `provideZonelessChangeDetection()`.
- component-test (absences): no `dataTestPrefix` test, no form/validator tests, no state→form `{ emitEvent: false }` guard test, no output-emission tests.

### src/index.html

The only non-Angular markup file in the environment: no local instruction matches it, so it is reviewed
against the globals its path puts it in scope of — every one of them except `test-coverage`, which
narrows itself to `**/*.ts`. The accessibility findings here prove that instruction still reaches a file
no local checklist covers.

- accessibility 3.1.1: `<html>` carries no `lang`, so assistive technology guesses the language of the whole app.
- accessibility 1.4.4: the viewport meta sets `maximum-scale=1, user-scalable=no` — pinch zoom is blocked and text cannot be enlarged to 200%.
- accessibility 2.4.2: `<title>App</title>` identifies nothing (and no route sets a `title` either — see the routes file).
- accessibility 2.4.1: no skip link and no landmarks — header and nav are `<div>`s, so a keyboard user has no way to bypass them.
- accessibility 2.1.1 / 4.1.2: `<div class="app-nav" onclick="…">` and `<span class="cookie-accept" onclick="acceptCookies()">` are links and a button rebuilt from non-interactive elements — not focusable, no role, no keyboard activation, no accessible name beyond their text.
- accessibility 2.4.11: the cookie bar is `position: fixed; bottom: 0; height: 64px` with no `scroll-padding-bottom` — it covers whatever the user tabs to at the bottom of the page.
- accessibility 2.5.8: the cookie accept control is 18×18 CSS px, under the 24×24 minimum.
- accessibility 1.4.3: cookie-bar text is `#a8a8a8` on white (~2.5:1).
- general: in-app navigation through `window.location.href` (here in a raw inline `onclick`, so it escapes the router and the SPA boundary entirely); hard-coded user-facing texts.
- code-quality: the two `app-nav` divs are the same construct copy-pasted with a different label and href.

### src/assets/i18n/en.json

- i18n: same phrase under two keys (`actions.save` = `page.userPanel.actions.saveUser` = "Save"; `labels.userName` = `page.userPanel.labels.user_name_label`).
- i18n: new top-level per-component section (`userCard`) — `<area>` must be a page/module.
- i18n: leaf not camelCase (`user_name_label`); abbreviated leaf with wrong suffix (`selectBtn`); label value with a trailing period (`"Select user."`).
- i18n: `panelHeading` value not in Title Case for a `…Heading` key.
- i18n: validation message (`requiredEmail`) outside `validationMessages`.
- i18n: `greeting` declares `{{userName}}` but the code never resolves it with params (concatenation in TS instead).
- i18n + code-quality: the feature template asks for `page.userPanel.labels.userNameLabel`, which does not exist here —
  the key was renamed without checking its consumers.
- code-quality: `actions.save`, `userCard.selectBtn`, `labels.userName`, `page.userPanel.labels.requiredEmail` and
  `page.userPanel.actions.saveUser` are resolved by nothing in the repo — dead i18n keys.

### src/assets/i18n/pl.json

- i18n: non-base locale file edited at all (translation team owns it); English placeholder values (`"Save"`, `"User name"`).
- i18n: duplicate key (`labels.userName` twice); key existing only in Polish (`newKeyOnlyInPolish`).
- i18n: the file is not valid JSON — a trailing comma after `"newKeyOnlyInPolish"`.

### src/assets/i18n/tests/en.json.spec.ts

- i18n: i18n entries have no unit tests.
- unit-tests: the snapshot has no `tests/__snapshots__/` counterpart; the test asserts the whole translation file, so
  every new key breaks it.

### src/app/layout/data-access/+state/layout.actions.ts

No findings — this file is deliberately compliant (see the bait list). It exists so the cross-area *import* violations
in `user-panel.effects.ts` and `feature-user-panel.component.ts` have a real target.

## Cross-file findings the review should also produce

- Naming drift: `userStatusLabel` (models fn) vs `mapStatusToLabel` (util) vs `UserStatusPipeClass` (pipe) vs `buildResultLabel` (effects method) vs `formatUserName`/`formatUserRow` (utils) re-implement overlapping formatting; the `firstName + ' ' + last_name` join is inlined in the reducer, a selector, three utils and the template (define once, reuse).
- One concept, five types: `UserDto` and `UserVm` (models), `CardUser` (`ui-user-card.component.ts`), `HelperUser` (`user-panel.helpers.ts`) and `UserTableDragSourceData` (`user-table.type.ts`) all describe a user with different fields and different casing conventions — the area should carry exactly two (`UserDto` for the API contract, one domain model).
- The result label is computed twice with the same rule: `buildResultLabel` in the effects and the `switch` inside the reducer's `searchUsersSuccess` handler.
- Layer inversion loop: effects → ui barrel → component → facade → service, while the guard, the directive and the feature component also reach the service directly, and the interceptor dispatches back into the store.
- Two parallel state mechanisms for the same data: the NgRx slice and `UserPanelUiStateService`'s `BehaviorSubject`s (`selectedUser`, `isOverlayOpen` also live as component fields).
- `filteredUsers` flows action → reducer → state although it is derivable — action, state field and dispatching component should all be findings under their own instructions.
- The area registers state in `shared/routes` providers, ALSO in the root `provideStore` of `app.config.ts` and again in `app.config.server.ts`, has a parallel `shell` routing variant, an NgModule, and three forbidden barrels — canonical layout broken at area and app level.
- Configuration values are declared three times: `API_BASE_URL`/`POLL_INTERVAL_MS`/`SEARCH_DEBOUNCE_MS` in `app.config.ts`, the absolute URL again in `user-panel.service.ts`, and the interval again as the literal `5000` in `user-panel.effects.ts`.
- Missing specs across the diff (🔵): feature component, dialog component, directive, interceptor, pipe, `user-panel-ui-state.service.ts`, `build-user-summary.util.ts`, `map-user-dto.util.ts`, `format-user-name.utils.ts`; changed behaviors without matching spec cases in the existing reducer/selectors/effects/facade/ui specs.
- Specs that must not exist at all: the HTTP-wrapper service spec, the routes spec, the models enum spec and the i18n snapshot spec.
- Three focused/skipped markers reach the diff at once (`fdescribe` in the guard spec, `xit` in the reducer spec, `it.only` in the card spec) — each is its own 🔴 High finding.
- Every spec in the diff runs zone-based while `app.config.ts` provides `provideZonelessChangeDetection()` — the whole suite passes on zone.js' automatic ticks and hides the missing signal writes.
- Accessibility repeats across layers: the focus ring is removed in both the feature component's inline `styles` and the card `.scss`, both files fix a pixel width that cannot reflow, and `(click)` handlers sit on non-interactive elements in `index.html`, the feature template and the card template — each file carries its own finding, all of them 🟡 Medium, and none of them may also appear under `component-template`/`component-styles`.
- The same navigation is rendered twice with different markup and different order — `index.html` (`Users`, `Reports`) and the feature template (`Reports`, `Users`) — which is both a consistency finding (3.2.3) and duplicated markup that belongs in one shared component.
- Accessibility findings must never be escalated or softened: the sanitizer bypass next to them in the feature template stays 🟤 Critical (security), while the `aria-hidden` around a focusable button, the 16px targets and the blocked paste in the password field stay 🟡 Medium.

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
