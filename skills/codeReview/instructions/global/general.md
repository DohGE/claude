---
name: General code rules
scopes:
  ts: ["**/*.ts"]
  markup: ["**/*.html"]
  styles: ["**/*.scss", "**/*.css"]
  config: ["**/tsconfig*.json", "**/angular.json", "**/package.json", "**/.eslintrc*", "**/eslint.config.*", "**/.prettierrc*"]
---
## Checklist
- {ts} Named `const` values are camelCase — never SCREAMING_SNAKE_CASE and never PascalCase; interfaces, types, enums and classes are PascalCase.
- {ts} Names are full and descriptive — no abbreviations and no one-letter identifiers; shortening is allowed only for well-established abbreviations or when the full name would exceed ~25–30 characters or 4–5 words.
- {ts} No unnecessary type assertions (`as`), especially `as never` and assertions on primitive types; use a single `as Type` only when the compiler requires it; `as unknown as Type` only when the compiler/ESLint rejects a single assertion because of an incompatible shape.
- {ts} No type access through a string index (`MyInterface['field']`) — reference the named type or field directly.
- {ts} Imports are sorted by the repository Prettier import-order: framework → third-party → shared-library aliases → application aliases → relative paths.
- {ts} Cross-area code is imported through tsconfig path aliases; relative paths are used only within the same feature area.
- {ts, markup, styles} Every user-facing string is an i18n key resolved through the translation pipe/service — never a hard-coded text, in TS or in templates.
- {ts} No `console.log` or other leftover debug statements.
- {ts} No focused or skipped tests in the diff: `fdescribe`, `fit`, `describe.only`, `it.only`, `xdescribe`, `xit`, `test.skip` — a committed `.only` silently reduces CI to one suite while staying green (report as 🔴 High).
- {ts, markup} In-app navigation goes through `Router` (`navigate`/`navigateByUrl`/`routerLink`) — `window.location.href`/`assign`/`replace` discards router state, guards and the SPA boundary; a deliberate full page load carries a justification in the PR description or it is a finding.
- {ts} Errors are never swallowed: no empty `catch` blocks, no `.catch(() => {})`, no `catchError` that drops the failure without mapping it to a fail action/error state — every failure path either surfaces to state/UI or carries an explicit justification in the PR description. In an effect a `catchError` returning `EMPTY` is always a finding (NgRx effects instruction); elsewhere — legacy components/services — `EMPTY` alone is not reported under this rule.
- {config} The diff never weakens the compiler or template contract to make new code build: `strict`, `strictTemplates`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and the ESLint rule set stay at least as strict as they were, and no file is added to an `exclude`/ignore list for that purpose — a flag turned off hides the same class of error in every other file of the repo.
- {ts, markup, styles, config} Linter rules are clean before commit; state-management lint rules (`@ngrx/*`) are errors, not warnings. Prettier-owned formatting (indentation, wrapping, quotes, semicolons, trailing commas, spacing, blank lines) is NEVER a finding — the formatter fixes it mechanically.
