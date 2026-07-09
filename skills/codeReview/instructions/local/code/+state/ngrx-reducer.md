---
name: NgRx reducer
applies-to:
  - "**/*.reducer.ts"
---
## Checklist
- File lives in `<area>/data-access/+state/<area>.reducer.ts`; single export `<camelCaseArea>Reducer = createReducer(<initialState>, ...)`; the initial state, feature key and state interface live in `models/` and are only imported here.
- Every `on(...)` handler has an explicit return type `(state): <Area>State =>` (required by the `no-implicit-return-type` lint error).
- The reducer is pure and immutable: always spread (`{ ...state, field }`); arrays via `[...]`/`map`/`filter` (never `push`/`splice`/`pop`); maps via `new Map([...])`; no `Date.now()`/`Math.random()`/storage access/HTTP.
- Loading flags: `true` on the start action, `false` on both success and fail.
- Actions with an identical state effect are merged into one `on(a, b, ...)`; when a success additionally stores a payload, a merged flag-reset handler plus a second seeding `on(success, ...)` is acceptable.
- Refreshing a collection of objects is an upsert by id: build a map of the response by id, replace matching existing items, append only brand-new ones — never blindly append (it duplicates seeded items in edit mode).
- The edit-mode `load* success` handler seeds **every** field and collection the templates use, including placeholder objects for nested data that will be enriched later; a field whose payload may mean "keep the original/default" is seeded conditionally, never blindly overwritten.
- Handlers that may run against missing data are explicit no-ops: `if (!state.x) return state;` — no flags or errors set in that case.
- Default selections use a fallback chain: `state.selectedX ?? list[0] ?? null` (preserve the user/edit-mode choice first, `null` last — never `undefined`).
- The start handler of an operation that replaces a previous result also clears that result (`previousResponse: null`) so the UI never shows stale data while reloading.
- A derived value that must be persisted in state is recomputed (through a pure util) in **every** handler that changes any of its inputs; read-only derivations stay in selectors.
- DTO→domain mapping uses dedicated utils and `Record` mappers from `models/` — no inline id concatenation and no `switch` mapping inside the reducer.
- Reset/clear handlers list the cleared fields explicitly, one per line (spreading the whole initial state is reserved for an intentional full reset action).
- An emptied collection that the UI treats as "none" is stored as `null`, not `[]`, when the state models it that way.
- Complex domain logic is extracted to `shared/utils/` (one large, commented mapping handler per reducer is the tolerated exception); use `map`/`filter`/`reduce`, not `for` loops; no `as any`.
- Handler order mirrors the actions file (trios together, one concern per block).
- Allowed imports: `createReducer`/`on`, pure utils, models (types, mappers, initial state), the local actions file; forbidden: selectors, effects, facade, HTTP services, components.
