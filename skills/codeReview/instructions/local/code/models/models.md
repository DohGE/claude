---
name: Models folder
applies-to:
  - "**/models/*.ts"
  - "**/models/**/*.ts"
---
## Checklist
- `models/` is the only source of the area's types, enums and constants, split into `consts/`, `enums/`, `interfaces/`, `types/` (optional thematic subfolders for large areas); file suffixes match: `.const.ts`, `.enum.ts`, `.interface.ts`, `.type.ts`.
- File name is the kebab-case of the main export; one main export per file (closely related helper interfaces may live alongside it).
- Files are purely declarative — only `export interface/type/enum/const`; no functions (→ `shared/utils/`), classes, components, providers, or logic inside constants (a const is a literal or a `Record`, never an IIFE or function result).
- The barrel `index.ts` has commented sections in fixed order (`// consts`, `// enums`, `// interfaces`, `// types`), contains only `export * from '...'` lines, lists **every** model file, and holds no declarations; consumers outside `models/` import only through the barrel.
- Files **inside** `models/` import each other by relative paths to concrete files — never through their own barrel or the area alias (cycle risk); imports from outside the area always go through aliases.
- Helper interfaces used only within one file (building blocks of a bigger DTO) are declared without `export`.
- The feature key is a camelCase const whose value is a descriptive string with spaces; one const per file.
- The initial state const is explicitly typed with the state interface (the compiler enforces completeness): `false` for loading flags, `[]` for collections, `null` for optional entities, sensible form defaults, nested objects filled completely (never `{}`); the state type is imported by its concrete path, not the barrel.
- DTO request/response interfaces use `snake_case` fields (API contract); a payload, its response and item types for one endpoint may share a file; literal-type fields narrow unions; derived types (`Pick`/`Omit`/array aliases) of neighbouring DTOs stay in the same `.interface.ts` file.
- Existing endpoint DTO interfaces are not modified unless the task explicitly states the API contract changed.
- Domain/UI types use `camelCase` fields (the DTO→domain mapping happens in the reducer or a util); the exception keeping `snake_case` is a structure that stores the raw API shape and is passed 1:1 into a payload without transformation.
- `type` is used for unions/intersections/utility types (`Pick`, `Omit`, `Partial`, mapped types) and for enriching library types by intersection; `interface` for plain extensible objects; discriminated unions keep the literal discriminant field and all member interfaces in one file.
- Table UI type files keep the complete set together: the table type, the `...DisplayedColumns` enum (all columns, including action-only ones), the `...DisplayedColumnsLabels` enum (only translated headers) — two separate enums whose string values equal their keys — plus the `...SourceData`/`...Cell` interfaces; drag-and-drop table types are parameterized with the existing domain item type instead of a separate source-data interface.
- Enums are string enums only: camelCase keys, values equal to the API strings; never numeric enums.
- Mappers are `Record<EnumKey, Value>` consts (completeness enforced by the compiler) named `...Mapper` in `-mapper.const.ts` files; the mapper imports its enum by relative path; a mapper that outgrows a plain `Record` becomes a util with a spec.
- Radio/select option consts are typed with the shared-library option interface, and their `label`/`description` values are i18n keys, never texts.
- No `readonly` on state/DTO/domain fields — immutability is enforced by the reducer, not the type; no `?` fields in the state interface (use `| null`).
- Model files have no unit tests (they are verified by the compiler and by reducer/selector specs).
