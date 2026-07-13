---
name: Test coverage — untested cases & edge cases
---
## Checklist
- Every new or behavior-changing source file in the diff ships the matching spec change in the same diff; a missing or untouched spec for changed behavior is a 🔵 Missing Unit Test finding.
- Do not assume coverage from the spec's mere existence — enumerate the behavioral cases the changed lines introduce and cross-check each one against the spec's actual test cases.
- Every conditional branch introduced or modified by the diff is tested for BOTH outcomes: each `if`/`else`, ternary, `switch` case (including `default`), guard clause, early return and short-circuit path (`&&`, `||`, `??`, `?.`).
- Every failure path is tested, not only the happy path: rejected promises, erroring observables/HTTP calls, thrown exceptions, `catch`/`catchError` blocks, timeout/retry logic and fallback values.
- Edge cases of the data the changed code reads are covered: empty array/collection, `null`/`undefined` input, empty string, `0` and negative numbers, boundary values of every comparison (test the exact limit of `<` vs `<=`), first/last element handling, duplicates where uniqueness matters.
- State permutations are covered: every boolean/loading/error flag the changed code reads is exercised in its non-default state as well as its default, and each flag is asserted independently so a single flag flipping the result is caught.
- Parameterized behavior (`switch` over an enum, lookup maps, config-driven logic) has a test per variant — ideally an `it.each` dataset covering all variants; a variant added by the diff without a matching dataset row is a finding.
- Public API surface changed by the diff (new method, new input/output, new selector/action handling) has at least one test exercising it through that public surface, not only through internals.
- Each finding names the concrete untested case — the input, state or branch that lacks a test, with the source line it lives on; a generic "add more tests" is not a valid finding.
