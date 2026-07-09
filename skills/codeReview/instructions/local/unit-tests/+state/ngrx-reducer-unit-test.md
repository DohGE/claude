---
name: NgRx reducer unit test
applies-to:
  - "**/*.reducer.spec.ts"
---
## Checklist
- No TestBed and no mocks — the reducer is called directly; `initialState` is a copy of the exported const and **every** test input is a fresh spread (`{ ...initialState, ... }`), never `{} as State`.
- Flag/field assertions cover the whole state: `expect(state).toEqual({ ...initialState, changedField })` proves no other field changed; `toBe` (reference equality) proves an element was **not** replaced.
- Loading flags: one test per start action (`→ true`); success/fail resets parameterized with `it.each` over a named dataset (new actions are appended to that dataset).
- Every handler with a payload has a `describe` with assertions per modified field; every branch in a handler (`if/else`, `??`, `?.`, conditional seeding) has its own `it`.
- Collection upserts have an explicit anti-duplication test: an item already present in state is replaced by id, not appended.
- Null-guard handlers have `should be a no-op when <collection> is null` tests returning the unchanged state.
- Reset/clear handlers have one test that first sets every affected field to a non-default value, then asserts each is cleared; the test title lists the cleared fields.
- The edit-mode load-success handler has a test enumerating **all** seeded fields, plus a separate test for placeholder seeding of not-yet-enriched nested data (payload includes both a filled and a `null` nested entry).
- Default-selection fallbacks are tested for each branch: existing selection preserved, first-element fallback, `null` fallback.
- Fixtures are complete domain objects; `{} as X` only when the handler sets a flag without reading payload fields.
