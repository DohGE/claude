---
name: Code quality — duplication, dead code, boilerplate & consistency
---
Every violation of this checklist is reported with severity 🟡 **Medium** — never softened to ⚪ Low
because it looks cosmetic and never raised because it looks dangerous.

This instruction OWNS duplication, dead/unnecessary code, boilerplate, added comments and
inconsistency: when another instruction or the cross-file pass covers the same occurrence (the
architecture "reuse before creating" rule, the duplication-drift and naming-consistency questions),
the occurrence is reported ONCE — here, with this severity.

Scope is the skill's scope gate: the finding is anchored on a line the diff touched. A copy that the
diff ADDS of pre-existing code is a finding (anchored on the new copy); duplication, dead code or
inconsistency living entirely in untouched lines is not.

## Checklist
- No duplicated logic: the same expression, condition, transformation, mapping, validator set, literal/const value or markup fragment appearing twice — in one file, across the files of this diff, or re-implemented next to an existing shared util, component, builder, model or i18n key. Report every copy at the place that should reuse instead of repeat, and name the existing source it duplicates.
- No copy-paste-with-a-tweak: two near-identical blocks differing only in a value, a field name or one branch become one parameterized function, const or loop — this includes near-identical test fixtures, mock objects and `it` bodies (which belong in an `it.each` dataset).
- No unused code: unused imports, variables, consts, parameters, private fields and methods, unreachable statements, dead branches, exported symbols with no consumer left in the repo, template refs/inputs/outputs nothing binds, SCSS rules whose selector the template no longer contains, i18n keys nothing resolves, and leftovers of an earlier iteration of this very change.
- No unnecessary code: a wrapper that only forwards to the wrapped call, a variable used once on the very next line, `else` after a `return`, a condition that can never be false, `?.`/`??`/`try` guarding a value the types already guarantee, a hand-written helper an existing shared function already provides, an abstraction (interface, base class, generic, options object) introduced for a single consumer "for the future".
- No boilerplate: empty or pass-through lifecycle hooks and constructors, getters/methods that only return a field, scaffolding and generator leftovers (placeholder markup, sample fields, `TODO` stubs nothing tracks), values re-declared although the framework already defaults to them, and ceremony that adds no behavior.
- The diff adds NO comments — every comment line the change introduces is a finding, whatever it says: narration of the next line, block or function, signature-repeating JSDoc, section banners (`// --- helpers ---`), author/date/ticket/changelog notes, a description of what the change did (that belongs in the commit message), and equally the "explaining WHY" kind. Meaning is carried by names, types and structure; when code needs a sentence to be understood, the finding is the code, not the missing comment. Only machine-read directives survive: `@ts-expect-error`/`@ts-ignore`/`eslint-disable*`/`prettier-ignore` with the one-line justification the best-practices instruction requires, and the `// consts` / `// enums` / `// interfaces` / `// types` barrel headers the models instruction prescribes.
- No commented-out code — removed code is recovered from git history, never parked in a comment or behind an `if (false)`.
- Code is consistent with its surroundings: one concept keeps one name everywhere (and one name never denotes two concepts), sibling cases are solved the same way (same guard style, same mapping approach, same error handling, same async style), related functions keep the same parameter order and return shape, and members keep the file's established ordering. Code that answers an already-answered question differently is a finding at the new location. A name that merely breaks a naming convention (casing, abbreviation) is not this rule — it belongs to the general instruction.
