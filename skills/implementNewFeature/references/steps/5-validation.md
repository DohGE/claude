## Step 5 — Validation & E2E (view-only, except the Chrome-extension prompt)

Take the E2E slot first (see "E2E slot" in SKILL.md): POST `/api/e2e` with `{"taskId":"T"}`, and on
`{"granted":false,…}` wait for T's `kind=="e2e"` before point 1.

1. POST `{"taskId":"T","step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Spawn the validation agent from `references/validation-agent.md`, per "Spawning a sub-agent",
   with its helpers' settings:
   `--set=RUNNER_MODEL=<model of validationRunner> --set=RUNNER_EFFORT=<the directive of its effort>`
   `--set=COMPLIANCE_MODEL=<model of validationCompliance> --set=COMPLIANCE_EFFORT=<the directive of its effort>`
   ("Model and effort"). It runs the task's own unit suite, then writes and runs the E2E suite on
   the plugin's own Playwright, and uses the user's Chrome (Claude in Chrome extension) for
   discovery, failure debugging and a UX pass — expect a tab to open there during this step; the
   extension is REQUIRED. It checks what the app needs before starting it (`e2e-preflight.cjs`:
   local config, a free port, a backend that answers), starts the dev server once for the step,
   and stops it at the end. Endpoints the backend does not serve yet are faked in the app's code
   for the length of the step and removed before it ends (archived to `<SESSION>/tasks/T/mocks/`),
   so the final review and the commit never see them. Without refinement there is no
   `checklist.md`: the agent writes one from the task description, the story and the approved
   screens before it tests anything, as its brief says — nothing about it goes into the prompt.
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the extension is unavailable, and it is
     REQUIRED: the agent is blocked until the user installs/enables it, or — from the preflight —
     until the user starts what the agent cannot (a VPN, a remote backend). POST
     `{"taskId":"T","question":{...}}`, wait for T's `kind=="answer"` — the server has already taken
     the question down and logged the answer — then POST
     `{"taskId":"T","step":5,"currentOperation":"Retrying…"}` and SendMessage the answer text to
     the agent. Never tell it to continue without the extension, and never re-spawn it with that
     requirement waived.
   - `{"type":"result","compliance":NN,"testsSummary","unitSummary","mockupSummary","uxSummary","apiMockSummary"}`
     with `compliance>=99` → POST completed with `activeStep` at the next step (the server hands the
     slot on). Keep `apiMockSummary` for the final summary — it says which endpoints were faked, so
     the user knows what was never proven against a real API. When the final review is off
     (`FINAL(T)` false, or the task is on the legacy route), delete `<SESSION>/tasks/T/auth.json`
     now unless step 6 still runs after this one: no later step logs in.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit suite that stayed red, or an
     extension that never became available) → failure protocol. T keeps the slot across a
     `retry`, because the retry is still T inside step 5; a `finish` frees it with the summary.
4. Stop what the step left running — the agent's own cleanup is the rule, this is the backstop:
   `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
