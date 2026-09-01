---
name: Angular & TypeScript best practices
---
This instruction OWNS the framework-level API rules: typing, the signals API, DI, standalone declarables,
host bindings, lazy routes, the forms pattern and RxJS usage. File placement, member order and template
rules belong to the component and component-template instructions; rendering cost and change detection to
the performance instruction. A violation is reported ONCE, under the most specific instruction covering it.

## Checklist
- Strict typing everywhere: no `any` (use `unknown` plus narrowing when the shape is genuinely uncertain); prefer inference for primitive values when the type is obvious; exported functions, service methods and component inputs/outputs have explicit types.
- Type annotations earn their place: annotate where inference is absent or wrong — an empty literal (`const items: Item[] = []`, `signal<Item[]>([])`), a `null`/`undefined` seed, an object literal assembled field-by-field against a domain interface, and the parameters plus return type of every exported function, service method and util. Never annotate what the call already types (`inject()`, `signal()`/`computed()`/`toSignal()`, `_fb.nonNullable.group(...)`, `createSelector(...)`, `as const`, any variable initialized from a typed call) — a redundant annotation is boilerplate under the code-quality instruction.
- Standalone components/directives/pipes only — no new `NgModule`s; `standalone: true` is never written explicitly (it is the framework default).
- Signals are the primary reactive primitive: `signal()` for local state, `computed()` for derived state, `input()`/`input.required()`/`output()`/`model()` for the component API — never `@Input()`/`@Output()` decorators or `@Input() set` accessors; state updates only via `.set()`/`.update()` with pure transformations, never mutation of the stored object/array.
- View and content queries use the signal functions `viewChild()`/`viewChild.required()`/`viewChildren()`/`contentChild()`/`contentChildren()` — never the `@ViewChild`/`@ViewChildren`/`@ContentChild`/`@ContentChildren` decorators, and never `{ static: true }` (signal queries resolve without it).
- `ngOnChanges` does not exist in a component with signal inputs: reacting to an input is `computed()` (derived), `linkedSignal()` (derived but locally resettable) or `effect()` (side effect) — `ngOnChanges` re-introduces the string-keyed `SimpleChanges` bag the signal API replaced.
- `effect()` takes no `allowSignalWrites` option — it stopped doing anything in v19 and left the options type in v20, so an `{ allowSignalWrites: true }` in the diff is dead config carried over from older code (whether the effect should write a signal at all is the performance instruction's rule).
- `model()` is only for state the parent genuinely binds two-way with `[(x)]` — a value the child edits and the parent owns; one-way data plus a notification stays `input()` + `output()`, and a `model()` nobody binds with the banana box is just a writable signal published on the public surface.
- A writable signal is never exposed on a public surface: components, stores and services expose `signal.asReadonly()` or a `computed()`, keeping `.set()`/`.update()` with the owner.
- `output()` names are past-tense events without an `on` prefix (`saved`, not `onSave`) and never reuse a native DOM event name (`click`, `change`, `input`, `focus`, `select`) — a colliding name makes the native bubbling event and the output indistinguishable at the call site.
- Input coercion uses `transform: booleanAttribute` / `numberAttribute` / a pure function in `input(..., { transform })` — never a setter and never coercion inside the consuming `computed()`.
- Observables consumed by templates are converted once with `toSignal()` in the class; the `async` pipe is not used (project convention — see the component template instruction).
- `toSignal()` declares `initialValue` or `requireSync: true`; without either the signal type is `T | undefined` and every template read silently widens — an unhandled `undefined` frame is a finding.
- Dependency injection only through `inject()`, and only in an injection context (field initializers, constructor, provider/guard factories) — calling `inject()` inside methods, subscriptions or async callbacks is a runtime error (NG0203).
- Host bindings and listeners go into the `host: {}` object of the decorator — never `@HostBinding`/`@HostListener`.
- Feature routes are lazy (`loadComponent`/`loadChildren`); a new eager import of a feature area into the root/shell bundle is a finding.
- Singleton services use `@Injectable({ providedIn: 'root' })`; route-scoped provisioning of facades and effects is governed by the architecture instruction.
- Forms follow the project's typed reactive-forms pattern (`_fb.nonNullable.group`, explicit control generics) — no template-driven forms, no `UntypedFormControl`/`UntypedFormGroup` or `any`-typed controls.
- Static images use `NgOptimizedImage` (`ngSrc`) — not applicable to inline base64 images.
- Accessibility is a review criterion: new or changed UI must satisfy WCAG 2.2 level AA; the concrete checks and their severity live in the global accessibility instruction, which owns every accessibility finding.
- RxJS operators are imported from `rxjs`, never from `rxjs/operators` (deprecated since 7.2); `toPromise()` is never used (`firstValueFrom`/`lastValueFrom` where a promise is genuinely required, and neither belongs in an HTTP service).
- No `subscribe()` inside a `subscribe()` — compose with `switchMap`/`concatMap`/`mergeMap`; the nested form leaks the inner subscription past every teardown operator on the outer one.
- A suppression comment added by the diff (`@ts-ignore`, `@ts-expect-error`, `eslint-disable*`) carries a one-line justification and the narrowest scope that works (line-level over file-level); `@ts-expect-error` is used wherever it compiles, because it fails once the underlying problem is fixed. The `/* eslint-disable @typescript-eslint/member-ordering */` allowed by the effects instruction is the one standing exception.
- Components stay small and single-responsibility (file separation TS/HTML/SCSS is enforced by the component instruction).
