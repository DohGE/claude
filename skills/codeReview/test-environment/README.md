# codeReview test environment — answer key

A fake Angular/NgRx feature area (`user-panel`) in which nearly every file deliberately violates the
checklists in `skills/codeReview/instructions`. It exists to stress-test the `/codeReview` skill:
run a review over these files and diff the report against the inventory below.

The code is not meant to compile — it only has to be realistic enough to review.

Accessibility entries below are labelled `accessibility:` and carry the WCAG 2.2 success criterion they
break (`instructions/global/accessibility.md`); every one of them must be reported as 🟡 **Medium**, and
none of them may be reported twice under the component-template or component-styles instructions.

## How to run a review over it

The files must appear in a git diff to be reviewed:

- `git add skills/codeReview/test-environment` → `/codeReview staged`, or
- commit them on a branch → `/codeReview` (branch vs base).

Caveat: this README is part of the same diff and is effectively the answer key.
A reviewer that merely parrots it will betray itself through missing real line numbers
and rule references — but for a clean experiment, commit the README separately.

## Deliberately compliant spots (false-positive bait)

- `ui-user-card.component.ts` sets `ChangeDetectionStrategy.OnPush` and has separate `.html`/`.scss` files.
- `user-panel.actions.ts` imports `UserDto` through the models barrel (correct import direction).
- All four `+state` specs and the util spec live in `tests/` folders (correct location).
- `user-panel.effects.ts` class name `UserPanelEffects` and the `searchUsersFail` → `of(fail)` inside `catchError` inside `mergeMap` in `searchUsers$` (correct catchError placement there).
- The `should be created` / `should be defined` / `should create` descriptions in the service, routes, util and ui-card specs comply with the `should`-prefix naming rule — those tests are flagged as existence-only, not for their names.
- `ui-user-card.component.ts` declaring an input named `title` (colliding with the native HTML attribute) is not itself a violation — only the parent template's plain-attribute binding of it is.
- `build-user-table.util.ts` exporting two related user-table functions from one file is NOT a violation (`utils.md`: "never report a cohesive multi-function util file"). What IS a violation there is `formatUserRow` being a pass-through wrapper over `deepClone`.
- The endpoint path text in `user-panel.service.ts` — segments, wording, casing, versioning, leading/trailing slash, key names — is out of review scope entirely. Only the absolute base URL inside the value is reportable.
- `feature-user-panel.component.html`: the third action button carries `aria-label="Save changes and close the panel"` over the visible text `Save changes` — the accessible name CONTAINS the visible label, so 2.5.3 Label in Name is satisfied (bait sitting right next to the button that really breaks it).
- `feature-user-panel.component.html`: `tabindex="-1"` on the overlay container is NOT a violation — only positive `tabindex` values are (the overlay's real defects are its missing focus management, listed below).
- `ui-user-card.component.html`: `<h3>` for the user name inside a card is a plausible heading level for a card — the heading-order violations live in the feature template, not here.

## Violation inventory (per file)

### models/interfaces/user-panel-state.interface.ts

- state-interface: `?` optional fields instead of `| null` (`users?`, `selectedUser?`, `dialogResult?`, `lastError?`).
- state-interface: `readonly` on a state field (`selectedUser`).
- state-interface: derived fields in state (`filteredUsers`, `userCount`, `hasAnyErrors` — all computable from `users`).
- state-interface: function field in the state interface (`formatDisplayName`).
- state-interface + models: field types imported through the area's own barrel (`from '../index'`) — cycle risk.
- ngrx-actions (design leak): `dialogResult` parked in state only to pass a dialog result along.

### models/consts/user-panel-initial-state.const.ts

- models: two consts in one file (feature key + initial state).
- models: feature key value has no spaces / not descriptive (`'userPanel'`).
- general: SCREAMING_SNAKE_CASE const name (`USER_PANEL_INITIAL_STATE`).
- state-interface: initial state typed via `as` cast instead of explicit `: UserPanelState` annotation (compiler no longer enforces completeness).
- state-interface: incomplete vs the interface (missing `selectedUser`, `hasAnyErrors`, `formatDisplayName`, `lastError`); extra fields not in the interface (`createdAt`, `nested`).
- state-interface: loading flag initialized to `null` instead of `false`; `users: undefined`.
- models: logic inside a const (IIFE computing `createdAt`); nested object as `{}`.
- models: state type imported through the barrel instead of a concrete path.

### models/interfaces/user-dto.interface.ts

- models: helper interface used only internally but exported (`ApiEnvelope`).
- models: `Dto` vocabulary in the type and file name (`UserDto`, `user-dto.interface.ts`) — every consumer inherits it.
- models: DTO with mixed camelCase/snake_case fields (`firstName` vs `last_name`) — API contract is snake_case.
- models: domain/UI type with snake_case fields (`UserVm`).
- general: type access through string index (`UserDto['user_status']`).
- models: several main exports in one file.

### models/types/user-table.type.ts

- models: plain extensible object declared as `type` instead of `interface` (`UserTableRow`).
- models: incomplete table set — no `...DisplayedColumns` enum, no `SourceData`/`Cell` interfaces.
- models: `...DisplayedColumnsLabels` enum values are texts, not i18n keys, and values ≠ keys.

### models/consts/user-role-options.const.ts

- models: local duplicate of the shared-library option interface (`SelectOption`).
- models: option `label` values are raw texts, not i18n keys.

### models/enums/user-status.enum.ts

- models: numeric enum (`UserStatus`) — enums must be string enums with values equal to the API strings.
- models: `UserRole` keys in SCREAMING_SNAKE_CASE and values that are UI texts, not API strings.
- models: function (`userStatusLabel`) inside a models file — model files are purely declarative; it also returns hardcoded UI texts instead of i18n keys.
- models: two enums plus a function — several main exports in one file.

### models/index.ts

- models: barrel missing the fixed commented sections in order (`// consts`, `// enums`, `// interfaces`, `// types`).
- models: barrel does not list every model file (consts and enums files missing).
- models: declaration inside the barrel (`export const modelsVersion = 2`).

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
- general: narrating comment (`// set the loading flag to true`); commented-out handler code.
- ngrx-reducer: impure `Date.now()` in a handler (`refreshedAt`).
- ngrx-reducer: blind append on `loadUsersSuccess` (duplicates seeded items in edit mode — no upsert by id).
- ngrx-reducer: derived value stored in state (`userCount`); extra fields not in the interface (`refreshedAt`, `resultLabel`, `selectedUserName`).
- ngrx-reducer: default selection `selectedUser: data[0]` — no `state.selectedX ?? list[0] ?? null` chain, overwrites the edit-mode choice, `undefined` when empty.
- ngrx-reducer: missing fail handler for `Load users` → `isLoading` stuck `true` on error.
- ngrx-reducer: `searchUsers` start handler does not clear previous results → stale UI while reloading.
- ngrx-reducer: identical handlers not merged (`searchUsers` and `fetchUserDetails` both only set `isLoading: true`).
- ngrx-reducer: inline `for` loop mapping + inline id concatenation (`firstName + '-' + last_name`) + `switch` mapping inside the reducer — belongs in utils/mappers.
- general/i18n: hard-coded user-facing texts in the reducer (`'No results'`, `' results'`).
- ngrx-reducer: `state.selectedUser.firstName` without a null guard (no `if (!state.x) return state;`).
- ngrx-reducer: `clearUsers` spreads the whole initial state for a partial reset instead of listing cleared fields.
- ngrx-reducer: forbidden import of the selectors file (unused too).

### data-access/+state/user-panel.selectors.ts

- ngrx-selectors: feature selector exported (must be local, non-exported); feature key as inline magic string.
- ngrx-selectors: selector named without the `select` prefix (`getUsers`) and exported directly outside a query object.
- ngrx-selectors: plain arrow function selector bypassing memoization (`selectUserCount`).
- ngrx-selectors: impure selector — `console.log` + `Date.now()` (`selectSelectedUserName`).
- ngrx-selectors: `state.selectedUser.firstName` throws on null — no `?.`/`?? null`, return type not widened.
- ngrx-selectors: `selectSortedUsers` mutates its input (`Array.prototype.sort` in place).
- ngrx-selectors: derived selectors read the raw feature state instead of composing selectors; projector args/returns untyped.
- ngrx-selectors: wizard gate misnamed (`selectNextStepAllowed`, not `selectCanGoToNextStep<Step>`), composed from raw state instead of flag selectors.
- ngrx-selectors: parameterized selector for a value obtainable by composition (`selectUserById`).
- ngrx-selectors: UI-data selector builds the table inline instead of delegating to a shared `form*`/`generate*` util; duplicated literal (`['name', 'status']` twice).
- ngrx-selectors: query object misnamed and PascalCase (`UserPanelSelectors` instead of `userPanelQuery`).
- ngrx-selectors: `selectOrphan` belongs to no query object — dead code.
- ngrx-selectors: forbidden import of the actions file.

### data-access/+state/user-panel.effects.ts

- ngrx-effects + architecture: `@Injectable({ providedIn: 'root' })` on an effects class.
- ngrx-effects: dependency fields not `private readonly _camelCase`; `svc` is a shortened generic name; action stream named `actions` (not `_actions$`); effect `loadUsers`/`logLoadedUsers` missing the `$` suffix.
- ngrx-effects: forbidden facade injection; `store.dispatch(...)` inside the class; manual `subscribe()` in the constructor.
- ngrx-effects: `loadUsers` — `catchError` OUTSIDE `switchMap` (first error kills the stream) and swallowed via `EMPTY` (general: errors never swallowed; no fail action exists).
- ngrx-effects: `withLatestFrom` instead of `concatLatestFrom`.
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2 — import from `rxjs`).
- ngrx-effects: truthiness state guard (`!!users.length`) where `0` is a valid value.
- ngrx-effects: `mergeMap` for a search (races/out-of-order results — should be `switchMap`).
- ngrx-effects: `tap` mutates the action payload and runs domain logic (`buildResultLabel`).
- ngrx-effects: `Date.now()` in a success payload (+ `as any` to smuggle it).
- ngrx-effects: `logLoadedUsers` has no `{ dispatch: false }` — re-emits `loadUsersSuccess` into the stream (infinite loop).
- security: token read from `localStorage` and logged (`console.log`); response data persisted to `localStorage` (PII in storage + leftover debug logging).
- ngrx-effects: polling with hard-coded `timer(0, 5000)` — interval not from central config, no `_stop$`/`takeUntil`, no stop effect (performance: unbounded async work), and no `ofType`/`filter` narrowing.
- ngrx-effects: dialog opened without the three generics; `afterClosed()` without a cancel `filter` — cancellation dispatches `dialogResult: undefined`; cast (`result as string`) instead of a type predicate.
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
- http-service: local interface declared in the service (`SearchResponse`).
- http-service: `@Injectable()` without `providedIn: 'root'` (inverse of the facade rule).
- http-service + best-practices: constructor injection in a new service; store injected into an HTTP service.
- http-service: `Observable<any>` (+ `get<any>`) — no honest response generic; `pageSize ?? 25` instead of a default parameter value.
- http-service: `.pipe(map, catchError, tap)` inside the service — mapping/error handling belong to reducer/effects; `catchError(() => of([]))` swallows failures (general); `tap` + `console.log` logging.
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2 — import from `rxjs`).
- http-service: method names `getUsers`/`deleteUser` instead of `loadUsers`/`removeUser`; `firstValueFrom` forbidden.
- security: user email as a query param (`?email=` — PII in URL).
- models: `UserDto` imported by concrete path from outside `models/` (must go through the barrel).
- http-service: a spec exists for a pure HTTP wrapper (see below) — forbidden.

### data-access/services/user-panel.service.spec.ts

- unit-tests: spec next to the code instead of a sibling `tests/` folder.
- unit-tests: existence-only test (`toBeDefined`); `{} as unknown as X` double cast.
- http-service: pure HTTP wrapper must have no spec at all.

### data-access/+state/tests/user-panel.reducer.spec.ts

- ngrx-reducer-test: TestBed + `provideMockStore` in a reducer spec (no TestBed, no mocks allowed).
- ngrx-reducer-test: shared `STATE` referencing the exported const directly — inputs must be fresh spreads per test; `{} as UserPanelState` used as input.
- unit-tests: SCREAMING_SNAKE test const (`STATE`).
- unit-tests: no `it` description starts with `should` (`'sets loading on load users'`, `'stores users on success'`, `'stores search results'`).
- ngrx-reducer-test: single-field assertions (`state.isLoading`, `users.length`) instead of whole-state `toEqual({ ...initialState, ... })`.
- ngrx-reducer-test: no `it.each` success/fail loading-reset dataset; no fail-action test at all.
- ngrx-reducer-test: incomplete fixture `{ id: '1' } as UserDto` where the handler reads fields.
- ngrx-reducer-test (absences): no anti-duplication upsert test, no null-guard no-op test, no reset-lists-fields test, no edit-mode seeding tests, no default-selection fallback tests.
- test-coverage: branches of `searchUsersSuccess` (`switch` 0/default) and `setConfirmationDialogResult` untested.

### data-access/+state/tests/user-panel.selectors.spec.ts

- ngrx-selectors-test: MockStore + `store.select` instead of `.projector(...)` (no TestBed/MockStore allowed).
- ngrx-selectors-test: pass-through selector tested (`getUsers`).
- ngrx-selectors-test: derived selector fed a full state object instead of its input selectors' outputs (`selectNextStepAllowed.projector({...state})`).
- ngrx-selectors-test: boolean selector has only the `true` case; gate selector lacks one false-test per AND clause.
- ngrx-selectors-test: `toEqual` asserting a passed-through reference where `toBe` is required (`selectSortedUsers`).
- unit-tests: no `it` description starts with `should` (`'selects users'`, `'allows next step'`, `'builds table data'`, `'sorted users returns the same list'`).
- ngrx-selectors-test (absences): no edit-mode safety test, no parameterized-selector two-step test (`selectUserById`).

### data-access/+state/tests/user-panel.effects.spec.ts

- ngrx-effects-test: `actions$` assigned eagerly at module level with `of(...)` — must be a lazily reassigned-per-`it` variable.
- ngrx-effects-test: HTTP simulated with `of()` instead of per-endpoint `Subject`s.
- ngrx-effects-test: service mock typed with `as unknown as UserPanelService` instead of `satisfies Partial<...>`; variable named `svc` (unit-tests: full descriptive names).
- unit-tests: the only `it` description (`'loads users'`) does not start with `should`.
- ngrx-effects-test: `fakeAsync`/`tick` instead of the `(done)` callback + `pipe(take(1))`.
- ngrx-effects-test: bare `toHaveBeenCalled()` — payload not asserted.
- ngrx-effects-test: no `afterEach` (`jest.clearAllMocks`, `resetSelectors`); no `ngMocks.faster()`; setup in `beforeEach` not `beforeAll`.
- ngrx-effects-test (absences): no error test for any HTTP effect, only one of six effects tested, no non-emission `filter` tests, no `{ dispatch: false }`/`tap` side-effect tests, no dialog-cancel test.

### data-access/+state/tests/user-panel.facade.spec.ts

- ngrx-facade-test: TestBed instead of `MockBuilder(Facade).mock(Store, storeMock)`; store mock cast with `as unknown as Store` instead of `Partial<Store>`.
- ngrx-facade-test: nested `describe`s for a proxy class (must be flat `it`s).
- ngrx-facade-test: bare `toHaveBeenCalled()` instead of `toHaveBeenCalledWith(actions.x({ ...payload }))`.
- ngrx-facade-test: signals tested (`facade.list()`); `expect.objectContaining` used.
- unit-tests: `it` descriptions do not start with `should` (`'dispatches'`, `'exposes the user list'`).
- ngrx-facade-test: no `afterEach` with `jest.clearAllMocks()`; no null-parameter variant tests; `searchAndReturn` untested.

### shared/guards/user-panel.guard.ts

- guards: class guard implementing `CanActivate` instead of a functional `const <predicate>Guard: CanActivateFn`; file name is not a predicate.
- guards: injects the store and an HTTP service (facades only); fires an HTTP request from a guard.
- guards: navigation target as magic string (`'/users/step-2'`) instead of the step enum; side effect through Router instead of the layout facade.
- guards: returns `Observable<boolean>` instead of reading facade signals and returning `boolean`.
- best-practices: constructor DI instead of `inject()` in the guard body.
- guards + test-coverage: no spec in a sibling `tests/` folder (🔵).

### shared/utils/build-user-table.util.ts

- utils: export is a `const` arrow function and a `default` export (must be a named `export function`); missing explicit return types. (Grouping two related functions in one file is NOT the violation — see the bait list.)
- code-quality: `formatUserRow` only forwards to `deepClone` — a wrapper that adds no behavior.
- utils: impure — `Math.random()` inline id, `Date.now()`, and in-place `sort` mutating the argument.
- utils: `displayedColumns` hard-coded instead of `Object.values(<ColumnsEnum>)`; labels are texts, not i18n keys; rows lack an explicit row type; id not from the shared ID-generator util.
- security: new third-party dependency (`tiny-clone-x`) introduced silently.

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

- architecture: a barrel `index.ts` in `shared/` is forbidden outright — `models/` is the only folder allowed to have one; every export here (guard and both utils) must be imported from its concrete file.
- utils: the two util re-exports additionally break the utils rule that utils are never reached through a barrel.

### shared/routes/user-panel.routes.ts

- routes: export named `routes` and untyped (must be `userPanelRoutes: Routes`).
- routes + best-practices: eager `component:` import of the feature component instead of `loadComponent`.
- routes: simple-page variant carries `providers` (`provideState`/`provideEffects`/facade) and `canActivate` — must be thin and stateless.
- routes: no `title` on a user-navigable route.
- routes: helper function (`buildPath`) — no logic allowed in a routes file; it also returns `'/'` for an empty segment, so the route `path` is `'/'` instead of `''` and never matches.
- routes: `provideState('userPanel', reducer)` registers the slice under a magic string instead of the exported `userPanelFeatureKey` — it can drift from the key the feature selector uses.
- routes: no `withComponentInputBinding()` anywhere in the routing setup, so the feature component has no way to receive route params as `input()`s (it falls back to reading `location.search` by hand).
- architecture: area has BOTH `shared/routes/` and `shell/` (either, never both).

### shared/routes/tests/user-panel.routes.spec.ts

- routes: route files must have no unit specs.
- unit-tests: existence-only test.

### shell/user-panel-shell.routes.ts

- routes: wizard variant with magic-string step paths (not the step enum), no `canActivate` guards (initialization + previous-step), no titles.
- routes: export has no `: Routes` type annotation, so route definitions are not type-checked.
- code-quality: both steps load the exact same component with the same dynamic import — a copy-pasted route entry.
- architecture: duplicate routing variant for the area (see above).

### user-panel.module.ts

- best-practices: new `NgModule` (standalone only).
- architecture: file outside every dedicated location (area root).

### components-user-panel/feature/feature-user-panel/feature-user-panel.component.ts

- feature-component: class `UserPanelComponent` (should be `FeatureUserPanelComponent`), selector `user-panel` (missing app prefix + `feature-` segment).
- component: no `changeDetection: ChangeDetectionStrategy.OnPush`.
- component: inline `styles: [...]` — no own `.scss` file; hard-coded color in it (component-styles).
- general: import order scrambled (relative first, framework last).
- component: `imports` array not matching the template — `NgOptimizedImage` unused, `ReactiveFormsModule` missing though `[formControl]` is used in the template.
- component: `CommonModule` in `imports` — the native control flow and `[class.x]`/`[style.x]` bindings replace it.
- component: every member is public — template-only members must be `protected`, internals (`destroy$`, `sub`, `usersBackup`) `private`.
- best-practices: explicit `standalone: true`; `@Input()`/`@Output()` decorators with `!` definite assignment and `EventEmitter<any>` instead of `input.required`/`output()`.
- feature-component + architecture: store injected + `store.dispatch`, actions/selectors imported, HTTP service injected and called — components may talk only to the facade.
- component: injected fields public and unprefixed (`facade`, `store`, `svc` — generic name), not `private readonly _...`.
- component: `dataTestPrefix` equals the selector (must be a stable descriptive name).
- general/i18n: hard-coded user-facing strings (`title`, template texts).
- performance: mutable class fields bound in the template (`title`, `resultCount`, `showTooltip`, `isOverlayOpen`, `activeTab`, `toastMessage`, `bannerIndex`, `banners`); `resultCount` mutated in `ngDoCheck` every CD cycle; `ngDoCheck` itself forbidden.
- general: string-index type access (`UserPanelState['users']`).
- performance/SSR + component: `location.search`/`window`/`document` in field initializers, constructor and `ngOnInit` (browser work belongs in `afterNextRender`).
- feature-component: `computed()` wrapping a facade signal (`filtered`) and `pipe(map(...))` on a facade stream (`userNames$`) — derived state belongs in a selector (historically under-reported rule).
- performance: `httpResource` read via `.value()` without `hasValue()` guard (in `onSave`); resource params read a non-signal `@Input`.
- component: manual `Subject`/`Subscription` cleanup pattern + `ngOnDestroy` (must be `takeUntilDestroyed`/`DestroyRef`); `destroy$` never `.complete()`d; inner subscription in `valueChanges` never cleaned (leak).
- performance: `toSignal()` inside a getter — new subscription per read.
- component: constructor does loads/dispatches and logging (only `effect()` allowed); `effect()` writes state (`resultCount`) and patches the form without `{ emitEvent: false }` (feedback loop with the `valueChanges` subscription).
- best-practices: `inject()` inside a method (`onSave`) — NG0203 runtime error.
- feature-component: route/query params read by hand via `URLSearchParams(location.search)` instead of arriving as signal `input()`s bound by `withComponentInputBinding()`; edit-mode has only the id-present branch (no else), and it is a `ngOnInit` branch rather than a signal read.
- best-practices: `subscribe()` nested inside `subscribe()` (the inner stream escapes the outer `takeUntil`).
- best-practices: operators imported from `rxjs/operators` (deprecated since RxJS 7.2), and `@angular/common` imported twice.
- best-practices: `toSignal()` called without `initialValue`/`requireSync`, so the signal type silently widens with `undefined`.
- performance: hard-coded `setInterval` polling, never cleared, resubscribing a cold HTTP observable each tick.
- component: untyped form (`UntypedFormGroup`/`UntypedFormControl`) instead of `_fb.nonNullable.group` with explicit generics; `addValidators` without `updateValueAndValidity()`; `valueChanges` without `distinctUntilChanged(isEqual)`.
- security: `setTimeout('this.refresh()', 500)` — string argument; `bypassSecurityTrustHtml(user.bio)` on API-derived data (Critical).
- feature-component: handler with business logic (`onSave` filters users, dispatches, calls HTTP `deleteUser` with a floating promise); `saved.emit` of a double-cast payload (`as unknown as`).
- performance/template: `formatDate`/`greet` methods called from template bindings.
- best-practices: `@HostListener` instead of `host: {}`.
- i18n: greeting built by string concatenation (`buildGreeting(user) + ', ' + this.title`) instead of a translation with params.
- general: `console.log` calls; commented-out `refresh()` code block.
- component: enum alias renamed (`statuses = UserStatus` — must keep the enum name, `userStatus`); signals/aliases not `readonly`; member order broken (handlers before lifecycle, fields interleaved).
- accessibility 2.1.4: `@HostListener('document:keydown.s')` — a single-character shortcut bound to the whole document, always active, with no way to turn it off or remap it (it also steals `s` from every text field).
- accessibility 2.4.3: `document.getElementById('panel-root')?.focus()` targets a `<div>` that has no `tabindex`, so the focus move silently does nothing and the user is left at the top of the document.
- accessibility 2.2.2: the second `setInterval` rotates the promo banner every 4 s with no pause/stop/hide control (and, like the polling one, is never cleared).
- accessibility 3.2.2: `onRoleChange` navigates (`window.location.href = ...`) from the `change` event of a `<select>` — changing a setting must not change context by itself.
- accessibility 3.3.4: `deleteAccount()` and `removeUser()` call `deleteUser(...)` immediately — no confirmation, no undo for an irreversible operation.
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
- component-template: BOTH `@defer (on viewport)` blocks lack a `@placeholder` — the viewport trigger has no element to observe (the hero block and the `user-card` block).
- component-template: no `@let` at the top of the template although `users()` is read three times.
- component-template: `[(ngModel)]` template-driven binding (best-practices) mixed with reactive `[formControl]`; hard-coded placeholders.
- component-template: no `data-test` on any interactive native element despite `dataTestPrefix` — the only `data-test` in the template sits on the `<user-card>` component host tag, where it is forbidden (the selector already targets hosts).
- component-template: logic and state writes inline in the template — `facade.loadUsers({ pageSize: 25 })`, `showTooltip = true/false`, `activeTab = 'all'`, `isOverlayOpen = false`.
- general: in-app navigation as raw `<a href="/users">`/`/reports`/`/help` links instead of `routerLink` — every one of them reloads the app and discards router state.
- component-template: literal property binding `[title]="'Refresh'"` on a native `<button>` — still a defect, the input-name-collision exception covers component inputs only, not native elements (false-negative bait); facade call with logic inline in the template (`facade.loadUsers({ pageSize: 25 })`).
- component-template: `title="User details"` as a plain attribute on the `<user-card>` host — the `title` input collides with the native HTML attribute, so the binding form (`[title]="'User details'"`) is required; the plain attribute lands in the DOM and adds an unwanted browser tooltip (the value is also yet another hard-coded text — i18n).
- component-template: method calls in interpolations (`formatDate(...)`, `greet(...)`).
- security: `[innerHTML]` bound to sanitizer-bypassed API data; `target="_blank"` link without `rel="noopener noreferrer"`; `[href]="returnUrl"` straight from query params (open redirect); `[href]="user.homepage"` unvalidated API URL.
- component-template: duplicated branch markup (`Found ... users` + Export button twice) instead of `ng-template` + `ngTemplateOutlet`.
- component-template: `async` pipe (`userNames$ | async`).
- accessibility 1.1.1: hero `<img alt="hero-users.png">` — the alternative is a file name; `<img [src]="captchaUrl">` has no `alt` at all; the icon-only 🔄 button and the ✖ remove control have no accessible name; decorative inline `<svg class="logo">` is exposed instead of `aria-hidden="true"`.
- accessibility 1.3.1 / 2.4.6: heading order jumps `h1` → `h4`, and `<div class="section-title">` is a heading styled by CSS only; the two `<input type="radio" name="role">` sit outside any `fieldset`/`legend` and their labels are bare text nodes.
- accessibility 2.4.1: no landmarks and no skip link — `<div class="nav">`, `<div class="footer">` and no `<main>` anywhere in the view.
- accessibility 3.3.2 / 1.3.1: no control in the template has a label — search, email, confirm-email, password, captcha and the role `<select>` are identified by `placeholder`/`option` text only.
- accessibility 1.3.5: the search, email and confirm-email inputs declare no `autocomplete` token at all, and the password field opts out of autofill with `autocomplete="off"`.
- accessibility 1.4.1: required state is carried only by the red `<span class="req">*</span>`, and the row status only by `<span class="status-dot">` colored green/red — no text or icon equivalent (the error text is also styled through `.red-text`).
- accessibility 1.4.13: the ⓘ tooltip opens on `(mouseenter)` only — no focus trigger, no Escape dismissal, and it disappears the moment the pointer leaves, so it can never be hovered.
- accessibility 2.1.1: `(click)` on `<div class="toolbar">`, `<span class="chevron">` and the `role="tab"` divs, with no `tabindex` or keyboard handler — keyboard users cannot reach or fire them.
- accessibility 1.3.2 / 2.4.3: `tabindex="3"` on the toolbar — a positive value rewrites the focus order of the whole page.
- accessibility 2.5.7: the user list reorders through `draggable="true"` + `(dragstart)`/`(drop)` only — no button, arrow-key or select alternative.
- accessibility 2.5.2: the ✖ remove control fires on `(mousedown)`, so the action commits before the pointer is released and cannot be aborted.
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
- accessibility 1.4.2 / 1.2.2 / 1.2.5: `<video autoplay loop>` without captions or `<track>`, `<audio autoplay>` that cannot be stopped.
- accessibility 3.2.6: `Need help?` is rendered only under `*ngIf="userId"`, so the help mechanism disappears on every other entry into the panel.
- accessibility 3.2.3: the panel's own nav repeats the shell navigation in the opposite order (`Reports`, `Users` here vs `Users`, `Reports` in `index.html`).
- feature-component: rich presentation markup rendered directly in the feature (belongs in `ui-*` children); deferred `user-card` imported through the `ui` barrel `index.ts` (performance: barrel import keeps it in the main bundle).
- i18n: every user-facing text hard-coded; `page.userPanel.labels.greeting` exists in en.json but code concatenates instead.

### components-user-panel/feature/feature-user-panel/user-panel.helpers.ts

- architecture: non-`*.component.*` file next to a component (only component files + `tests/` allowed).
- architecture/models: interface (`HelperUser`) belongs in `models/`, const in `models/consts`, function in `shared/utils/`.
- general: SCREAMING_SNAKE const (`MAX_USERS`); hard-coded user-facing text built by concatenation (`'Welcome ' + user.name`) — i18n.

### components-user-panel/ui/index.ts

- architecture: barrel `index.ts` in a components folder is forbidden (also enables the `@defer` barrel-import defect and the effects→component import).

### components-user-panel/ui/ui-user-card/ui-user-card.component.ts

- ui-component: class `UserCardComponent` (should be `UiUserCardComponent`), selector `user-card` (missing app prefix + `ui-` segment).
- component: the template uses the `translate` pipe but `imports` lists only `NgOptimizedImage` and `ReactiveFormsModule` — the missing entry breaks the template at runtime (🔴, and the strongest finding in this file).
- component: template-read members (`highlighted`, `form`) are public instead of `protected`.
- ui-component: facade injected + `loadUsers` called, Router injected + navigation — a presentational component must only render inputs and emit outputs.
- ui-component/models: local duplicate model (`CardUser`) instead of a `models/` type.
- component: input the template cannot render without is plain `input<CardUser>()` (with `!` assertions later) instead of `input.required`.
- best-practices: `@Input() set` accessor (`highlight`); output as a bare `EventEmitter` field instead of `output()`.
- performance: mutable field bound in the template (`highlighted`) — stale under OnPush.
- component: form not `_fb.nonNullable.group`, control without explicit generic; fields not `readonly`.
- ui-component: `valueChanges` subscription in the constructor without `takeUntilDestroyed`, `debounceTime` (central config) or `distinctUntilChanged` — emits on every keystroke and leaks; the constructor is also supposed to hold `effect()` calls only.
- general: `as never` cast on the emitted value (also emits the form value typed as `CardUser` — wrong contract).
- component: `effect()` patching the form without `{ emitEvent: false }` — feedback loop with the subscription.
- ui-component: no `dataTestPrefix`; no form-reference tracking decorator though the form feeds a parent.
- ui-component: `removeTag` mutates the `input()` value in place (`user()!.tags = ...`) — a presentational child rewriting the parent's data instead of emitting an output.
- test-coverage: `openDetails`/`highlight` behaviors untested (spec below tests almost nothing).

### components-user-panel/ui/ui-user-card/ui-user-card.component.html

- accessibility 2.1.1: `(click)` on the root `<div class="card">` — no `role`, no `tabindex`, no keyboard handler, and it wraps every other control in the card.
- accessibility 1.1.1: neither `<img>` has an `alt` (avatar and fallback).
- component-template: `ngSrc` without `width`+`height` (performance: layout shift).
- component-template: hard-coded color in `[style.color]="'#3f51b5'"` (also a literal binding).
- component-template: `@for ... track tag` — reference identity on an object collection.
- component-template: the `@for` over `user()?.tags` has no `@empty` block, so a user without tags renders as blank space.
- component-template: no `@let` at the top although `user()` is read four times.
- component-template + security-adjacent: HTML-bearing translation (`termsHtml`) rendered via interpolation instead of `[innerHTML]` (shows escaped `<b>` tags).
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
- unit-tests: SCREAMING_SNAKE fixture (`MOCK_USERS`); injected-dependency variable named `svc`; existence-only `should create` test; `it.each` dataset inline, unused in assertions (test asserts nothing per-case); `it`/`it.each` descriptions not starting with `should` (`'renders the card'`, `'renders %s %s'`, `'opens details'`).
- component-test: bare `toHaveBeenCalled()` without arguments; no `afterEach` (`jest.clearAllMocks`, signal resets).
- component-test: `it('opens details')` calls `component.openDetails()` without ever setting the `user` input, so `this.user()!.id` dereferences `undefined` and the test throws `TypeError` (🔴 — the spec is broken, not merely weak). A signal `input()` is written with `MockRender(C, { user })` or `fixture.componentRef.setInput(...)`, never by property assignment.
- component-test (absences): no `dataTestPrefix` test, no form/validator tests, no state→form `{ emitEvent: false }` guard test, no output-emission tests.

### src/index.html

The only non-Angular file in the environment: no local instruction matches it, so it is reviewed against
the global instructions alone — accessibility findings here prove the instruction is really global.

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

### src/assets/i18n/pl.json

- i18n: non-base locale file edited at all (translation team owns it); English placeholder values (`"Save"`, `"User name"`).
- i18n: duplicate key (`labels.userName` twice); key existing only in Polish (`newKeyOnlyInPolish`).

## Cross-file findings the review should also produce

- Naming drift: `userStatusLabel` (models fn) vs `buildResultLabel` (effects method) vs `formatUserName`/`formatUserRow` (utils) re-implement overlapping formatting; the `firstName + ' ' + last_name` join is inlined in the reducer, a selector, a util and the template (define once, reuse).
- One concept, four types: `UserDto` and `UserVm` (models), `CardUser` (`ui-user-card.component.ts`) and `HelperUser` (`user-panel.helpers.ts`) all describe a user with different fields and different casing conventions — the area should carry exactly two (`UserDto` for the API contract, one domain model).
- The result label is computed twice with the same rule: `buildResultLabel` in the effects and the `switch` inside the reducer's `searchUsersSuccess` handler.
- Layer inversion loop: effects → ui barrel → component → facade → service, while the guard and feature component also reach the service directly.
- `filteredUsers` flows action → reducer → state although it is derivable — action, state field and dispatching component should all be findings under their own instructions.
- The area registers state in `shared/routes` providers, has a parallel `shell` routing variant, an NgModule, and three forbidden barrels — canonical layout broken at area level.
- Missing specs across the diff (🔵): feature component, guard, `format-user-name.utils.ts`; changed behaviors without matching spec cases in the existing reducer/selectors/effects/facade/ui specs.
- Accessibility repeats across layers: the focus ring is removed in both the feature component's inline `styles` and the card `.scss`, both files fix a pixel width that cannot reflow, and `(click)` handlers sit on non-interactive elements in `index.html`, the feature template and the card template — each file carries its own finding, all of them 🟡 Medium, and none of them may also appear under `component-template`/`component-styles`.
- The same navigation is rendered twice with different markup and different order — `index.html` (`Users`, `Reports`) and the feature template (`Reports`, `Users`) — which is both a consistency finding (3.2.3) and duplicated markup that belongs in one shared component.
- Accessibility findings must never be escalated or softened: the sanitizer bypass next to them in the feature template stays 🟤 Critical (security), while the `aria-hidden` around a focusable button, the 16px targets and the blocked paste in the password field stay 🟡 Medium.
