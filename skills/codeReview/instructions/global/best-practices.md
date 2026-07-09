---
name: Angular & TypeScript best practices
---
## Checklist
- Strict typing everywhere: no `any` (use `unknown` plus narrowing when the shape is genuinely uncertain); prefer inference when the type is obvious; exported functions, service methods and component inputs/outputs have explicit types.
- Standalone components/directives/pipes only — no new `NgModule`s; `standalone: true` is never written explicitly (it is the framework default).
- Signals are the primary reactive primitive: `signal()` for local state, `computed()` for derived state, `input()`/`input.required()`/`output()`/`model()` for the component API — never `@Input()`/`@Output()` decorators; state updates only via `.set()`/`.update()` with pure transformations, never mutation of the stored object/array.
- Observables consumed by templates are converted once with `toSignal()` in the class; the `async` pipe is not used (project convention — see the component template instruction).
- Dependency injection only through `inject()`, and only in an injection context (field initializers, constructor, provider/guard factories) — calling `inject()` inside methods, subscriptions or async callbacks is a runtime error (NG0203).
- Host bindings and listeners go into the `host: {}` object of the decorator — never `@HostBinding`/`@HostListener`.
- Templates use native control flow (`@if`, `@for`, `@switch`) — never `*ngIf`/`*ngFor`/`*ngSwitch`; classes and styles via `[class.x]`/`[style.x]` bindings — never `ngClass`/`ngStyle`.
- Feature routes are lazy (`loadComponent`/`loadChildren`); a new eager import of a feature area into the root/shell bundle is a finding.
- Singleton services use `@Injectable({ providedIn: 'root' })`; route-scoped classes (facades, effects) are `@Injectable()` **without** `providedIn` and are provided on the route — see the architecture instruction.
- Forms follow the project's typed reactive-forms pattern (`_fb.nonNullable.group`, explicit control generics) — no template-driven forms, no `UntypedFormControl`/`UntypedFormGroup` or `any`-typed controls.
- Static images use `NgOptimizedImage` (`ngSrc`) — not applicable to inline base64 images.
- Accessibility is a review criterion: new or changed UI must satisfy WCAG AA basics (focus management, color contrast, ARIA); the concrete template-level checks live in the component template instruction.
- Components stay small and single-responsibility; logic lives in the TS file, markup in the HTML file, styles in the SCSS file (separate files per project convention).
