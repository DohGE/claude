---
name: Component template
applies-to:
  - "**/*.component.html"
---
## Checklist
- Only native control flow: `@if/@else`, `@for`, `@switch`, `@let` — never `*ngIf`, `*ngFor`, `*ngSwitch` or `*ngVar`.
- `@let` declarations at the top of the template unpack `computed()`/signal values that are used more than once.
- Every `@for` has a `track` expression.
- Class and style bindings use `[class.x]` / `[style.x.px]` — never `ngClass`/`ngStyle`.
- No `async` pipe — observables are converted with `toSignal()` in the component and the template reads the signal.
- Every user-facing string goes through the translate pipe (`{{ 'key' | translate }}`), including parameterized texts (`| translate : { param }`); zero hard-coded texts.
- A translation containing HTML markup is rendered with `[innerHTML]="'key' | translate"`, not interpolation.
- Every interactive element carries `[attr.data-test]="dataTestPrefix + '<element-name>'"` (or a plain `data-test` attribute when the prefix is constant).
- Static strings/constants are passed as plain attributes (`prop="value"`), not property bindings of a literal (`[prop]="'value'"`); `[...]` only for real expressions.
- Repeated markup between branches is extracted to `ng-template` + `[ngTemplateOutlet]` instead of being duplicated in `@if/@else`.
- Before adding new markup, an existing presentational or shared-library component is reused if one fits.
- Global utility classes are added only when they change something; no redundant classes.
