---
name: NgRx effects
applies-to:
  - "**/*.effects.ts"
---
## Checklist
- File lives in `<area>/data-access/+state/`; class `<PascalCaseArea>Effects` with `@Injectable()` **without** `providedIn: 'root'`; registered through `provideEffects([...])` on the route; `/* eslint-disable @typescript-eslint/member-ordering */` at the top is allowed.
- Dependencies via `inject()` as `private readonly _camelCase`; the action stream is `_actions$ = inject(Actions)`; every effect field is camelCase with a `$` suffix.
- Canonical HTTP effect: `ofType → switchMap → service call → map(success) / catchError(fail)`; `catchError` sits **inside** the flattening operator and returns `of(failAction)` — outside it kills the stream after the first error.
- Flattening operator choice: `switchMap` is the default (cancel previous); `mergeMap` for parallel bulk operations; `concatMap` when order is critical; `exhaustMap` to ignore repeat triggers until completion.
- State lookups use `concatLatestFrom` from `@ngrx/operators` (never `withLatestFrom`); it may take an array of selectors and may call a payload-parameterized selector.
- An effect that dispatches nothing declares `{ dispatch: false }` as the second `createEffect` argument.
- `tap` is only for side effects (alerts, events, closing dialogs, notifying shared services) and never changes stream data; related side effects share one `tap`; branching that picks the resulting action happens in `map`, with every branch returning an explicit action.
- Effects triggered by cross-area/layout actions start with a `filter(...)` narrowing to their own area/step — otherwise every sibling area reacts to foreign events.
- A `filter` after `concatLatestFrom` guards on state; when `0` is a valid value the check is an explicit `=== 0`/`!== null`, not truthiness.
- Polling: outer `switchMap` over `timer(0, <interval from the central app config>)`, inner `switchMap` for the request, `takeUntil(this._stop$)` closing the inner pipe; `_stop$` is a `private readonly Subject<void>`; a separate `{ dispatch: false }` effect calls `_stop$.next()` on the stop and fail actions; intervals are never hard-coded.
- Multiple resulting actions are returned as an action array from one effect (branches unified with `of(action)` vs `[a, b]`) — not via `forkJoin` or duplicated effects.
- Identical reactions to several actions are merged into one `ofType(a, b, c)`; the source is distinguished with `action.type === x.type` or `'prop' in action` type-narrowing.
- Dialogs: `dialog.open<Component, Data, Result>(...)` always with all three generics; `afterClosed()` inside `switchMap`; cancellation is rejected with `filter((result): result is T => !!result)` before `map` (the predicate also removes the union with `null`/`false` without casting).
- Bridging a dialog's outputs into actions may `merge(...)` the `afterClosed()` mapping with component-output streams, each guarded by `takeUntil(dialogRef.afterClosed())`.
- Pure composition helpers (type guards, DTO mapping, chain building) are module-level functions below the class; a private method is used only when it calls injected services; feature-flag branching is a `filter` in the pipe, not an `if` in `map`.
- Forbidden: injecting a facade, `store.dispatch(...)` inside an effect (new actions are returned), manual `subscribe()`, mutating action payloads, a global `catchError`, domain logic inside `tap`, `Date.now()`/`Math.random()` in success payloads.
