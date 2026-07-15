# codeReview test environment — answer key

A fake Angular/NgRx feature area (`user-panel`) in which nearly every file deliberately violates the
checklists in `skills/codeReview/instructions`. It exists to stress-test the `/codeReview` skill:
run a review over these files and diff the report against the inventory below.

The code is not meant to compile — it only has to be realistic enough to review.

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

- architecture: barrel `index.ts` outside `models/`/`shared/` is forbidden (and it re-exports the whole state layer to the world).

### data-access/services/user-panel.service.ts

- security: hardcoded API key (`API_KEY = 'sk_live_...'`) — secret in the diff; also SCREAMING_SNAKE (general).
- security + http-service: key appended to query params and an `Authorization` header hand-built per request (must come from the interceptor).
- http-service: `endpoints` exported (must be module-level, non-exported); hard-coded absolute base URL (private endpoint); URL interpolation outside `endpoints` (string concatenation in methods); leading-slash path in `searchUsers`.
- http-service: local interface declared in the service (`SearchResponse`).
- http-service: `@Injectable()` without `providedIn: 'root'` (inverse of the facade rule).
- http-service + best-practices: constructor injection in a new service; store injected into an HTTP service.
- http-service: `Observable<any>` (+ `get<any>`) — no honest DTO generic; `pageSize ?? 25` instead of a default parameter value.
- http-service: `.pipe(map, catchError, tap)` inside the service — mapping/error handling belong to reducer/effects; `catchError(() => of([]))` swallows failures (general); `tap` + `console.log` logging.
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
- ngrx-selectors-test (absences): no edit-mode safety test, no parameterized-selector two-step test (`selectUserById`).

### data-access/+state/tests/user-panel.effects.spec.ts

- ngrx-effects-test: `actions$` assigned eagerly at module level with `of(...)` — must be a lazily reassigned-per-`it` variable.
- ngrx-effects-test: HTTP simulated with `of()` instead of per-endpoint `Subject`s.
- ngrx-effects-test: service mock typed with `as unknown as UserPanelService` instead of `satisfies Partial<...>`; variable named `svc` (unit-tests: full descriptive names).
- ngrx-effects-test: `fakeAsync`/`tick` instead of the `(done)` callback + `pipe(take(1))`.
- ngrx-effects-test: bare `toHaveBeenCalled()` — payload not asserted.
- ngrx-effects-test: no `afterEach` (`jest.clearAllMocks`, `resetSelectors`); no `ngMocks.faster()`; setup in `beforeEach` not `beforeAll`.
- ngrx-effects-test (absences): no error test for any HTTP effect, only one of six effects tested, no non-emission `filter` tests, no `{ dispatch: false }`/`tap` side-effect tests, no dialog-cancel test.

### data-access/+state/tests/user-panel.facade.spec.ts

- ngrx-facade-test: TestBed instead of `MockBuilder(Facade).mock(Store, storeMock)`; store mock cast with `as unknown as Store` instead of `Partial<Store>`.
- ngrx-facade-test: nested `describe`s for a proxy class (must be flat `it`s).
- ngrx-facade-test: bare `toHaveBeenCalled()` instead of `toHaveBeenCalledWith(actions.x({ ...payload }))`.
- ngrx-facade-test: signals tested (`facade.list()`); `expect.objectContaining` used.
- ngrx-facade-test: no `afterEach` with `jest.clearAllMocks()`; no null-parameter variant tests; `searchAndReturn` untested.

### shared/guards/user-panel.guard.ts

- guards: class guard implementing `CanActivate` instead of a functional `const <predicate>Guard: CanActivateFn`; file name is not a predicate.
- guards: injects the store and an HTTP service (facades only); fires an HTTP request from a guard.
- guards: navigation target as magic string (`'/users/step-2'`) instead of the step enum; side effect through Router instead of the layout facade.
- guards: returns `Observable<boolean>` instead of reading facade signals and returning `boolean`.
- best-practices: constructor DI instead of `inject()` in the guard body.
- guards + test-coverage: no spec in a sibling `tests/` folder (🔵).

### shared/utils/build-user-table.util.ts

- utils: export is a `const` arrow function and a `default` export (must be a named `export function`); two public functions in one file; missing explicit return types.
- utils: impure — `Math.random()` inline id, `Date.now()`, and in-place `sort` mutating the argument.
- utils: `displayedColumns` hard-coded instead of `Object.values(<ColumnsEnum>)`; labels are texts, not i18n keys; rows lack an explicit row type; id not from the shared ID-generator util.
- security: new third-party dependency (`tiny-clone-x`) introduced silently.

### shared/utils/tests/build-user-table.util.spec.ts (+ .snap)

- util-guard-test: TestBed in a util spec (plain `describe`/`it` only).
- unit-tests: SCREAMING_SNAKE fixture (`MOCK_USERS`); `as any` incomplete fixture; existence-only test.
- util-guard-test: snapshot of impure output (id/timestamp change every run); `.snap` stored directly in `tests/` instead of `tests/__snapshots__/`.
- util-guard-test (absences): no empty/null edge cases; no `not.toBe(input)` copy assertion; `formatUserRow` untested.

### shared/utils/format-user-name.utils.ts

- utils: plural `.utils.ts` suffix (must be singular `.util.ts` — note: this also dodges the local glob; the naming/architecture rules must still catch it).
- utils: arrow const export, `any` parameter, no explicit return type, trivial single-consumer logic, duplicated inline name-joining already done in reducer/util (define once, reuse).
- utils + test-coverage: no spec (🔵).

### shared/index.ts

- architecture: the `shared/` barrel re-exports utils (never allowed) — and re-exports the guard.

### shared/routes/user-panel.routes.ts

- routes: export named `routes` and untyped (must be `userPanelRoutes: Routes`).
- routes + best-practices: eager `component:` import of the feature component instead of `loadComponent`.
- routes: simple-page variant carries `providers` (`provideState`/`provideEffects`/facade) and `canActivate` — must be thin and stateless.
- routes: no `title` on a user-navigable route.
- routes: helper function (`buildPath`) — no logic allowed in a routes file.
- architecture: area has BOTH `shared/routes/` and `shell/` (either, never both).

### shared/routes/tests/user-panel.routes.spec.ts

- routes: route files must have no unit specs.
- unit-tests: existence-only test.

### shell/user-panel-shell.routes.ts

- routes: wizard variant with magic-string step paths (not the step enum), no `canActivate` guards (initialization + previous-step), no titles.
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
- best-practices: explicit `standalone: true`; `@Input()`/`@Output()` decorators with `!` definite assignment and `EventEmitter<any>` instead of `input.required`/`output()`.
- feature-component + architecture: store injected + `store.dispatch`, actions/selectors imported, HTTP service injected and called — components may talk only to the facade.
- component: injected fields public and unprefixed (`facade`, `store`, `svc` — generic name), not `private readonly _...`.
- component: `dataTestPrefix` equals the selector (must be a stable descriptive name).
- general/i18n: hard-coded user-facing strings (`title`, template texts).
- performance: mutable class fields bound in the template (`title`, `resultCount`); `resultCount` mutated in `ngDoCheck` every CD cycle; `ngDoCheck` itself forbidden.
- general: string-index type access (`UserPanelState['users']`).
- performance/SSR + component: `location.search`/`window`/`document` in field initializers, constructor and `ngOnInit` (browser work belongs in `afterNextRender`).
- feature-component: `computed()` wrapping a facade signal (`filtered`) and `pipe(map(...))` on a facade stream (`userNames$`) — derived state belongs in a selector (historically under-reported rule).
- performance: `httpResource` read via `.value()` without `hasValue()` guard (in `onSave`); resource params read a non-signal `@Input`.
- component: manual `Subject`/`Subscription` cleanup pattern + `ngOnDestroy` (must be `takeUntilDestroyed`/`DestroyRef`); `destroy$` never `.complete()`d; inner subscription in `valueChanges` never cleaned (leak).
- performance: `toSignal()` inside a getter — new subscription per read.
- component: constructor does loads/dispatches and logging (only `effect()` allowed); `effect()` writes state (`resultCount`) and patches the form without `{ emitEvent: false }` (feedback loop with the `valueChanges` subscription).
- best-practices: `inject()` inside a method (`onSave`) — NG0203 runtime error.
- feature-component: `ngOnInit` reads query params via `URLSearchParams` instead of `ActivatedRoute`; edit-mode has only the id-present branch (no else).
- performance: hard-coded `setInterval` polling, never cleared, resubscribing a cold HTTP observable each tick.
- component: untyped form (`UntypedFormGroup`/`UntypedFormControl`) instead of `_fb.nonNullable.group` with explicit generics; `addValidators` without `updateValueAndValidity()`; `valueChanges` without `distinctUntilChanged(isEqual)`.
- security: `setTimeout('this.refresh()', 500)` — string argument; `bypassSecurityTrustHtml(user.bio)` on API-derived data (Critical).
- feature-component: handler with business logic (`onSave` filters users, dispatches, calls HTTP `deleteUser` with a floating promise); `saved.emit` of a double-cast payload (`as unknown as`).
- performance/template: `formatDate`/`greet` methods called from template bindings.
- best-practices: `@HostListener` instead of `host: {}`.
- i18n: greeting built by string concatenation (`buildGreeting(user) + ', ' + this.title`) instead of a translation with params.
- general: `console.log` calls; commented-out `refresh()` code block.
- component: enum alias renamed (`statuses = UserStatus` — must keep the enum name, `userStatus`); signals/aliases not `readonly`; member order broken (handlers before lifecycle, fields interleaved).
- test-coverage: no spec for the whole component (🔵).

### components-user-panel/feature/feature-user-panel/feature-user-panel.component.html

- component-template: `*ngIf`/`*ngFor` instead of `@if`/`@for`; `[ngClass]`/`[ngStyle]` instead of `[class.x]`/`[style.x]`; hard-coded color in `ngStyle`.
- component-template: `*ngFor` without any stable `track`.
- performance: LCP hero image inside `@defer (on viewport)` with no `@placeholder` (layout shift + deferred LCP); `<img>` without `alt`, without `ngSrc`, without `height`, no `priority`.
- component-template: `[(ngModel)]` template-driven binding (best-practices) mixed with reactive `[formControl]`; both inputs unlabeled (no `label for`/`aria-label`); hard-coded placeholders.
- component-template: `(click)` on `<div>` and `<span>` without `role`/`tabindex`/keyboard handling; icon-only button (🔄) without `aria-label`; no `data-test` attributes anywhere despite `dataTestPrefix`.
- component-template: literal property binding `[title]="'Refresh'"`; facade call with logic inline in the template (`facade.loadUsers({ pageSize: 25 })`).
- component-template: method calls in interpolations (`formatDate(...)`, `greet(...)`).
- security: `[innerHTML]` bound to sanitizer-bypassed API data; `target="_blank"` link without `rel="noopener noreferrer"`; `[href]="returnUrl"` straight from query params (open redirect); `[href]="user.homepage"` unvalidated API URL.
- component-template: duplicated branch markup (`Found ... users` + Export button twice) instead of `ng-template` + `ngTemplateOutlet`.
- component-template: static `aria-expanded="false"` never bound to state.
- component-template: `async` pipe (`userNames$ | async`).
- component-template: error message (`Email is required`) hard-coded and not announced (no `aria-live`/shared alert).
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
- ui-component: facade injected + `loadUsers` called, Router injected + navigation — a presentational component must only render inputs and emit outputs.
- ui-component/models: local duplicate model (`CardUser`) instead of a `models/` type.
- component: input the template cannot render without is plain `input<CardUser>()` (with `!` assertions later) instead of `input.required`.
- best-practices: `@Input() set` accessor (`highlight`); output as a bare `EventEmitter` field instead of `output()`.
- performance: mutable field bound in the template (`highlighted`) — stale under OnPush.
- component: form not `_fb.nonNullable.group`, control without explicit generic; fields not `readonly`.
- ui-component: `valueChanges` subscription in the constructor without `takeUntilDestroyed`, `debounceTime` (central config) or `distinctUntilChanged` — emits on every keystroke and leaks.
- general: `as never` cast on the emitted value (also emits the form value typed as `CardUser` — wrong contract).
- component: `effect()` patching the form without `{ emitEvent: false }` — feedback loop with the subscription.
- ui-component: no `dataTestPrefix`; no form-reference tracking decorator though the form feeds a parent.
- test-coverage: `openDetails`/`highlight` behaviors untested (spec below tests almost nothing).

### components-user-panel/ui/ui-user-card/ui-user-card.component.html

- component-template: `(click)` on a `<div>` without `role`/`tabindex`/keyboard.
- component-template: `<img [src]>` without `alt`; `ngSrc` without `width`+`height` (performance: layout shift).
- component-template: hard-coded color in `[style.color]="'#3f51b5'"` (also a literal binding).
- component-template: `@for ... track tag` — reference identity on an object collection.
- component-template + security-adjacent: HTML-bearing translation (`termsHtml`) rendered via interpolation instead of `[innerHTML]` (shows escaped `<b>` tags).
- component-template: hard-coded `Select user` text; `<button>` without `type`; no `data-test` attributes.
- ui-component: `[disabled]` bound on a reactive control instead of `effect(() => form.disable({ emitEvent: false }))`.
- component-template: control unlabeled.

### components-user-panel/ui/ui-user-card/ui-user-card.component.scss

- component-styles: hard-coded colors (`#3f51b5`, `rgb(66,66,66)`, `#ff0000`) instead of theme custom properties; no dark-mode counterparts.
- component-styles: class names not BEM with the component root block (`.card`, `.btnPrimary`, `.red-text`).
- component-styles: bare `::ng-deep` not wrapped in `:host`.
- component-styles: repeated magic number `13px` (no SCSS variable, no theme `@use`).
- component-styles: redundant `display: block` on an already-block element; `.red-text` duplicates a utility class.

### components-user-panel/ui/ui-user-card/tests/ui-user-card.component.spec.ts

- component-test: DOM assertions via `fixture.debugElement.query(By.css(...))` (markup belongs to snapshots/e2e).
- component-test: facade mock cast `as unknown as UserPanelFacade` instead of `Partial<Facade>` with real `signal(...)` values; signal mocked as `jest.fn`.
- component-test: TestBed + `beforeEach` fixture instead of `MockBuilder`/`ngMocks.faster()` + one shared `MockRender` in `beforeAll`.
- unit-tests: SCREAMING_SNAKE fixture (`MOCK_USERS`); injected-dependency variable named `svc`; existence-only `should create` test; `it.each` dataset inline, unused in assertions (test asserts nothing per-case).
- component-test: bare `toHaveBeenCalled()` without arguments; no `afterEach` (`jest.clearAllMocks`, signal resets).
- component-test (absences): no `dataTestPrefix` test, no form/validator tests, no state→form `{ emitEvent: false }` guard test, no output-emission tests.

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
- Layer inversion loop: effects → ui barrel → component → facade → service, while the guard and feature component also reach the service directly.
- `filteredUsers` flows action → reducer → state although it is derivable — action, state field and dispatching component should all be findings under their own instructions.
- The area registers state in `shared/routes` providers, has a parallel `shell` routing variant, an NgModule, and three forbidden barrels — canonical layout broken at area level.
- Missing specs across the diff (🔵): feature component, guard, `format-user-name.utils.ts`; changed behaviors without matching spec cases in the existing reducer/selectors/effects/facade/ui specs.
