---
name: NgRx actions
applies-to:
  - "**/*.actions.ts"
---
## Checklist
- File lives in `<area>/data-access/+state/<area>.actions.ts` and contains exactly one export: `<camelCaseArea>Actions = createActionGroup({...})` — no local types, enums, helpers, constants or `enum ActionTypes`.
- `source` is a descriptive name with spaces (PascalCase words); event keys are `'Verb subject'` sentences (capital first word, spaces).
- Every async operation is a trio kept together: `'X'`, `'X success'`, `'X fail'`; the `success`/`fail` suffix is lowercase so the generated properties are `xSuccess`/`xFail`.
- Every `* fail` event has `props<{ error: HttpErrorResponse }>()` — never `unknown`/`Error`.
- Events without parameters use `emptyProps()` — never `props<{}>()`; a success without payload also uses `emptyProps()`.
- Payload property names match the state field or API key 1:1; nullable payload fields are explicitly `| null`; genuinely optional flags use `?`.
- Mutation verbs follow the convention: `Set` (primitive/flag), `Select` (pick from an existing list), `Toggle` (boolean/panel), `Upsert` (whole object/collection/form value); async verbs: `Load`, `Create`, `Edit`, `Patch`, `Search`, `Remove`.
- A modal/dialog result needed by a follow-up step travels through the trio (the same optional field on the start and success events) — it is not stored in state just to be passed along.
- Event order: main use-case trios → entry-point load trios (with `Start/Stop loading X` pairs and `Cancel X` trios placed directly next to the load they control) → UI commands (open dialog, add, search) → field mutations in UI/wizard order → reset/clear → edit-mode trios → post-load cleanup.
- No action exists for: derived data (selector), pure transformations (util), component-local state (signal), or a side effect that changes nothing and triggers nothing; an action must change state, trigger an effect, or act as a cross-area signal.
- Allowed imports: `HttpErrorResponse`, `createActionGroup`/`emptyProps`/`props`, models via the area barrel or aliases; forbidden: reducer, selectors, effects, facade, components, HTTP services.
- Every declared action is consumed somewhere — a reducer `on(...)`, an effects `ofType(...)`, or a facade dispatch.
