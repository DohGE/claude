## Step 5 — Validation & E2E (view-only, except the backend and Chrome-extension prompts)

Every task runs this step on its own, in parallel with the others: there is no slot to take and
nothing to wait for (SKILL.md, "Validation runs in parallel").

1. Stop whatever an earlier attempt of this step left running — a dev server of a failed run still
   holds its port and its memory: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   Then POST `{"taskId":"T","step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`, per "Spawning a sub-agent"
   (`task-info.cjs --render` fills its helpers' settings: `RUNNER_MODEL`, `RUNNER_EFFORT`,
   `COMPLIANCE_MODEL`, `COMPLIANCE_EFFORT`). Its first act is the backend check: before it installs,
   reads or starts anything it asks whether the backend the app talks to answers, and when it does
   not, it stops and asks the user to start it — and waits, asking again, until the user confirms
   it answers. An unreachable backend is never mocked as a whole: only single endpoints a LIVE
   backend does not serve yet are faked in the app's code for the length of the step, and removed
   before it ends (archived to `<SESSION>/tasks/T/mocks/`). Then it checks the Claude in Chrome
   extension, runs the specs of the task's changed files, writes and runs an E2E suite that covers
   the whole feature and the existing flows around it, its edge cases, every equivalent path to the
   same data and every request against the contracts, on the plugin's own Playwright, and makes a
   UX pass in the user's Chrome — expect a tab to open there. Its dev server runs through
   `task-processes.cjs start` on a port of its own. Without refinement there is no `checklist.md`:
   the agent writes one from the task description, the story and the approved screens before it
   tests anything, as its brief says — nothing about it goes into the prompt.
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the agent is blocked on something only the user
     can fix: the backend does not answer (ids `backend1`, `backend2`, …), or the Chrome extension
     is unavailable (`chrome1`, …). POST `{"taskId":"T","question":{...}}`, wait for T's
     `kind=="answer"` — the server has already taken the question down and logged the answer — then
     POST `{"taskId":"T","step":5,"currentOperation":"Retrying…"}` and SendMessage the answer text
     to the agent. The agent checks again itself; never tell it the backend answers, and never tell
     it to mock a backend that does not. Going on without the extension is the user's choice
     between the options the agent offered — forward the one they picked.
   - `{"type":"result","compliance":NN,"testsSummary","unitSummary","mockupSummary","uxSummary","apiMockSummary"}`
     with `compliance>=99` → POST completed with `activeStep` at the next step, then
     `node "<SKILL_DIR>/scripts/checkpoint.cjs" --root=<ROOT> --task=T --step=5` (a restore point of
     the validated tree; `CHECKPOINT_NONE` is fine). Keep `apiMockSummary` for the final summary —
     it says which endpoints were faked, so the user knows what was never proven against a real
     API. When the final review is off (`FINAL(T)` false, or the task is on the legacy route),
     delete `<SESSION>/tasks/T/auth.json` now unless step 6 still runs after this one: no later
     step logs in.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit suite that stayed red, or an
     extension or backend that never became available) → failure protocol.
4. Stop what the step left running — the agent's own cleanup is the rule, this is the backstop:
   `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   `STILL_RUNNING <port> <pid>` → say so in the step's report: the port stays on the list for the
   next cleanup.
