---
name: Component unit test
applies-to:
  - "**/*.component.spec.ts"
---
## Checklist
- The spec verifies the contract with the facade(s) and inputs/outputs — not markup: no `fixture.debugElement.query(...)` and no DOM assertions (markup belongs to snapshots/e2e).
- The facade is mocked as a `Partial<Facade>` object: methods as `jest.fn()`, signals as real `signal(...)` values.
- Signals mutated during tests are declared **outside** the mock object (so `.set()` is reachable in `it`/`afterEach`) and every one of them is reset in `afterEach`; signals never mutated are declared inline in the mock.
- The route mock exposes a typed `jest.fn<ReturnType, [ArgType]>` for query-param access, defaulting to `null`.
- Setup: `MockBuilder(Component)` with `.provide`/`.mock` for facades and route in `beforeAll`, one shared `MockRender` fixture; a local `MockRender` (always followed by `localFixture.destroy()`) is created inside an `it` only for paths that genuinely require a different render (edit-mode entry, initially-disabled state).
- The shared `beforeAll` fixture is the default render for every `it`; a component is re-rendered inside a test only when that test must assert behavior occurring immediately on initialization (a load dispatched from `ngOnInit`, a constructor `effect()`'s first run) — those calls fire once during the `beforeAll` render and are cleared by `afterEach`, so they are unobservable without a fresh render. Do not call `MockRender` in tests that assert nothing initialization-specific.
- Covered scenarios: every load dispatched from `ngOnInit`; constructor `effect()` propagation (mutate signal + `detectChanges()`, assert with `toHaveBeenLastCalledWith`); the `dataTestPrefix` value; `computed()` UI data (assert on the transformed output for a given input signal); each public handler (one `it` per handler asserting the facade call and arguments); the initial form value plus every validator via `controls.x.hasValidator(...)`; form→state per control (`setValue` → facade method called); state→form per effect (signal set → control value updated **and** the reciprocal facade setter `not.toHaveBeenCalled()` — this guards the `{ emitEvent: false }` loop protection); every `compareWith*` function (match, mismatch, null-safety in both directions); edit-mode entry with both branches (id present → definition load dispatched; absent → not called).
- Handlers that read signals first set the signal + `detectChanges()`, then assert the handler used the current value.
- Not tested: selectors/effects/reducers (own specs), shared-library components, and plain pass-through re-exports of facade signals.
