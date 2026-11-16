# fixPr agent - step 5b: look at what the user sees

Read by the fix agent of `{{BRANCH}}` at step 5b only, after its gate is green. Worktree: `{{ROOT}}`
| Check logs: `{{CHECKS_DIR}}` | Skill dir: `{{SKILL_DIR}}` | Project root: `{{PROJECT}}`

The app is started as `{{VISUAL}}` says: `command` (its `{port}` filled), `url` (the app's address,
`{port}` filled; hash routes go after it), `backend` (the URLs it calls) and `authFile` (the
project-relative login file, `{"login","password"}`; never read it yourself, never print it).

1. Toolchain: the orchestrator prepared it while the worktrees were made. Only when
   `{{SKILL_DIR}}/../implementNewFeature/node_modules/@playwright/test/cli.js` is missing, run
   `node "{{SKILL_DIR}}/../implementNewFeature/scripts/ensure-playwright.cjs"` once, in the background,
   and wait for it like the gate.
2. Preflight: `node "{{SKILL_DIR}}/../implementNewFeature/scripts/e2e-preflight.cjs" --root="{{ROOT}}" --project="{{PROJECT}}" --port=<a free port, 4300-4399> --url=<each backend URL> --fix`
   (`--fix` copies the local config the worktree lacks, `proxy.*.local.js` above all).
   `PREFLIGHT_FAILED` with an unreachable backend → the check cannot run: skip it with that reason
   (every changed template stays in `uiUnverified`), never mock a backend that does not answer.
3. Start the app in the background through the process record, and wait in slices (Bash
   `timeout: 175000`):
   `node "{{SKILL_DIR}}/../implementNewFeature/scripts/task-processes.cjs" start --task-dir="{{CHECKS_DIR}}/visual" --root="{{ROOT}}" --port=<port> --command="<command>"`, then
   `node "{{SKILL_DIR}}/../implementNewFeature/scripts/task-processes.cjs" wait --task-dir="{{CHECKS_DIR}}/visual" --port=<port>`
   until `READY` (`PENDING` → again; `EXITED` → the app did not start: skip with the log's last lines).
4. Write ONE spec, `{{CHECKS_DIR}}/visual/e2e/fix.spec.cjs` (`const { test, expect } = require('@playwright/test')`):
   one `test` per item you check (named by the item, `thread:<id>`), each signing in with
   `process.env.E2E_LOGIN` / `E2E_PASSWORD` when there is a login, opening the route under
   `process.env.E2E_BASE_URL`, doing what the comment describes (open the row menu, hover the
   button), asserting what the fix promises (`toBeDisabled()`, `toHaveAttribute('aria-label', …)`,
   the tooltip's text, `toBeVisible()`, a computed style through `evaluate`) and saving
   `page.screenshot({ path: '{{CHECKS_DIR}}/visual/shots/<item>.png' })`.
   The backend answers but holds no record the check needs (a node with unfinished restore mounts,
   two of seven checks of 2026-11-16) → give the page that record: `page.route` on that one
   endpoint, answered from a fixture file you write next to the spec in the shape the real response
   has (read the service's model for it). Say so in the item: `"mocked": true`.
5. Run it through the gate script (its exit code is the verdict):
   `node "{{SKILL_DIR}}/scripts/checks.cjs" --root="{{ROOT}}" --out-dir="{{CHECKS_DIR}}/visual" --only=e2e --env=NODE_PATH="{{SKILL_DIR}}/../implementNewFeature/node_modules" --env=E2E_TEST_DIR="{{CHECKS_DIR}}/visual/e2e" --env=E2E_BASE_URL="<url>" --command="node \"{{SKILL_DIR}}/../implementNewFeature/node_modules/@playwright/test/cli.js\" test --config \"{{SKILL_DIR}}/../implementNewFeature/playwright.config.cjs\"" --result-file="{{CHECKS_DIR}}/visual/visual-<n>.json" [--auth-file="{{PROJECT}}/<authFile>"]`
   in the background, waiting for its result file. Then Read every screenshot of an item whose
   comment had media, beside that media: the fix shows what the reviewer asked for, or it does not.
6. A failed assertion, or a screenshot that does not show the fix, is a red step: repair the code
   and run steps 5-6 again - at most two more runs. Still red → no commit, the `error` JSON, like a
   red gate. A test that fails for the app's sake (a page that never loads, a login refused) is no
   verdict on the fix: say so and keep the item in `uiUnverified`.
7. Always, last: `node "{{SKILL_DIR}}/../implementNewFeature/scripts/task-processes.cjs" cleanup --task-dir="{{CHECKS_DIR}}/visual"`.

Every item checked goes into `visualChecks` (the result file); `uiUnverified` keeps only what this
step could not look at, each with the reason. Never add the spec, its fixtures or the screenshots to
the commit.
