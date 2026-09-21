---
name: Feature architecture
applies-to:
  - "!**/tsconfig*.json"
  - "!**/package*.json"
  - "!**/angular.json"
  - "!**/.eslintrc*"
  - "!**/eslint.config.*"
  - "!**/.prettierrc*"
  - "!**/karma.conf.*"
  - "!**/jest.config.*"
scopes:
  code: ["**/*.ts"]
  runtime: ["**/*.ts", "!**/models/**", "!**/*.spec.ts", "!**/index.ts"]
  markup: ["**/*.html"]
---
## Checklist
- {code} Every feature area keeps the canonical layout: `data-access/+state/` (actions, reducer, selectors, effects, facade + `tests/`), `data-access/services/` (HTTP only), `models/{consts,enums,interfaces,types}` with an `index.ts` barrel, `shared/{utils,guards,pipes,directives[,routes]}` each with `tests/`, `components-<area>/{feature,ui}/`, and for multi-step wizards a `shell/<area>-shell.routes.ts`. HTTP interceptors are app-level, never inside an area.
- {runtime} The root store stays empty: every feature registers its slice lazily on its route via `provideState(featureKey, reducer)` + `provideEffects([...])` + the facade in the route `providers` array.
- {runtime} Facade and effects classes are `@Injectable()` **without** `providedIn: 'root'` — each route gets a fresh instance and fresh state.
- {runtime} Layering is strict: components touch state only through a facade; selectors compute every derived value; effects orchestrate side effects and are the only consumers of HTTP services; HTTP services only perform requests.
- {runtime} Components never inject the store, never import actions or selectors, and never call HTTP services directly (the shared aggregate-form-validity service is the only allowed service injection in a feature component).
- {code, markup} Every file lives in its dedicated location: types/enums/consts in `models/`, pure functions in `shared/utils/`, guards in `shared/guards/`, pipes in `shared/pipes/`, directives in `shared/directives/`, HTTP in `data-access/services/`, state files in `data-access/+state/`; next to a component file only `*.component.*` files and a `tests/` folder are allowed.
- {code} An `index.ts` barrel is allowed ONLY in `models/`. Everywhere else — `shared/` included, whatever it re-exports — a barrel `index.ts` is forbidden: it bundles guards, utils, routes and directives into one import surface, so every consumer drags the whole folder into its bundle, the import path stops naming the layer it depends on, and a `@defer`-loaded target reached through it lands in the eager bundle anyway. Consumers import the concrete file (`shared/utils/build-user-table.util`, `shared/guards/users-loaded.guard`).
- {code} Import FORM is checked on every import, not just its direction: an area's models are imported from outside `models/` only through the `models/` barrel (never a concrete `models/interfaces/x.interface` path), while everything else is imported from its concrete file — binding a consumer to the models folder structure makes every model move a repo-wide edit. This item is evaluated for every file that imports anything, whatever folder that file sits in.
- {code, markup} Reuse before creating: nothing new (component, native-element markup, util, function, model, mapper, const, i18n key) is written before the shared library and the application have been SEARCHED for an equivalent — it usually already exists. The search is part of the change, not an optional courtesy: a hand-written table, input, button, dialog, tooltip or pagination, a util re-implementing a shared builder or ID generator, a second const/i18n key for a value already named somewhere — each is a finding that names the existing symbol to use instead. Only when the search genuinely comes back empty is a new element created, and then in the shared place its consumers can reach.
- {runtime} `resource()`/`httpResource()` never fetch feature-slice data: an area's server state travels the canonical path (component → facade → action → effect → HTTP service → reducer), so a resource in a feature component is the same layering violation as injecting `HttpClient` there. They are allowed exactly where a `signalStore()` is — self-contained local UI state (a dialog, an embedded picker, a typeahead whose result never leaves the component) — and their reads follow the performance instruction's `hasValue()` rule.
- New code follows these instructions, not the shape of neighbouring legacy code; scaffolding/generator output is conformed to these rules before commit.
- {runtime} Self-contained local state (dialogs, embedded browsers) uses an `@ngrx/signals` `signalStore()` provided in `@Component.providers` — composed with `withState`/`withComputed`/`withMethods` and mutated only through `patchState`; a hand-rolled `BehaviorSubject`/`Subject` service is not an acceptable component store. Feature-slice state is never component-scoped.
