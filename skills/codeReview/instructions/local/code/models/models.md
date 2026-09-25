---
name: Models folder
applies-to:
  - "**/models/**/*.ts"
scopes:
  declaration: ["**/models/**/*.ts", "!**/*.spec.ts", "!**/tests/**"]
  types: ["**/*.interface.ts", "**/*.type.ts", "**/interfaces/**", "**/types/**", "!**/*.spec.ts", "!**/tests/**"]
  consts: ["**/*.const.ts", "**/consts/**", "!**/*.spec.ts", "!**/tests/**"]
  enums: ["**/*.enum.ts", "**/enums/**", "!**/*.spec.ts", "!**/tests/**"]
  barrel: ["**/index.ts"]
  consumer: ["**/*.ts", "!**/models/**"]
  util: ["**/*.util.ts", "**/*.utils.ts", "**/shared/utils/**/*.ts", "!**/*.spec.ts", "!**/tests/**"]
---
## Checklist
- {declaration} `models/` is the only source of the area's types, enums and constants, split into `consts/`, `enums/`, `interfaces/`, `types/` (optional thematic subfolders for large areas); file suffixes match: `.const.ts`, `.enum.ts`, `.interface.ts`, `.type.ts`.
- {declaration} File name is the kebab-case of the main export; one main export per file (closely related helper interfaces may live alongside it).
- {types} A new `type`/`interface` brings ALL its dependencies into ONE file: the helper interfaces, unions, enums and utility types that only it uses are declared next to it (helpers without `export`), never scattered over `enums/`, `interfaces/` and `types/` as one-declaration files. The file keeps the suffix of its main export and the barrel exports it once. Splitting a dependency away from its single consumer type is a finding; the only dependency that gets its own file is one a SECOND type, object or area really consumes. This co-location is never itself a finding and a split is never demanded for types whose only consumer is that one declaration.
- {consts} A const is created only when it is reusable, carries meaningful logic/knowledge (a mapper, an option set, a configuration, a shared literal) or removes a magic value used in several places. A small one-off value — a single string, number, flag or object literal used in exactly ONE place — stays inline at its use site; extracting it into a `.const.ts` file (or a module-level const) is a finding, exactly like extracting a short single-consumer util.
- {declaration} Files are purely declarative — only `export interface/type/enum/const`; no functions (→ `shared/utils/`), classes, components, providers, or logic inside constants (a const is a literal or a `Record`, never an IIFE or function result).
- {consts} A `.const.ts` file declares CONSTANTS only: no `interface`, no `type`, no `enum` in it — not even an unexported helper used by that one const. The type a const is annotated with is imported from its own `.interface.ts`/`.type.ts`/`.enum.ts` file or from the shared library; declared next to the const it is invisible to every other consumer that needs the same shape, and the next consumer writes a second copy of it. The co-location rule above lets a TYPE file gather the dependencies only it uses — it never lets a const file grow its own.
- {barrel, +consumer} The barrel `index.ts` has commented sections in fixed order (`// consts`, `// enums`, `// interfaces`, `// types`), contains only `export * from '...'` lines, lists **every** model file, and holds no declarations; consumers outside `models/` import only through the barrel.
- {declaration} Files **inside** `models/` import each other by relative paths to concrete files — never through their own barrel or the area alias (cycle risk); imports from outside the area always go through aliases.
- {types} Helper interfaces used only within one file (building blocks of a bigger interface) are declared without `export`.
- {declaration} The word `Dto`/`DTO` is not part of the vocabulary: no `UserDto`, no `user-dto.interface.ts`, no `dto/` folder, no `dto` field, variable or generic parameter — in nothing the diff adds or renames. A type is named after what it carries plus its role (`User`, `UserResponse`, `UsersListResponse`, `CreateUserRequest`, `UserSearchPayload`) and its file after the type (`user-response.interface.ts`).
- {consts} The feature key is a camelCase const whose value is a descriptive string with spaces; one const per file.
- {consts} The initial state const is explicitly typed with the state interface (the compiler enforces completeness): `false` for loading flags, `[]` for collections, `null` for optional entities, sensible form defaults, nested objects filled completely (never `{}`); the state type is imported by its concrete path, not the barrel.
- {types} API request/response interfaces mirror the endpoint exactly: the field names and the casing the API really sends (`snake_case` stays `snake_case`, never re-spelled to match the project style); a payload, its response and item types for one endpoint may share a file; literal-type fields narrow unions; derived types (`Pick`/`Omit`/array aliases) of neighbouring API interfaces stay in the same `.interface.ts` file.
- {types} Existing endpoint interfaces are not modified unless the task explicitly states the API contract changed.
- {types, +util} A mapping layer exists only where it CHANGES something: flattening, joining, computing values, filling defaults, narrowing unions, building UI structures. When the only difference between the API shape and the domain shape would be the spelling of the field names, there is no mapping and no twin interface — the API interface goes into the state, the selectors and the template as it is, `snake_case` fields included, and its absence is never a finding. An interface + mapper pair whose entire effect is re-casing fields is a layer that changes nothing: report it as unnecessary code. Domain/UI types that genuinely differ from the API use `camelCase` fields, and the mapping into them lives in the reducer or a util.
- {types} `type` is used for unions/intersections/utility types (`Pick`, `Omit`, `Partial`, mapped types) and for enriching library types by intersection; `interface` for plain extensible objects; discriminated unions keep the literal discriminant field and all member interfaces in one file.
- {types} Table UI type files keep the complete set together: the table type, the `...DisplayedColumns` enum, the `...DisplayedColumnsLabels` enum and the `...SourceData`/`...Cell` interfaces.
- {types} `...DisplayedColumns` lists ALL columns including action-only ones; `...DisplayedColumnsLabels` lists only translated headers; both are string enums whose values equal their keys.
- {types} Drag-and-drop table types are parameterized with the existing domain item type instead of a separate source-data interface.
- {enums} Enums are string enums only: camelCase keys, values equal to the API strings; never numeric enums.
- {consts, +util} Mappers are `Record<EnumKey, Value>` consts (completeness enforced by the compiler) named `...Mapper` in `-mapper.const.ts` files; the mapper imports its enum by relative path. A const `Record` mapper is PREFERRED over a util: a function whose whole body is a `switch`/`if` chain or an object lookup translating one value into another is a finding — it becomes a `...Mapper` const. Only a mapper that genuinely outgrows a plain `Record` (computation, several inputs, branching on more than the key) becomes a util with a spec.
- {consts} Radio/select option consts are typed with the shared-library option interface, and their `label`/`description` values are i18n keys, never texts.
- {types} No `readonly` on state, API or domain fields — immutability is enforced by the reducer, not the type; no `?` fields in the state interface (use `| null`).
- Model files have no unit tests (they are verified by the compiler and by reducer/selector specs).
