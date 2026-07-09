---
name: General code rules
---
## Checklist
- Named `const` values are camelCase — never SCREAMING_SNAKE_CASE and never PascalCase; interfaces, types, enums and classes are PascalCase.
- Names are full and descriptive — no abbreviations and no one-letter identifiers; shortening is allowed only for well-established abbreviations or when the full name would exceed ~25–30 characters or 4–5 words.
- No unnecessary type assertions (`as`), especially `as never` and assertions on primitive types; use a single `as Type` only when the compiler requires it; `as unknown as Type` only when the compiler/ESLint rejects a single assertion because of an incompatible shape.
- No type access through a string index (`MyInterface['field']`) — reference the named type or field directly.
- Imports are sorted by the repository Prettier import-order: framework → third-party → shared-library aliases → application aliases → relative paths.
- Cross-area code is imported through tsconfig path aliases; relative paths are used only within the same feature area.
- Every user-facing string is an i18n key resolved through the translation pipe/service — never a hard-coded text, in TS or in templates.
- No `console.log` or other leftover debug statements.
- No commented-out code; a comment exists only to state a constraint the code itself cannot express — never to narrate what the next line does or why a change was made.
- Linter and Prettier are clean before commit; state-management lint rules (`@ngrx/*`) are errors, not warnings.
