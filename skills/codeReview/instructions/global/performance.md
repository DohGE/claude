---
name: Performance & change detection
applies-to:
  - "**/*.ts"
  - "**/*.html"
  - "!**/models/**"
  - "!**/*.spec.ts"
gate: the file holds Angular runtime code or a template - a component, directive, pipe, service, effect, store, config or bindings, not only type/const declarations or re-exports
scopes:
  ts: ["**/*.ts"]
  markup: ["**/*.html"]
---
## Checklist
- {ts, markup} Every value read by a template is a signal (`signal`/`computed`/`input`/facade signal) — a plain mutable class field bound in the template is a defect under OnPush/zoneless (the UI silently goes stale when the field changes).
- {markup} Template expressions are cheap: no objects/arrays/`new Date()` rebuilt on every check inside bindings; derivations go through `computed()`, selectors or pure pipes (method calls inside bindings are owned by the component-template instruction and reported there).
- {ts} `toSignal()`/`toObservable()` are called once, as field initializers — never inside methods, getters, `computed()` or `effect()` (every call creates a new subscription).
- {ts} No `ngDoCheck`, `ngAfterContentChecked` or `ngAfterViewChecked` hooks (they run on every change-detection cycle); no state mutation inside `ngAfterViewInit`/`ngAfterContentInit` (ExpressionChangedAfterItHasBeenChecked).
- {ts} `effect()` never writes signals to emulate derivation — derived state is `computed()`; dependent-but-locally-resettable state is `linkedSignal()`.
- {ts} No change-detection escape hatches: `ChangeDetectorRef.detectChanges()`/`markForCheck()`, `ApplicationRef.tick()`, `NgZone.run()`/`runOutsideAngular()`, or a `setTimeout`/`Promise.resolve()` whose only purpose is making the view update. Under OnPush + signals the notification IS the signal write — an escape hatch means state lives somewhere that is not a signal, and that is the finding to report.
- {ts} An `effect()` that starts a timer, listener or subscription registers its teardown through the `onCleanup` callback; without it every re-run stacks another one.
- {ts} An `effect()` reading a signal it must not depend on (a value it only samples — a form snapshot read while reacting to a lock flag) wraps that read in `untracked()`; an accidental dependency turns the effect into a loop.
- {ts, markup} `resource`/`httpResource` reads are guarded with `hasValue()` before `.value()` (an errored resource throws on read); a resource depending on another resource derives its `params` from the source resource's signal, never by calling the source's `.value()` inside the loader.
- {ts} Each cold HttpClient observable is subscribed once per intended request — re-subscribing the same stream fires duplicate backend requests.
- {markup} `@defer`: above-the-fold/LCP content is never deferred — deferring it buys a layout shift and a slower LCP, not a faster one.
- {markup} `@defer`: nested blocks use different triggers; identical triggers cascade into one simultaneous load and defeat the split.
- {ts, markup} `@defer`: the deferred component is imported from its concrete file, never through a barrel `index.ts` — a barrel import keeps it in the main bundle and the block defers nothing.
- {markup} `@defer`: `viewport`/`interaction`/`hover` triggers declare a `@placeholder` with a single root element (the trigger needs exactly one element to observe).
- {markup} Images: the LCP/hero image is marked `priority`; every `ngSrc` image declares `width` + `height` (or `fill` with a positioned parent) so it cannot shift layout.
- {ts} Long-lived async work is bounded: polling/intervals take their period from the central app config and are explicitly stopped — no unbounded `setInterval`/`timer` outliving its view or effect.
- {ts} Render-phase work that must re-run when a signal changes is `afterRenderEffect()` (v19+), not an `effect()` reading the DOM: a plain `effect()` runs before the DOM is updated, so it measures the previous frame; the one-shot case stays `afterNextRender`.
