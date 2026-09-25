---
name: Feature (smart) component
applies-to:
  - "**/feature/**/*.component.ts"
scopes:
  template: ["**/feature/**/*.component.html"]
---
## Checklist
- Folder and file are `feature-<segment>/feature-<segment>.component.*`, class `Feature<PascalCase>Component`, selector `<app-prefix>-feature-<segment>`.
- Allowed injections: the area facade (required — the only bridge to state), a layout facade, `FormBuilder`, `ActivatedRoute`/`Router` (rare), `DestroyRef`, a dialog ref inside dialog components, and — only when aggregating child forms — the shared forms-validity service with its components-reference token.
- Forbidden injections: the store, HTTP/data services, repositories; no imports from `*.actions`/`*.selectors`; no `store.dispatch`.
- State from the facade is consumed as signals re-exported 1:1 (`readonly x = this._facade.x`; the template calls `x()`); facade observable streams and the `async` pipe are not used.
- No `pipe(map(...))` on facade streams; a `computed()` over facade signals is allowed ONLY when the derivation ALSO reads data the NgRx state does not hold (a component `input()`, a local `signal()`, a route value, an injected runtime value) — when every operand comes from the store, the derived value is a new selector exposed by the facade, never a `computed()` in the component.
- {+template} Presentation is delegated to `ui-*` children or shared/library components; the feature wires facade state to children through inputs/outputs and does not render rich markup itself.
- {+template} An extensive, complex, or over-50-line template is extracted into `ui-*` children rather than left inline in the feature component; the feature keeps only the wiring markup that binds facade state to those children.
- Public handlers are thin proxies to facade methods (no logic, no branching beyond trivial argument shaping).
- Route and query parameters arrive as signal `input()`s bound by `withComponentInputBinding()`; `ActivatedRoute` is injected only for what the binding cannot express (reacting to a sibling route, reading a parent route's snapshot).
- `ngOnInit` triggers the initial facade loads and creates subscriptions — it no longer reads route parameters.
- Edit mode: the entity identifier is the bound `input()` and, when present, the definition load is dispatched through the facade; both branches (present/absent) exist and are expressed as a signal read (`effect()`/`computed()`), not a params subscription.
- Aggregated child-form validity uses the shared forms-validity service pattern: subscribe to the components-reference token and register references, subscribe to the aggregate-validity observable with `debounceTime` taken from the central app config, `distinctUntilChanged()` and `takeUntilDestroyed(...)`, then propagate the result (e.g. to the layout facade or a facade flag).
- Values aggregated from children and persisted only on step exit are flushed in `DestroyRef.onDestroy(() => facade.upsert...())` — never in `ngOnDestroy`.
- Wizard gating (`canGoToNextStep`-style calls) combines the dedicated gate selector exposed by the facade with local form validity; tooltips/labels passed there are i18n keys.
- Dialog feature components close through the injected dialog ref, keep dialog-local UI state in `signal()`s, and hand results back via facade methods.
- The component is registered in routes with `loadComponent`; the facade, reducer and effects are provided on the route — never in `@Component.providers` (a documented component-scoped store service for self-contained UI state is the only allowed provider).
