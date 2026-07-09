---
name: Performance & change detection
---
## Checklist
- Every value read by a template is a signal (`signal`/`computed`/`input`/facade signal) — a plain mutable class field bound in the template is a defect under OnPush/zoneless (the UI silently goes stale when the field changes).
- Template expressions are cheap: no non-trivial method calls and no objects/arrays/`new Date()` rebuilt on every check inside bindings; derivations go through `computed()`, selectors or pure pipes.
- `toSignal()`/`toObservable()` are called once, as field initializers — never inside methods, getters, `computed()` or `effect()` (every call creates a new subscription).
- No `ngDoCheck`, `ngAfterContentChecked` or `ngAfterViewChecked` hooks (they run on every change-detection cycle); no state mutation inside `ngAfterViewInit`/`ngAfterContentInit` (ExpressionChangedAfterItHasBeenChecked).
- `effect()` never writes signals to emulate derivation — derived state is `computed()`; dependent-but-locally-resettable state is `linkedSignal()`.
- `resource`/`httpResource` reads are guarded with `hasValue()` before `.value()` (an errored resource throws on read); a resource depending on another resource uses `chain` in `params` instead of reading `.value()` directly.
- Each cold HttpClient observable is subscribed once per intended request — re-subscribing the same stream fires duplicate backend requests.
- `@defer` blocks: above-the-fold/LCP content is not deferred (layout shift); nested `@defer` blocks use different triggers (no cascading simultaneous loads); the deferred component is imported from its concrete file, never through a barrel `index.ts` (a barrel import keeps it in the main bundle); `viewport`/`interaction`/`hover` triggers have a `@placeholder` with a single root element.
- Images: the LCP/hero image is marked `priority`; every `ngSrc` image declares `width` + `height` (or `fill` with a positioned parent) so it cannot shift layout.
- Long-lived async work is bounded: polling/intervals take their period from the central app config and are explicitly stopped — no unbounded `setInterval`/`timer` outliving its view or effect.
- SSR/hydration-enabled apps only: no `window`/`document`/browser globals in constructors or field initializers — browser-only work runs in `afterNextRender`/`afterEveryRender` and the document comes from `inject(DOCUMENT)`; server and client render identical markup (no `isPlatformBrowser` branches in templates — hydration mismatch); markup stays hydration-valid (explicit `<tbody>` in tables, no `<div>` inside `<p>`, no nested `<a>`); `ngSkipHydration` only as a justified last resort.
