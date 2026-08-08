---
name: Component template
applies-to:
  - "**/*.component.html"
---
This instruction OWNS everything inside the template, including template-level accessibility (the global
best-practices instruction only states that accessibility is a review criterion). `@defer` trigger and
bundling rules are owned by the performance instruction.

## Checklist
- Only native control flow: `@if/@else`, `@for`, `@switch`, `@let` — never `*ngIf`, `*ngFor`, `*ngSwitch` or `*ngVar`.
- `@let` declarations at the top of the template unpack `computed()`/signal values that are used more than once.
- Every `@for` tracks by a stable unique identifier (`track item.id`); `track item` (reference identity) on object collections is a defect, and `track $index` is allowed only for static, never-reordered lists.
- Every `@for` over a collection that can be empty and is user-visible declares an `@empty` block — an empty list rendering as blank space is a defect, not a state.
- Every `@switch` covers its fallback with `@default`, including when the subject is an enum (a member added later must not render nothing).
- Every `@defer` block declares a `@placeholder`; `@loading` and `@error` are declared wherever the wait or the failure is user-visible.
- Class and style bindings use `[class.x]` / `[style.x.px]` — never `ngClass`/`ngStyle`.
- No `async` pipe — observables are converted with `toSignal()` in the component and the template reads the signal.
- Every user-facing string goes through the translate pipe (`{{ 'key' | translate }}`), including parameterized texts (`| translate : { param }`); zero hard-coded texts.
- A translation containing HTML markup is rendered with `[innerHTML]="'key' | translate"`, not interpolation — and `[innerHTML]` is used for nothing else: never bound to user-/API-derived values or concatenated HTML (see the security instruction).
- Bindings and interpolations read signals, `computed()` values and pure pipes — no component method calls inside property/interpolation bindings (function references passed uninvoked, e.g. `[compareWith]="compareWithId"`, are fine).
- Every interactive native element carries `[attr.data-test]="dataTestPrefix + '<element-name>'"` (or a plain `data-test` attribute when the prefix is constant). On a component selector `data-test` is allowed only when that component is a wrapper around the native element the test must reach (`button`, `input`, `select`, `textarea`, `a`, …) and the attribute is meant to land on it — the wrapper is then the only way to hook that native element. On any other component selector (a feature/container component, a card, a list, `<ui-user-card data-test="...">`) it stays a finding: the tag is already a unique selector and the hook belongs on the native elements inside that component's own template.
- Static strings/constants are passed as plain attributes (`prop="value"`), not property bindings of a literal (`[prop]="'value'"`); `[...]` only for real expressions — with one exception: when an input name collides with a native HTML attribute (e.g. `title`), the binding form `[title]="'test'"` is required even for a literal, because plain `title="test"` also lands in the DOM as the native attribute and triggers unwanted browser behavior (a tooltip).
- Repeated markup between branches is extracted to `ng-template` + `[ngTemplateOutlet]` instead of being duplicated in `@if/@else`.
- Before adding new markup, an existing presentational or shared-library component is reused if one fits.
- Global utility classes are added only when they change something; no redundant classes.
- Interactive behavior sits on native elements (`<button type="...">`, `<a href>`); a `(click)` on a `<div>`/`<span>`/icon is a defect unless the element also provides `role`, `tabindex` and keyboard handling; every `<button>` declares an explicit `type` (`type="button"` unless it submits).
- Every `<img>` has an `[alt]` (empty `alt=""` only for decorative images); icon-only buttons carry an `aria-label` resolved from an i18n key.
- Every form control is programmatically labeled (`<label for>`, `aria-label` or `aria-labelledby`); dynamic ARIA state (`aria-expanded`, `aria-selected`, `aria-disabled`) is bound to the driving signal, not left static.
- Status and error messages the user must notice (save results, async failures) are announced to assistive technology — rendered through the shared alert/snackbar component or inside an `aria-live` region.
