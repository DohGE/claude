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
- `it.each(...)` datasets live in a named const, not an inline array.
- Fixtures are complete objects of their domain type; `{} as X` is acceptable only when the code under test never reads the payload's fields.
- No existence-only tests — never `it('should be created', () => expect(x).toBeTruthy())` or `toBeDefined()`-style assertions (zero diagnostic value).
- No double casts (`as unknown as X`) where a single `as X` suffices; no `as never`; no string-index type access.
- Snapshots are updated (`-u`) only after consciously reviewing the diff.
- Behavior-bearing code follows TDD: a failing test first (failing for the expected reason), then the minimal implementation, then refactor with tests green.
- After changing any source file, its spec is run and green before commit (the pre-commit hook lints but does not run tests).
