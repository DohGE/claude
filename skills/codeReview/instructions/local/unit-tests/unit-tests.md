---
name: Unit tests (common)
applies-to:
  - "**/*.spec.ts"
---
## Checklist
- Specs live in a `tests/` folder next to the code under test; snapshots in `tests/__snapshots__/`.
- Stack is Jest + ng-mocks; suites sharing a fixture/TestBed use `ngMocks.faster()` with setup in `beforeAll`.
- `afterEach` restores all shared state: `jest.clearAllMocks()`, every signal mutated inside tests reset to its initial value, selector overrides reset; data (re)established in `beforeEach` is reset in `beforeEach`, not undone in `afterEach`.
- Named test constants (fixtures, mocks, datasets) are camelCase — never SCREAMING_SNAKE_CASE or PascalCase.
- Variables holding an injected dependency (mock, spy, `TestBed.inject(...)` result) use the full descriptive name derived from the dependency type (keeping the feature/area part of the class name), never shortened to a generic role name.
- A dependency mock/stub is typed with `satisfies SomeService` rather than a type cast (`as SomeService`) or `Partial<SomeService>`, so the mock is checked against the real contract while keeping its literal shape.
- `it.each(...)` datasets live in a named const, not an inline array.
- Fixtures are complete objects of their domain type; `{} as X` is acceptable only when the code under test never reads the payload's fields.
- No existence-only tests — never `it('should be created', () => expect(x).toBeTruthy())` or `toBeDefined()`-style assertions (zero diagnostic value).
- Every branch and edge case that changes a unit's output is covered, not just the happy path: each condition in a computed/guard/decision method is tested for both outcomes, every boolean/loading flag it reads is exercised in its non-default state as well as its default, and each such flag is asserted independently so a single flag flipping the result is caught. Flag a spec as having a missing test whenever a branch or state permutation the code reads has no case asserting its effect.
- No double casts (`as unknown as X`) where a single `as X` suffices; no `as never`; no string-index type access.
- Snapshots are updated (`-u`) only after consciously reviewing the diff.
- Behavior-bearing code follows TDD: a failing test first (failing for the expected reason), then the minimal implementation, then refactor with tests green.
- Every new or behavior-changing source file in the diff ships the matching spec change in the same diff — a new handler, reducer case, selector branch or util without a test is reported as 🔵 Missing Unit Test.
- After changing any source file, its spec is run and green before commit (the pre-commit hook lints but does not run tests).
