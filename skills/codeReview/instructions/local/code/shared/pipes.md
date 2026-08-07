---
name: Pipes
applies-to:
  - "**/*.pipe.ts"
---
## Checklist
- Standalone pipe; `name` is camelCase and matches the file (`<name>.pipe.ts`), class `<PascalCase>Pipe`.
- Pipes are pure (`pure: true`, the default) — an impure pipe re-runs on every change-detection cycle and is a performance defect; a value that cannot be derived purely belongs in a `computed()` or a selector.
- `transform` declares explicit parameter and return types with no `any`; a union return type is expressed with overloads, never with an assertion at the call site.
- No injection of the store, a facade or an HTTP service; no side effects, no logging, no DOM access.
- User-facing text produced by a pipe is an i18n key resolved through the translation service — never a hard-coded string.
- A pipe used by exactly one template for something that is not a formatting concern is a `computed()` instead — a pipe is the reuse mechanism, not the derivation mechanism.
- A pipe never duplicates a framework or shared-library pipe (`date`, `currency`, `decimal`, `translate`) or a `shared/utils/` function that already does the transformation.
- The pipe is listed in the `imports` array of every component whose template uses it (component instruction).
- Every pipe has a spec in the sibling `tests/` folder covering each branch of `transform` plus `null`/empty input.
