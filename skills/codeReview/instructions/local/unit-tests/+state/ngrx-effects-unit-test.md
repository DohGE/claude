---
name: NgRx effects unit test
applies-to:
  - "**/*.effects.spec.ts"
---
## Checklist
- Setup: `TestBed.configureTestingModule` in `beforeAll` with the effects class, `provideMockActions(() => actions$)` (lazy factory — `actions$` is reassigned per `it`) and `provideMockStore({ initialState })` preseeded for `concatLatestFrom` reads; `ngMocks.faster()`; declared fields `let actions$`, `let effects`, `let store: MockStore`.
- HTTP responses are simulated with a dedicated `Subject` per endpoint — never `of()`/`throwError` (they emit synchronously before assertions attach); success = `.next(value)` after subscribing, error = `.error(error)`.
- Service mocks are objects with `jest.fn(() => responseSubject$)` validated by `satisfies Partial<Service>` (not `as`); dialog mocks return `{ afterClosed: () => result$ }` and use `mockReturnValueOnce` for the cancel branch.
- Every `it` uses the `(done)` callback and `pipe(take(1))`; assertions run inside `subscribe` and end with `done()`; no `fakeAsync`/`tick`/`flush`.
- Every effect has a `describe`; every HTTP effect has a success **and** an error test; payload-carrying calls assert `toHaveBeenCalledWith(payload)`.
- Effects with `concatLatestFrom` use `store.overrideSelector(...)` + `store.refreshState()` per scenario; `afterEach` calls `store.resetSelectors()` (and `jest.clearAllMocks()`).
- Every `if/else` branch inside `map` is a separate `it` combining selector overrides and action payloads, asserting the exact resulting action.
- Every `filter` (cross-area narrowing, dialog cancel, state guards) has a non-emission test: an `emitted` flag with `subscribe({ next, error, complete })` asserting `emitted === false` on complete.
- `{ dispatch: false }` effects are subscribed to force the `tap`, then the side effect is asserted (dialog opened with exact arguments, stop-subject notified, shared service called).
- Multi-action effects assert each dispatched action; merged-trigger effects (`ofType(a, b)`) test each trigger separately with all `tap` side-effect assertions per branch.
- `MockStore` is used only through the `store` field assigned once in `beforeAll`; `TestBed.inject(...)` results are stored in a variable only when used more than once.
