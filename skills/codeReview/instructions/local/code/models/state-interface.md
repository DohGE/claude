---
name: State interface and initial state
applies-to:
  - "**/*-state.interface.ts"
  - "**/*-initial-state.const.ts"
---
## Checklist
- The state interface is one flat structure `export interface <Area>State { ... }` in `models/interfaces/`; the file name is the kebab-case of the interface.
- Optional fields are explicitly `| null`, never `?` — the state is deterministic and every field has an explicit value in the initial state.
- Loading flags are plain `boolean` (not optional); collections are arrays initialized to `[]` (or typed `| null` when "none" is a distinct UI state).
- No `readonly` on fields, no functions, no logic; field types are imported by concrete relative paths or external aliases — never through the area's own barrel.
- **No derived fields**: before adding a field, verify its value cannot be computed from existing fields; predicates/aggregates over other fields, single fields extracted from stored objects, and filtered/sorted/mapped views of stored collections all belong in selectors.
- A field exists only for an independent input: API data, a user choice, a loading flag, a raw form value; validity flags reported by components (form-valid booleans, reference error lists) count as inputs and are allowed.
- Every interface field also exists in the initial-state const with an explicit default; the initial state is explicitly typed with the interface so the compiler enforces completeness; nested defaults are complete objects, optionally extracted to a local non-exported const when reused.
