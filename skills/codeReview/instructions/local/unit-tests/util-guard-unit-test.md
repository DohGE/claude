---
name: Util and guard unit tests
applies-to:
  - "**/*.util.spec.ts"
  - "**/*.guard.spec.ts"
---
## Checklist
- Util specs are plain `describe`/`it` — no TestBed, no ng-mocks, no mocks; every util file has one.
- Util coverage: the happy path plus edge cases (empty array/`null` input); small results are asserted whole with `toEqual`, large ones per field or slice; a copy-returning util asserts `result` `not.toBe(input)` while `toEqual(input)`.
- DTO→domain mapping utils assert the complete field-by-field mapping in one `toEqual`.
- Large summary structures may use `toMatchSnapshot()` with snapshots stored in `tests/__snapshots__/`; snapshots are refreshed only after reviewing the diff.
- Guard specs run the guard inside `TestBed.runInInjectionContext(() => guard(route, state))`; route/state stubs are `{} as ActivatedRouteSnapshot`/`{} as RouterStateSnapshot` when the guard does not read them.
- Guard facades are mocked as `Partial<Facade>` providers with `useValue`; signals the tests mutate are declared outside the mock and reset in `afterEach` together with `jest.clearAllMocks()` and `TestBed.resetTestingModule()`.
- Every branch of the guard's conditional navigation has its own `it`, asserting both the returned value and the exact navigation call (`toHaveBeenCalledWith(...)`, `toHaveBeenCalledTimes(1)`).
