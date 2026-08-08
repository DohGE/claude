---
name: HTTP interceptors
applies-to:
  - "**/*.interceptor.ts"
---
## Checklist
- The export is a functional `const <purpose>Interceptor: HttpInterceptorFn`, registered through `provideHttpClient(withInterceptors([...]))` — never a class implementing `HttpInterceptor` with the `HTTP_INTERCEPTORS` multi-provider.
- The file lives in the app-level interceptors location, never inside a feature area — an interceptor applies to every request by definition, so an area-scoped one is a layering violation.
- Dependencies come from `inject()` inside the interceptor body; the interceptor holds no mutable module-level state.
- The request is never mutated: modifications go through `req.clone({ ... })` and the clone is what reaches `next(...)`.
- Every path returns the `next(...)` stream — an interceptor never subscribes, never converts to a promise, and never terminates the chain silently.
- Errors are re-thrown or mapped to a typed failure (`throwError(() => ...)`); an interceptor never swallows a failure, never renders UI and never dispatches store actions for domain errors (that is the effect's job).
- No request/response body or header is logged; `Authorization` and cookies are attached only for the app's own API origin (security instruction).
- Retry/refresh logic is bounded — an explicit attempt count, no recursive re-entry into the same interceptor, and a token refresh shared across in-flight requests rather than fired once per request.
- Every interceptor has a spec in the sibling `tests/` folder, exercised through `TestBed.runInInjectionContext` with `HttpTestingController`, covering the pass-through path and every error branch.
