---
name: NgRx selectors
applies-to:
  - "**/*.selectors.ts"
---
## Checklist
- File lives in `<area>/data-access/+state/<area>.selectors.ts`; the feature selector is a **local, non-exported** const created with an explicit state generic (`createFeatureSelector<State>(featureKey)`).
- Individual selectors are local consts prefixed `select` in camelCase; they are exported only through grouped `query` objects: one `<camelCaseArea>Query` by default, plus optional thematic `<camelCaseArea><Subdomain>Query` exports placed directly after their selectors.
- Every exported selector belongs to a query object; a selector in no query is dead code and is removed.
- Derived selectors compose other selectors, not the raw feature state; projector arguments and return values are explicitly typed.
- Every selector is memoized: built with `createSelector`/`createFeatureSelector`, never a plain function or arrow that reads state directly and so bypasses memoization.
- Selectors are pure: no side effects, no `Date.now()`/`Math.random()`/logging; results are new structures, inputs are never mutated.
- References of unchanged elements are preserved (`if unchanged return original`) so memoization and OnPush consumers avoid useless re-renders.
- Null-safety uses `?.` and `??`; a selector never throws — an impossible-by-flow state returns `null` with the return type widened to `<T> | null`.
- Edit-mode safety: a selector reading nested optional data (seeded-but-not-yet-enriched placeholders) guards the field before dereferencing it (`item.nested && item.nested.prop ...`).
- Wizard step gates are named `selectCanGoToNextStep<Step>`, composed exclusively from existing flag selectors, and return an explicitly typed `boolean`.
- A parameterized (higher-order) selector is used only for a value genuinely unavailable in the store at dispatch time; anything obtainable by selector composition is not passed as a parameter.
- Selectors building UI data delegate to shared `form*`/`generate*` utils; the selector itself only picks inputs and delegates.
- Complex payload builders are private module-level functions prefixed `_` at the bottom of the file; once used by more than one selector they move to `shared/utils/` with their own spec; literal objects shared by several selectors are declared once at the top of the file.
- A selector of one thematic query may compose a selector from another query object of the same file through the object reference; the referenced query export is defined above the usage.
- Query export order is thematic, not alphabetical: UI flags → payload builders → input collections → derived UI state → per-wizard-step → cross-step derivations → summary → edit mode.
- Allowed imports: `createFeatureSelector`/`createSelector`, models, pure shared utils; forbidden: actions, effects, facade, reducer, components, HTTP services.
