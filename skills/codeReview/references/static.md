# Static checks - the contract

A checklist item a tool can settle is settled by the tool: the walker never reads it when the
tool found nothing, and is handed the exact lines when it did. This file is the contract between
the modules that do it. Everything is Node, zero dependencies of the plugin's own: the engines
(ESLint, stylelint, their plugins) are the REVIEWED PROJECT's, resolved from its `node_modules`,
and a missing engine, plugin or rule only means the item stays in the walk.

## The map: `static/static-map.json`

One file, not a key repeated in 72 kind files. `rulebook.cjs` loads it and puts `static` (the
array below) on every item whose address it names, in every kind.

    {
      "version": 1,
      "items": {
        "component#1": [
          { "engine": "eslint", "rule": "@angular-eslint/prefer-on-push-component-change-detection", "level": "decides" }
        ],
        "security#9": [
          { "engine": "eslint", "selector": "CallExpression[callee.name='withNoXsrfProtection']", "message": "withNoXsrfProtection() is forbidden", "level": "decides" }
        ]
      }
    }

An entry is ONE of these shapes (`level` is required on each: `decides` or `points`):

- `{ "engine": "eslint", "rule": "<ruleId>", "options": [...] }` - a rule of ESLint core, of a
  plugin the project has, or of the plugin's own `doh/<name>` (see below). `options` optional.
- `{ "engine": "eslint", "selector": "<esquery>", "message": "<text>" }` - becomes one entry of
  `no-restricted-syntax`.
- `{ "engine": "eslint", "restrictedImport": { "group": ["**/*.effects"], "importNames": [...] }, "message": "<text>" }`
  - becomes one pattern of `no-restricted-imports` (`name` instead of `group` for an exact module).
- `{ "engine": "stylelint", "rule": "<rule>", "options": <any> }`.
- `{ "engine": "builtin", "check": "<name>" }` - a check of `scripts/static-builtin.cjs`.

Optional on every entry:

- `files`: a glob or list of globs (project-relative, `**`, `*`, `{a,b}`) the entry applies to;
  default: every file whose kind walks the item, of the engine's language (eslint: `.ts` for rule
  and selector entries unless the rule id starts with `@angular-eslint/template/` or
  `doh/template-`, then `.html`; stylelint: `.scss`/`.css`/`.less`; builtin: any).
- `excludeFiles`: the same, subtracted.
- `messageIds`: a list of the rule's message ids the entry stands for (a rule entry only); a
  message of another id is not credited to it. Without it every message of the rule is credited
  to every entry mapping that rule (two items may share a rule on one file).
- `needsTypes: true` - a type-aware rule; run only when the runner got a tsconfig (see runner).
- `note`: free text for maintainers.

`level`:

- `decides` - the tool's answer IS the item's verdict for this file. No hit on a changed line:
  the item is closed by the script. A hit on a changed line: the item is a violation the part
  must report. Only for rules with no judgement in them and no exception clause in the item text.
- `points` - a hit only names a line the item's verdict must answer (like a probe); no hit means
  nothing, the item is walked as before.

An item is decided for a file only when EVERY `decides` entry of it that applies to the file ran;
when the item also has `points` entries or its text covers more than the entries check, the map
marks that with `"partial": true` on the item level:

    "best-practices#10": { "partial": true, "entries": [ ... ] }

(an item's value is either the array of entries, or `{ partial, entries }`). A `partial` item is
never closed by the script: its clean result is printed under it (`statyczna: czysto - <rules>`)
so the walker skips that half, and its hits bind like any other.

## The runner: `scripts/static-checks.cjs`

    run({ projectRoot, files, map, kindItems, changedLines, sourceRoot?, tsconfig?, timeoutMs? }) -> document

- `projectRoot` - where `node_modules` is resolved from (the main checkout).
- `sourceRoot` - where the reviewed revision's files lie; default `projectRoot`. Paths in `files`
  are relative to it. Step 1 passes the working tree when the working tree IS the reviewed
  revision; otherwise (the revision is read from git objects) it writes the reviewed files, and
  the `.html`/`.ts` sibling of each that a template rule reads, to a temp folder of their own and
  passes that, removed afterwards.
- `files` - `[{ path, kind }]`, the reviewed files.
- `kindItems` - `{ <kind>: [address, ...] }`, the items each kind walks.
- `changedLines` - `{ <path>: [[from, to], ...] }`, 1-based inclusive ranges of the new file;
  a path absent from it has every line changed (an added file).
- CLI: `node static-checks.cjs --project=<dir> --input=<json file of the object above minus map> --out=<file>`.

It generates one ESLint flat config (an overlay, written to a temp file inside `projectRoot` so
that plugin imports resolve; removed afterwards), with `--no-config-lookup`, runs the project's
`eslint` (`node_modules/.bin`, never `npx` downloading anything) with `--format json` over the
files, and maps every message back to its item: by `ruleId` for rule entries, by a `[doh:<address>]`
tag it put on the message of selector / restricted-import entries, matched anywhere in the
message (`no-restricted-imports` puts its own words before the custom message). stylelint likewise.
Builtin entries call `static-builtin.cjs`. A rule the installed plugin does not have is dropped
from the overlay and listed in `skipped` (found by loading the plugin and reading its `rules`).
Parsers: `@typescript-eslint/parser` for `.ts`, `@angular-eslint/template-parser` for `.html`.
The project's own ESLint config is NOT loaded: only mapped rules run, so the result does not
depend on what the project turned on. Inline `eslint-disable` comments are honoured (a
suppression is the author's stated decision; `best-practices#22` reviews the comment itself).

The document (`static.json`, beside `facts.json`; the bundle builder also copies what it binds
into `facts.json` - an item's `static` hits, `staticClean`, the items closed by the static check -
so a hook reading `facts.json` alone sees them):

    {
      "version": 1,
      "engines": { "eslint": { "available": true, "version": "9.28.0" }, "stylelint": { "available": false, "reason": "not installed" }, "builtin": { "available": true } },
      "skipped": [ { "address": "x#1", "engine": "eslint", "rule": "…", "reason": "rule not found in installed plugin" } ],
      "files": {
        "src/app/a.component.ts": {
          "decided": ["component#1", "best-practices#24"],
          "clean": { "best-practices#10": ["@angular-eslint/no-output-on-prefix"] },
          "hits": [
            { "address": "component#27", "level": "decides", "line": 12, "endLine": 14, "rule": "@angular-eslint/component-max-inline-declarations", "message": "…", "inChange": true }
          ]
        }
      }
    }

- `decided` - non-partial items whose every applicable `decides` entry ran on the file (whether
  or not they hit).
- `clean` - partial items: the entries that ran and hit nothing on a changed line.
- `hits` - every message; `inChange` says whether its line range meets a changed range. Only
  `inChange` hits count: the review reports nothing on lines the diff left alone.
- A file an engine crashed on (parse error) has `"error": "<text>"` and nothing decided.

## Builtin checks: `scripts/static-builtin.cjs`

    checks = { '<name>': ({ file, text, kind, files, changedLines, patch }) => [{ line, endLine?, message }] }

`files` is a `Map` path -> text of the whole reviewed revision (may be partial; a check that
needs the whole tree returns `null` = "did not run" when told so by `files.partial === true`).
Pure functions, tested with a `Map`, like `repo-facts.cjs`.

## The plugin's own ESLint rules: `static/eslint-plugin-doh.cjs`

A plain ESLint plugin object `{ meta, rules }` (CommonJS, no dependencies beyond what ESLint and
the parsers hand a rule), loaded by the overlay under the namespace `doh`. Template rules are
named `template-<name>` and receive the Angular template AST from `@angular-eslint/template-parser`.

## What the review does with it (review-context / review-bundle / check-part)

- Step 1 runs the runner once per target after the facts, writes `static.json` (`staticPath`).
- A `decided` item with no `inChange` hit joins the items the script closes:
  `OK (statyczna: czysto - zamknięte przez skrypt)`, written by the hook. The bundle's plan names
  them in one line per step, `- zamknięte przez skrypt (statyczna: czysto; linie dopisze hook): <step>#<n>,#<n>`,
  and does not print them as items.
- An `inChange` hit of level `decides` is printed under its item as
  `STATYCZNA L7: <rule> - <message>` (`L7-L9` when the hit spans lines); the part check refuses any verdict but `NARUSZENIE`
  on that item (no `fakt nie dotyczy:` escape - the only way out is fixing the map).
- An `inChange` hit of level `points` is printed as `SONDA L4: <rule> - <message>` and held like a
  probe hit.
- A partial item's `clean` entries print `statyczna: czysto - <rules>` under the item.
- No runner result (no engine, a crash, `--no-static`): nothing changes, every item is walked.

## The project preset

`node scripts/static-checks.cjs --emit-config=<path> --project=<dir>` writes the same overlay as
a standalone flat config the project can import into its own `eslint.config.mjs` (IDE,
pre-commit, CI) - the same rules before the review as in it. The preset resolves its plugins
from its own location (`createRequire(import.meta.url)`), not from a path of the plugin cache,
which changes with every version; when it uses a `doh/` rule, a copy of `eslint-plugin-doh.cjs`
is written beside it and loaded as `./eslint-plugin-doh.cjs`.
