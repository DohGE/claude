---
name: Component template
applies-to:
  - "**/*.component.html"
---
This instruction OWNS everything inside the template except accessibility, which is owned by the global
accessibility instruction (WCAG 2.2 AA — alternative texts, labels, ARIA, keyboard, focus, target size):
a template violation of those rules is reported there, once, never twice. `@defer` trigger and bundling
rules are owned by the performance instruction.

## Checklist
- Only native control flow: `@if/@else`, `@for`, `@switch`, `@let` — never `*ngIf`, `*ngFor`, `*ngSwitch` or `*ngVar`.
- `@let` declarations at the top of the template unpack `computed()`/signal values that are used more than once; `@let` is block-scoped, so a value needed only inside an `@if`/`@for` is declared inside that block, and it is never treated as a mutable variable — it re-evaluates with its expression.
- Every `@for` tracks by a stable unique identifier (`track item.id`); `track item` (reference identity) on object collections is a defect, and `track $index` is allowed only for static, never-reordered lists.
- Every `@for` over a collection that can be empty and is user-visible declares an `@empty` block — an empty list rendering as blank space is a defect, not a state.
- Every `@switch` covers its fallback with `@default`, including when the subject is an enum (a member added later must not render nothing).
- Every `@defer` block declares a `@placeholder`; `@loading` and `@error` are declared wherever the wait or the failure is user-visible.
- Class and style bindings use `[class.x]` / `[style.x.px]` — never `ngClass`/`ngStyle`.
- No `async` pipe — observables are converted with `toSignal()` in the component and the template reads the signal.
- Every user-facing string goes through the translate pipe (`{{ 'key' | translate }}`), including parameterized texts (`| translate : { param }`); zero hard-coded texts.
- A translation containing HTML markup is rendered with `[innerHTML]="'key' | translate"`, not interpolation — and `[innerHTML]` is used for nothing else: never bound to user-/API-derived values or concatenated HTML (see the security instruction).
- Bindings and interpolations read signals, `computed()` values and pure pipes — no component method calls inside property/interpolation bindings (function references passed uninvoked, e.g. `[compareWith]="compareWithId"`, are fine).
- Event bindings contain nothing but ONE call to one component handler (`(click)="onRowClick(item.id)"`). Never logic composed in the template: no `output.emit(...)`, no `$event.stopPropagation()`/`preventDefault()`, no `signal.set(...)`/`update(...)`, no assignment, no `&&`/ternary chain, no second statement after a `;`. The class handler does all of it and receives `$event` as an argument when it needs the event — template-composed logic lives outside the class, so no component spec can assert it and no reader of the class sees the emit or the stopped propagation.
- Every interactive native element carries `[attr.data-test]="dataTestPrefix + '<element-name>'"` (or a plain `data-test` attribute when the prefix is constant). On a component selector `data-test` is allowed only when that component is a wrapper around the native element the test must reach (`button`, `input`, `select`, `textarea`, `a`, …) and the attribute is meant to land on it — the wrapper is then the only way to hook that native element. On any other component selector (a feature/container component, a card, a list, `<ui-user-card data-test="...">`) it stays a finding: the tag is already a unique selector and the hook belongs on the native elements inside that component's own template.
- Static strings/constants are passed as plain attributes (`prop="value"`), not property bindings of a literal (`[prop]="'value'"`); `[...]` only for real expressions — with one exception: when an input name collides with a native HTML attribute (e.g. `title`), the binding form `[title]="'test'"` is required even for a literal, because plain `title="test"` also lands in the DOM as the native attribute and triggers unwanted browser behavior (a tooltip).
- Repeated markup between branches is extracted to `ng-template` + `[ngTemplateOutlet]` instead of being duplicated in `@if/@else`.
- Before adding new markup, the shared library and the application are searched for a component that already does it, and it is reused — something suitable usually exists. Raw native elements are the signal to look: a hand-built `<table>`, `<input>`/`<select>`/`<textarea>` (with its own label and error markup), `<button>`, dialog, tooltip or pagination is a finding whenever the design system ships the equivalent component; native tags stay only for structural markup nothing wraps (`<div>`, `<span>`, `<section>`, headings, lists) or where the checked library truly has no counterpart.
- Global utility classes are added only when they change something; no redundant classes.
- `[disabled]` is never bound on an element that also carries `formControl`/`formControlName`/`formGroupName` — Angular warns about it and the reactive control keeps its own disabled state, so the binding stops reflecting the expression after the first change and the field stays enabled (or stuck disabled) while the template claims otherwise; the lock comes from the class through `control.disable({ emitEvent: false })`/`enable(...)` (the lock-signal pattern of the component instruction). `[disabled]` on a plain button or a non-form input is untouched by this rule.
- A component or directive element that projects no content is self-closing (`<app-user-card [user]="user()" />`), not an empty tag pair.
- Loop metadata comes from the `@for` block itself — `$index`, `$count`, `$first`, `$last`, `$even`, `$odd` (aliased with `let idx = $index` where a nested block shadows them); a counter signal maintained next to the loop, or an index threaded down from the parent, is a finding.
- Every `<button>` declares an explicit `type` (`type="button"` unless it submits) — a missing `type` inside a form submits it (whether the element should be a `<button>` at all, and its labeling, belong to the accessibility instruction).
