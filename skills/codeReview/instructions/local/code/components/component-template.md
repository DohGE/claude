---
name: Component template
applies-to:
  - "**/*.component.html"
---
## Checklist
- Only native control flow: `@if/@else`, `@for`, `@switch`, `@let` — never `*ngIf`, `*ngFor`, `*ngSwitch` or `*ngVar`.
- `@let` declarations at the top of the template unpack `computed()`/signal values that are used more than once.
- Every `@for` tracks by a stable unique identifier (`track item.id`); `track item` (reference identity) on object collections is a defect, and `track $index` is allowed only for static, never-reordered lists.
- Class and style bindings use `[class.x]` / `[style.x.px]` — never `ngClass`/`ngStyle`.
- No `async` pipe — observables are converted with `toSignal()` in the component and the template reads the signal.
- Every user-facing string goes through the translate pipe (`{{ 'key' | translate }}`), including parameterized texts (`| translate : { param }`); zero hard-coded texts.
- A translation containing HTML markup is rendered with `[innerHTML]="'key' | translate"`, not interpolation — and `[innerHTML]` is used for nothing else: never bound to user-/API-derived values or concatenated HTML (see the security instruction).
- Bindings and interpolations read signals, `computed()` values and pure pipes — no component method calls inside property/interpolation bindings (function references passed uninvoked, e.g. `[compareWith]="compareWithId"`, are fine).
- Every interactive native element carries `[attr.data-test]="dataTestPrefix + '<element-name>'"` (or a plain `data-test` attribute when the prefix is constant); `data-test` is never put on a component host tag (e.g. `<ui-user-card data-test="...">`) — the tag itself is already a unique selector, the test hook belongs on the native elements inside that component's own template.
- Static strings/constants are passed as plain attributes (`prop="value"`), not property bindings of a literal (`[prop]="'value'"`); `[...]` only for real expressions — with one exception: when an input name collides with a native HTML attribute (e.g. `title`), the binding form `[title]="'test'"` is required even for a literal, because plain `title="test"` also lands in the DOM as the native attribute and triggers unwanted browser behavior (a tooltip).
- Repeated markup between branches is extracted to `ng-template` + `[ngTemplateOutlet]` instead of being duplicated in `@if/@else`.
- Before adding new markup, an existing presentational or shared-library component is reused if one fits.
- Global utility classes are added only when they change something; no redundant classes.
- Interactive behavior sits on native elements (`<button type="...">`, `<a href>`); a `(click)` on a `<div>`/`<span>`/icon is a defect unless the element also provides `role`, `tabindex` and keyboard handling.
- Every `<img>` has an `[alt]` (empty `alt=""` only for decorative images); icon-only buttons carry an `aria-label` resolved from an i18n key.
- Every form control is programmatically labeled (`<label for>`, `aria-label` or `aria-labelledby`); dynamic ARIA state (`aria-expanded`, `aria-selected`, `aria-disabled`) is bound to the driving signal, not left static.
- Status and error messages the user must notice (save results, async failures) are announced to assistive technology — rendered through the shared alert/snackbar component or inside an `aria-live` region.
