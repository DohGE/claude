---
name: Test coverage — untested cases & edge cases
applies-to:
  - "**/*.ts"
  - "!**/models/**"
gate: the file carries behaviour a spec could execute - a function, branch, handler, effect or class method, not only declarations, re-exports or route/config literals
---
This instruction OWNS coverage gaps — which behavioral cases, branches, edge cases and state permutations
the diff leaves untested; every finding here is 🔵 **Missing Unit Test**. The unit-tests instruction owns
the SHAPE of a spec (location, setup, naming, assertion style). A gap is reported ONCE, here — never also
as a unit-tests finding.

## Checklist
- Every new or behavior-changing source file in the diff ships the matching spec change in the same diff; a missing or untouched spec for changed behavior is a 🔵 Missing Unit Test finding. The file types their own instructions exempt are never such a finding: `models/` declarations, route files, i18n JSON, barrels, templates and styles — their behavior is covered by the specs of the code that consumes them.
- Do not assume coverage from the spec's mere existence — enumerate the behavioral cases the changed lines introduce and cross-check each one against the spec's actual test cases.
- Every conditional branch introduced or modified by the diff is tested for BOTH outcomes: each `if`/`else`, ternary, `switch` case (including `default`), guard clause, early return and short-circuit path (`&&`, `||`, `??`, `?.`).
- Every failure path is tested, not only the happy path: rejected promises, erroring observables/HTTP calls, thrown exceptions, `catch`/`catchError` blocks, timeout/retry logic and fallback values.
- Edge cases of the data the changed code reads are covered: empty array/collection, `null`/`undefined` input, empty string, `0` and negative numbers, boundary values of every comparison (test the exact limit of `<` vs `<=`), first/last element handling, duplicates where uniqueness matters.
- State permutations are covered: every boolean/loading/error flag the changed code reads is exercised in its non-default state as well as its default, and each flag is asserted independently so a single flag flipping the result is caught.
- Parameterized behavior (`switch` over an enum, lookup maps, config-driven logic) has a test per variant — ideally an `it.each` dataset covering all variants; a variant added by the diff without a matching dataset row is a finding.
- Public API surface changed by the diff (new method, new input/output, new selector/action handling) has at least one test exercising it through that public surface, not only through internals.
- Each finding names the concrete untested case — the input, state or branch that lacks a test, with the source line it lives on; a generic "add more tests" is not a valid finding.
