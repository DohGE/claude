---
name: Utility functions
applies-to:
  - "**/*.util.ts"
---
## Checklist
- File is `shared/utils/<verb>-<subject>.util.ts` (singular `.util.ts`, never `.utils.ts`; thematic subfolders allowed, each with its own `tests/`); verbs describe the job: `form-`/`build-` (data → UI/payload structure), `generate-` (tables/IDs/structures), `map-` (shape A → shape B), `create-` (single element factory).
- The export is a named `export function` (not an arrow const, not default) with explicit parameter and return types; one public function per file (private module helpers allowed above/below it).
- Functions are pure: same inputs → same output; no side effects, no `Date.now()`/`Math.random()` (pass such values as arguments), no mutation of arguments; a defensive copy (`[...input]`) is made when the result must not share the caller's reference.
- Table builders: `displayedColumns` from `Object.values(<ColumnsEnum>)` (never a hard-coded array); `displayedColumnsLabels` maps enum members to i18n keys (never texts); rows are mapped with an explicit row type annotation; IDs come from the shared ID-generator util (never inlined); the persistence identifier comes from the shared enum.
- Summary/flow builders: branching flags live in well-named local variables; conditional entries are `push`ed into an explicitly typed accumulator array; displayed labels and yes/no-style values are i18n keys; null-safety with `?.`/`?? ''`.
- Aggregation utils deduplicate with a `Map` keyed by the identifier, use `reduce<ReturnType>` with an explicit accumulator type, and delegate to shared builders instead of re-implementing them.
- ID formats and shared builders are defined once and reused everywhere — never duplicated inline in reducers, selectors or components.
- Only logic that is reused (≥2 consumers) or complex enough to deserve a test lives here; trivial single-consumer logic stays inline at its call site.
- Utils are never exported through a barrel — consumers import the concrete `*.util.ts` file (relative within the area, alias from outside).
- Every util file has a spec in the sibling `tests/` folder.
