---
name: NgRx facade
applies-to:
  - "**/*.facade.ts"
---
## Checklist
- File lives in `<area>/data-access/+state/<area>.facade.ts`; class `<PascalCaseArea>Facade` with `@Injectable()` **without** `providedIn: 'root'`; provided in the route `providers`, never globally and never in `@Component.providers`.
- The store is the base dependency: `private readonly _store = inject(Store)`; additional dependencies only when justified (e.g. the shared wait-until-effect-completes helper) — coordination otherwise belongs in effects.
- Every exposed signal is `readonly <name> = this._store.selectSignal(query.select<Name>)`; the signal name equals the selector name without the `select` prefix; only selectors actually consumed by components/effects are exposed.
- Every action is exposed as a method: name = the action verb phrase in camelCase; return type `void`; the body is exactly one `this._store.dispatch(actions.x({ ...shorthand payload }))` — no `if`s, no multi-dispatch, no transformations.
- Method parameters are positional and map 1:1 to the action props (no destructured object parameter; a single domain-typed argument is the exception); nullable parameters are typed `| null`, not `?`.
- Exception: a method may return an `Observable` when it uses the shared wait-until-effect-completes service (dispatch, then wait for the success/fail action and map its payload).
- A parameterized selector may be exposed as a `readonly x$ = (arg) => this._store.select(query.selectX(arg))` field for save flows; otherwise no `select()` observables in the public API.
- No `computed()` on facade signals inside the facade (derivation belongs to selectors or the consuming component) and no local caching of signals.
- Signal order is thematic and mirrors the query objects without interleaving: loading flags → input collections → derived flags → per-wizard-step → summary → edit mode; methods follow the same order.
- Actions and selectors are never exposed directly — components see only signals and methods.
