---
name: Attribute directives
applies-to:
  - "**/*.directive.ts"
---
## Checklist
- Standalone directive; the selector is an attribute selector carrying the app prefix (`[appPrefixFocusTrap]`), file `<name>.directive.ts`, class `<PascalCase>Directive`.
- Inputs and outputs use `input()`/`output()`; host bindings and listeners live in the `host: {}` object — never `@HostBinding`/`@HostListener` (global best-practices instruction).
- DOM writes go through `Renderer2` or a signal-driven `host` binding; direct `nativeElement` writes in the constructor or `ngOnInit` are forbidden, and measurement or focus work runs in `afterNextRender`.
- Listener teardown is automatic (`host: {}`) or explicit (`takeUntilDestroyed()`); a manually added `addEventListener` is removed through `inject(DestroyRef).onDestroy(...)`.
- Behavior reused by several components is composed with `hostDirectives` rather than copy-pasted host bindings.
- The directive holds no domain state and injects no facade or HTTP service — it is a presentation concern; behavior that needs state belongs in the component that hosts it.
- A directive lives in a shared location (never next to a component file — components-folder instruction) and is listed in the `imports` array of every component whose template uses it.
- Every directive has a spec in the sibling `tests/` folder that renders it on a host component and asserts the resulting host bindings and emitted outputs.
