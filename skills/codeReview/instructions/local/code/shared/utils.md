---
name: Utility functions
applies-to:
  - "**/*.util.ts"
---
## Checklist
- File is `shared/utils/<verb>-<subject>.util.ts` (singular `.util.ts`, never `.utils.ts`; thematic subfolders allowed, each with its own `tests/`); verbs describe the job: `form-`/`build-` (data → UI/payload structure), `generate-` (tables/IDs/structures), `map-` (shape A → shape B), `create-` (single element factory). When the file groups several functions, its name states the shared subject they all serve.
- Every export is a named `export function` (not an arrow const, not default) with explicit parameter and return types; private module helpers may live above/below them.
- One file may export several public functions when they are closely related — same subject or flow, shared types, helpers or call site (e.g. a builder plus its variant, a mapper plus its inverse). This grouping is PREFERRED over splitting 5-line functions into separate ~20-line files: never report a cohesive multi-function util file, and do report a new file created only to hold a short function that belongs with an existing related one. Functions with nothing in common still get their own file.
- Functions are pure: same inputs → same output; no side effects, no `Date.now()`/`Math.random()` (pass such values as arguments), no mutation of arguments; a defensive copy (`[...input]`) is made when the result must not share the caller's reference.
- Table builders: `displayedColumns` from `Object.values(<ColumnsEnum>)` (never a hard-coded array); `displayedColumnsLabels` maps enum members to i18n keys (never texts); rows are mapped with an explicit row type annotation; IDs come from the shared ID-generator util (never inlined); the persistence identifier comes from the shared enum.
- Summary/flow builders: branching flags live in well-named local variables; conditional entries are `push`ed into an explicitly typed accumulator array; displayed labels and yes/no-style values are i18n keys; null-safety with `?.`/`?? ''`.
- Aggregation utils deduplicate with a `Map` keyed by the identifier, use `reduce<ReturnType>` with an explicit accumulator type, and delegate to shared builders instead of re-implementing them.
- ID formats and shared builders are defined once and reused everywhere — never duplicated inline in reducers, selectors or components.
- A `.util.ts` exists for logic with ≥2 real consumers. A small function that will be called from ONE place is never extracted: it stays inline at its call site — a module-level function in that file, a `computed()`, a private method — and a new util file created to hold it is a finding even when the function is pure, typed and specced. The single exception is genuinely complex single-consumer logic (branching a spec has to pin down) that would bury its call site.
- Utils are never exported through a barrel — consumers import the concrete `*.util.ts` file (relative within the area, alias from outside).
- Every util file has a spec in the sibling `tests/` folder, covering every function the file exports (one `describe` per exported function).
