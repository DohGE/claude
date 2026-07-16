---
name: Angular component (common)
applies-to:
  - "**/*.component.ts"
---
## Checklist
- `changeDetection: ChangeDetectionStrategy.OnPush` is set — no exceptions.
- Template and styles are separate files referenced by `templateUrl` and exactly one of `styleUrl`/`styleUrls`; every component has its own `.scss` file, even an empty one.
- The `imports` array matches the template exactly, verified in BOTH directions: every imported entry is used by the template (nothing speculative), AND every external symbol the template uses has its entry — component/directive selectors, pipe names, `[formControl]`/`formGroup` → `ReactiveFormsModule`, `[(ngModel)]` → `FormsModule`, `ngSrc` → `NgOptimizedImage`. A missing entry breaks the template at runtime — report from this consequence.
- Injected fields are `private readonly _camelCase`; the field name is the full descriptive name derived from the injected type (keeping the feature/area part of the class name), never shortened to a generic role name. (`inject()`-only DI, the signal input/output API and `host: {}` bindings are governed by the global best-practices instruction.)
- An input the component cannot render without is `input.required<T>()` — no `!` definite-assignment tricks and no fake defaults that mask a missing binding.
- Every signal, `computed()`, enum/const alias and arrow-function field is `readonly`.
- Enum/const aliases exposed for the template keep the enum name in camelCase (`readonly buttonStyle = ButtonStyle`) — the alias name is never changed.
- Local state uses `signal()` (never a subject or a field with a setter); mutations only via `.set()`/`.update()`.
- Derived values that can be computed from store state are added as selectors, not computed in the component; `computed()` is reserved for purely presentational composition (e.g. building table UI data from an input signal).
- Member order is fixed: `inject()` fields → re-exported facade/input signals → `computed()` → enum/const aliases → `dataTestPrefix` and const UI helpers → form definition → `constructor` → arrow `compareWith*` fields → lifecycle hooks → public handlers.
- The constructor contains only `effect()` calls; loads, dispatches and subscriptions belong to `ngOnInit`.
- `effect()` is used only for: propagating state to a layout/parent, state→form `patchValue(..., { emitEvent: false })`, enabling/disabling the form from a lock signal (also with `{ emitEvent: false }`), or reacting to a signal change by calling a facade method; never for writing other signals, logging, or replicating `computed()`.
- Reactive forms are built with `_fb.nonNullable.group({...})`; every control has an explicit generic type and is seeded from the relevant signal; validators are declared in the form definition.
- Validators changed at runtime (`addValidators`/`removeValidators`/`setValidators`) are followed by `updateValueAndValidity()` on the affected control — otherwise the control keeps its stale validity.
- Form→state: `valueChanges` subscription with `takeUntilDestroyed(...)`; whole-form emissions are deduplicated with `distinctUntilChanged((a, b) => isEqual(a, b))` using `isEqual` from `es-toolkit`.
- State→form: an `effect()` calling `patchValue`/`setValue` with `{ emitEvent: false }` — omitting the flag creates a feedback loop with the subscription.
- Every subscription is cleaned up exclusively with `takeUntilDestroyed()` (outside the constructor pass `DestroyRef`); no manual `Subject`, `Subscription`, `takeUntil(this._ngUnsubscribe$)` or unsubscribe-base-class patterns.
- `ngOnDestroy` does not exist; a flush-on-exit (persisting aggregated values when leaving a step) uses `inject(DestroyRef)` + `_destroyRef.onDestroy(() => ...)`.
- No direct `document`/`window`/`ElementRef.nativeElement` DOM reads or writes in the constructor or `ngOnInit`; browser-only work (focus, measurement, third-party widget init) runs in `afterNextRender`/`afterEveryRender`.
- `compareWith*` fields are readonly arrow functions, null-safe (`?.`), returning `boolean`.
- A `dataTestPrefix` const is defined and used for `data-test` attributes on interactive elements.
- The `dataTestPrefix` value is a stable descriptive name of the component, never the component selector — selectors may change and would break the test hooks.
- Single `as Type` casts only where required; no double casting where a single cast suffices.
- When an edit touches ≥30% of a component or the component is small (≤150 lines), the whole component is refactored to these rules.
