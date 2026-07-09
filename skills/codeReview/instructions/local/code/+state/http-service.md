---
name: HTTP service
applies-to:
  - "**/data-access/services/*.service.ts"
  - "**/data-access/services/**/*.service.ts"
---
## Checklist
- The service is a thin HTTP layer — the only place in the area executing REST requests — injected **exclusively by effects**; never used by components, facades, reducers or selectors.
- File is `<area>/data-access/services/<area>.service.ts`; class `<PascalCaseArea>Service` with `@Injectable({ providedIn: 'root' })`.
- A module-level, non-exported `const endpoints = {...}` holds every URL: short camelCase keys; static paths as strings; dynamic paths as functions with typed parameters returning template literals; URL interpolation happens **only** inside `endpoints`.
- No hard-coded base URL and no leading slash — paths are relative and the dev proxy decides the target; the real backend path is kept as-is (a uniform prefix is not forced).
- `HttpClient` is injected as `private readonly _http = inject(HttpClient)` in new services (legacy constructor injection is tolerated until refactor).
- Every method returns an explicit `Observable<DTO>` straight from a typed `_http.<verb><T>(...)` call; arguments are typed with DTO interfaces from `models/`.
- No `.pipe(...)`, `map`, `tap`, `catchError` or `subscribe()` in methods — mapping belongs to reducers/selectors, error handling to effects (the only tolerated exception, justified in the PR, is unwrapping an internal `{ data, meta }` envelope).
- Method names are `<verb><Subject>`: GET→`load`, POST→`create`/`search`, PUT→`edit`/`update`, PATCH→`patch`, DELETE→`remove`; optional flags use default parameter values (`= false`), not `?` + `??`; query params go in the options object (`{ params }`).
- One endpoint function may serve several HTTP verbs on the same URL — the `endpoints` entry is not duplicated.
- Forbidden: injecting the store, cross-area services, keeping state, composing requests (`forkJoin` belongs to effects), `firstValueFrom`/`lastValueFrom`, logging, declaring local interfaces, HTTP interceptors (global ones already apply).
- No unit tests for a service that only wraps HTTP calls (it is covered through the effects spec); a dedicated spec exists only when the service transforms data — which itself signals the service does too much.
