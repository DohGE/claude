---
name: NgRx selectors unit test
applies-to:
  - "**/*.selectors.spec.ts"
---
## Checklist
- Selectors are tested exclusively through `.projector(...)` — no TestBed, no MockStore, no MockRender, no mocks.
- Plain pass-through selectors (`(state) => state.prop`) are not tested; every selector containing logic or composed from other selectors is.
- A selector built directly on the feature state receives a full state (`{ ...initialState, ... }`); a derived selector receives the **output values of its input selectors**, in the exact order of the `createSelector(...)` arguments (wrong order = silent pass with a nonsense result).
- Every branch (`if/else`, `??`, `?.`) has its own `it`; boolean selectors have at least a true and a false case; multi-argument gate selectors have one false-test per AND clause plus at least two true variants.
- Edit-mode safety has an explicit test: items whose nested optional data is still a falsy/placeholder value are ignored without throwing.
- Parameterized (higher-order) selectors are tested in two steps — build with the argument, then call `.projector(...)`; both the default/fallback branch and the passed-through branch are covered.
- Selectors delegating to shared builder utils test only the delegation: empty input and one built output (the util has its own spec).
- `toBe` asserts passed-through references (including memoization-friendly unchanged branches); `toEqual` asserts newly built structures; large structures are asserted on slices (`result.items.map(...)`) for readable diffs.
- After changing a projector signature every existing `.projector(...)` call in the spec is updated to the new order/arity.
