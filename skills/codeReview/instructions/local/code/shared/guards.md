---
name: Route guards
applies-to:
  - "**/*.guard.ts"
---
## Checklist
- File is `shared/guards/<predicate>.guard.ts`; the export is a functional `const <predicate>Guard: CanActivateFn` — never a class guard.
- Dependency injection happens through `inject()` inside the guard body.
- Guards inject **facades** (area facade, layout facade) — never the store and never HTTP services.
- The guard reads facade signals, performs its navigation-configuration side effect through the layout facade, and returns a `boolean`; an always-`true` guard whose purpose is configuring wizard navigation is a valid pattern.
- A parameterized guard factory — a function taking configuration and returning a `CanActivateFn` — is allowed and is invoked inside the `canActivate: [...]` array; the returned function obeys the same rules.
- Conditional navigation covers every branch explicitly (ternary/`if` on facade signals), with target steps taken from the step enum — no magic strings.
- Every guard file has a spec in the sibling `tests/` folder.
