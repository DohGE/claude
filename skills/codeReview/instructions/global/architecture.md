---
name: Feature architecture
---
## Checklist
- Every feature area keeps the canonical layout: `data-access/+state/` (actions, reducer, selectors, effects, facade + `tests/`), `data-access/services/` (HTTP only), `models/{consts,enums,interfaces,types}` with an `index.ts` barrel, `shared/{utils,guards[,routes]}` each with `tests/`, `components-<area>/{feature,ui}/`, and for multi-step wizards a `shell/<area>-shell.routes.ts`.
- The root store stays empty: every feature registers its slice lazily on its route via `provideState(featureKey, reducer)` + `provideEffects([...])` + the facade in the route `providers` array.
- Facade and effects classes are `@Injectable()` **without** `providedIn: 'root'` — each route gets a fresh instance and fresh state.
- Layering is strict: components touch state only through a facade; selectors compute every derived value; effects orchestrate side effects and are the only consumers of HTTP services; HTTP services only perform requests.
- Components never inject the store, never import actions or selectors, and never call HTTP services directly (the shared aggregate-form-validity service is the only allowed service injection in a feature component).
- Every file lives in its dedicated location: types/enums/consts in `models/`, pure functions in `shared/utils/`, guards in `shared/guards/`, HTTP in `data-access/services/`, state files in `data-access/+state/`; next to a component file only `*.component.*` files and a `tests/` folder are allowed.
- Reuse before creating: check for an existing shared/library component, util, model, mapper or i18n key before adding a new one; shared builders and ID generators are defined once and reused, never re-implemented inline.
- New code follows these instructions, not the shape of neighbouring legacy code; scaffolding/generator output is conformed to these rules before commit.
- Self-contained local state (dialogs, embedded browsers) may use a component-scoped store service provided in `@Component.providers`; feature-slice state never is.
