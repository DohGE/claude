---
name: HTTP service
applies-to:
  - "**/data-access/services/*.service.ts"
  - "**/data-access/services/**/*.service.ts"
  - "!**/*.spec.ts"
gate: the file is an HTTP layer - it injects an HTTP client (`HttpClient`) or its methods execute REST requests - or it is the spec of such a service. A service in this folder that performs no request is an architecture finding (wrong location), never a set of HTTP-service findings
scopes:
  spec: ["**/data-access/services/*.service.spec.ts", "**/data-access/services/**/*.service.spec.ts"]
---
## Checklist
- The service is a thin HTTP layer — the only place in the area executing REST requests — injected **exclusively by effects**; never used by components, facades, reducers or selectors.
- File is `<area>/data-access/services/<area>.service.ts`; class `<PascalCaseArea>Service` with `@Injectable({ providedIn: 'root' })`.
- A module-level, non-exported `const endpoints = {...}` holds every URL: static paths as strings; dynamic paths as functions with typed parameters returning template literals; URL interpolation happens **only** inside `endpoints`. The keys are short and camelCase — but like the paths themselves, their naming is out of review scope and is never reported.
- No hard-coded base URL: an endpoint value never carries a protocol + domain (`https://api.example.com/...`), `localhost` or an IP with a port — paths stay relative and the dev proxy decides the target. The path text itself is out of review scope: its segments, wording, casing, versioning, leading/trailing slash, key name and any change to it are never reported (the backend contract owns them); the real backend path is kept as-is, a uniform prefix is not forced.
- `HttpClient` is injected as `private readonly _http = inject(HttpClient)` in new services (legacy constructor injection is tolerated until refactor).
- Every method returns the endpoint response interface explicitly (`Observable<UserResponse>`) straight from a typed `_http.<verb><T>(...)` call; arguments are typed with the endpoint request interfaces from `models/`.
- No `.pipe(...)`, `map`, `tap`, `catchError` or `subscribe()` in methods — mapping belongs to reducers/selectors, error handling to effects (the only tolerated exception, justified in the PR, is unwrapping an internal `{ data, meta }` envelope).
- Method names are `<verb><Subject>`: GET→`load`, POST→`create`/`search`, PUT→`edit`/`update`, PATCH→`patch`, DELETE→`remove`; optional flags use default parameter values (`= false`), not `?` + `??`; query params go in the options object (`{ params }`).
- One endpoint function may serve several HTTP verbs on the same URL — the `endpoints` entry is not duplicated.
- No sensitive values (tokens, credentials, PII) in URL paths or query params — they land in server logs and browser history; opaque identifiers only. Auth headers come from the global interceptor, never set per request.
- The response generic is an honest contract: `_http.get<UserResponse>(...)` asserts, it does not validate — a new or changed endpoint response interface is verified against the real API contract (field names, casing, nullability) instead of being guessed.
- Forbidden: injecting the store, cross-area services, keeping state, composing requests (`forkJoin` belongs to effects), `firstValueFrom`/`lastValueFrom`, logging, declaring local interfaces, HTTP interceptors (global ones already apply).
- `resource()`/`httpResource()` have no home in this architecture — components never fetch, and effects own cancellation and error handling; requests stay `HttpClient` here and reach the component through the store. Their absence is never reported as a modernization gap.
- {+spec} No unit tests for a service that only wraps HTTP calls (it is covered through the effects spec); a dedicated spec exists only when the service transforms data — which itself signals the service does too much.
