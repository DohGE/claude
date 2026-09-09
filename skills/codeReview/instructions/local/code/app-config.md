---
name: Application configuration & bootstrap
applies-to:
  - "**/app.config.ts"
  - "**/app.config.*.ts"
  - "**/main.ts"
  - "**/main.*.ts"
---
## Checklist
- Bootstrap is `bootstrapApplication(App, appConfig)` with a flat `providers` array — no root `NgModule`, no `platformBrowserDynamic()`.
- `provideHttpClient(withFetch(), withInterceptors([...]))`: `withFetch()` is declared (SSR and `resource`-based APIs depend on it), interceptors are the functional ones, and `withNoXsrfProtection()` is forbidden (security instruction).
- `provideRouter(routes, withComponentInputBinding(), ...)`; feature areas are referenced through `loadChildren`/`loadComponent`, never imported eagerly (architecture instruction).
- `importProvidersFrom(...)` is a last resort for libraries that ship no standalone provider function, and stays one call per library; why the library cannot be provided the standalone way belongs in the PR description, not in a comment.
- The root `provideStore` declares `runtimeChecks` with `strictStateImmutability`, `strictActionImmutability`, `strictStateSerializability`, `strictActionSerializability` and `strictActionTypeUniqueness` enabled — they are what turns a silent state mutation or a duplicated action type into a failing dev build instead of a production bug, and NgRx strips them from production builds anyway. `strictActionWithinNgZone` belongs only to a zone-based app: under `provideZonelessChangeDetection()` every dispatch trips it.
- The root store stays empty: a root `provideStore({})`/`provideEffects()` registers no feature slice — slices are provided on their route (architecture instruction).
- A zoneless application uses `provideZonelessChangeDetection()` (v20+) AND removes `zone.js` from `polyfills` — the provider together with a live `zone.js` polyfill is a finding; a project deliberately still on zone.js is not reported for that alone.
- Unhandled errors reach one place: `provideBrowserGlobalErrorListeners()` (v20+) and/or a project `ErrorHandler` is registered, and it does not log tokens, credentials or PII (security instruction).
- Animations are provided asynchronously (`provideAnimationsAsync()`) when they are needed at all; new animation work prefers native CSS transitions and view transitions over the `@angular/animations` DSL.
- Configuration values (API base paths, intervals, debounce times, feature flags) come from the central app config token — no inline URLs, no `process.env` reads, no secrets (security instruction).
