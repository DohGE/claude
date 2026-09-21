---
name: Unit tests (common)
# Unit specs only, as the name says. An end-to-end suite is also written in `.spec.ts`
# files, and every item below is about Jest and ng-mocks — `MockBuilder`, `MockRender`,
# `ngMocks.faster()`, a state-restoring `afterEach` — none of which an E2E spec has or
# wants. Without these exclusions a committed `e2e/` suite was walked against all
# twenty-five of them, and item 1 reported every file for not living in a `tests/`
# folder next to the code under test. `e2e/` is the convention this plugin's own
# pipeline writes into, and `.e2e-spec.ts` is the Angular CLI one.
applies-to:
  - "**/*.spec.ts"
  - "**/tests/**"
  - "!**/e2e/**"
  - "!**/*.e2e-spec.ts"
scopes:
  spec: ["**/*.spec.ts"]
  testcode: ["**/*.spec.ts", "**/tests/**/*.ts"]
  snapshot: ["**/*.snap"]
---
## Checklist
- {spec, snapshot} Specs live in a `tests/` folder next to the code under test; snapshots in `tests/__snapshots__/`.
- {spec} Stack is Jest + ng-mocks; suites sharing a fixture/TestBed use `ngMocks.faster()` with setup in `beforeAll`.
- {spec} `MockRender` is never called in `beforeEach` unless the tested functionality genuinely requires a fresh render for every case (each `it` asserting initialization behavior — an `ngOnInit` dispatch, a constructor `effect()`'s first run). The default is one shared render in `beforeAll`; a single test needing its own render creates a local `MockRender` inside that `it` and destroys it there. A `beforeEach` render that only re-does what `beforeAll` already did is a finding — it re-runs the whole component setup per test for nothing.
- {spec} `afterEach` restores all shared state: `jest.clearAllMocks()`, every signal mutated inside tests reset to its initial value, selector overrides reset; data (re)established in `beforeEach` is reset in `beforeEach`, not undone in `afterEach`.
- {testcode} Named test constants (fixtures, mocks, datasets) are camelCase — never SCREAMING_SNAKE_CASE or PascalCase.
- {testcode} Variables holding an injected dependency (mock, spy, `TestBed.inject(...)` result) use the full descriptive name derived from the dependency type (keeping the feature/area part of the class name), never shortened to a generic role name.
- {testcode} A dependency mock/stub is checked against the real contract instead of cast into it: `satisfies SomeService` for a full stub, `satisfies Partial<SomeService>` or an annotated `Partial<SomeService>` for the deliberate subsets the facade, component and guard test instructions prescribe — never `as SomeService`, which silences every drift between the mock and the contract it stands for.
- {spec} Test-loop data is passed directly: `it.each` / `describe.each` / `test.each` receives its rows as an array literal written inside the call, and each row keeps its values as literals in place — never a named dataset const passed to `it.each(dataset)`, and never per-case variables (fixtures, inputs, expected values) declared above and referenced from the rows. Rows that repeat a value write it out again; the no-duplicated-test-data rule below never pulls data out of a dataset row.
- {spec} Every `describe` title is either the exact code identifier under test — matching its real casing (`describe('myFunction')`, `describe('UserPanelFacade')`) — or a descriptive phrase whose first word is capitalized (`describe('Tests for myFunction')`); a descriptive title never starts with a lowercase word (`describe('tests for myFunction')`).
- {spec} Every `it` description starts with `should` and states the expected behavior (e.g. `it('should return an empty list when the request fails')`); `it.each` description templates follow the same rule.
- {testcode} Fixtures are complete objects of their domain type; `{} as X` is acceptable only when the code under test never reads the payload's fields.
- {testcode} The same test data is never duplicated across cases: define a shared object/dataset once and reuse it directly when the data is identical, or derive near-identical variants from it with the spread operator (`{ ...baseFixture, changedField: value }`) — never hand-write a second copy of an equivalent literal.
- {spec} No existence-only tests — never `it('should be created', () => expect(x).toBeTruthy())` or `toBeDefined()`-style assertions (zero diagnostic value).
- {spec} WHICH cases a spec must cover (branches, edge cases, failure paths, state permutations, missing specs for changed behavior) is owned by the global test-coverage instruction and reported there as 🔵 Missing Unit Test — the rules below govern only the SHAPE of the spec.
- {spec} Any spy or mock called with arguments is asserted on those arguments with `toHaveBeenCalledWith(...)` (or `toHaveBeenLastCalledWith(...)` for effect-driven repeats) — a bare `toHaveBeenCalled()`/`toHaveBeenCalledTimes(n)` that ignores the payload is insufficient; `toHaveBeenCalled()` is reserved for genuinely argument-less calls.
- {spec} Every `subscribe(...)` opened in a spec is bounded with a `take(...)` operator (`take(1)` for a single expected emission, `take(n)`/`bufferCount(n)` when a known number is expected) so it completes and cannot leak into later tests.
- {spec} A signal `input()` is written with `MockRender(Component, { inputName: value })` or `fixture.componentRef.setInput('inputName', value)`, followed by a change-detection flush before the assertion. Assigning `component.inputName = value` does not write the input — the test then asserts against the input's default and passes for the wrong reason (🔴 High).
- {spec} The spec runs the change-detection mode the application runs: when `app.config.ts` provides `provideZonelessChangeDetection()`, the TestBed setup provides it too — a spec left zone-based passes on zone.js' automatic ticks and hides exactly the missing signal write that leaves the real app stale. Without the polyfill `fakeAsync`/`tick()` no longer exist; flush with `TestBed.tick()` (v20+) or `fixture.detectChanges()`.
- {spec} `effect()` and `computed()` results are flushed before assertion (`fixture.detectChanges()`, or `TestBed.tick()` on v20+); asserting straight after a `.set()` reads the pre-effect state and makes the test order-dependent.
- {spec} Anything calling `inject()` outside a rendered component (a functional guard, resolver or interceptor, a `toSignal()` helper) is exercised inside `TestBed.runInInjectionContext(...)` — calling it directly throws NG0203 or resolves against a stale injector.
- {spec} No focused or skipped specs (`fdescribe`/`fit`/`.only`/`xit`) reach the diff — see the general instruction.
- {testcode} No double casts (`as unknown as X`) where a single `as X` suffices; no `as never`; no string-index type access.
- {spec, snapshot} Snapshots are updated (`-u`) only after consciously reviewing the diff.
- {spec} Behavior-bearing code follows TDD: a failing test first (failing for the expected reason), then the minimal implementation, then refactor with tests green.
- {spec} After changing any source file, its spec is run and green before commit (the pre-commit hook lints but does not run tests).
