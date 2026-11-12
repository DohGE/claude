## Step 5 — Validation & E2E (view-only, except the questions its agents ask)

Every task runs this step on its own, in parallel with the others: there is no slot to take and
nothing to wait for (SKILL.md, "Validation runs in parallel").

The step is three kinds of agent, each with a context of its own, and you spawn them:

- **prepare** — one agent. Its first act is the backend check: before it installs, reads or starts
  anything it asks whether the backend the app talks to answers, and when it does not, it stops
  and asks the user to start it — and waits, asking again, until it answers. An unreachable
  backend is never mocked as a whole: only single endpoints a LIVE backend does not serve yet are
  faked in the app's code for the length of the step. Then it checks the Claude in Chrome
  extension, brings the checklist in line with what the user decided since it was written, runs
  the specs of the task's changed files, starts the dev server on a port of its own, and plans
  the E2E suite: `validation/plan.json` and `validation/context.md` in the task's folder. Without
  refinement there is no `checklist.md`: it writes one from the task description, the story and
  the approved screens.
- **author** — one agent PER SPEC FILE of the plan, all side by side. Each writes that file, runs
  it alone and leaves `validation/authors/<file>.json`; a test the application fails stays red and
  is recorded as a defect. Authors ask nothing.
- **verify** — one agent: fixes the application, runs the whole suite on the plugin's own
  Playwright, makes the UX pass in the user's Chrome (expect a tab to open there; it signs itself
  in through `chrome-login.cjs`, never by asking), ticks the checklist through `checklist.cjs`,
  removes the mocks (archived to `<SESSION>/tasks/T/mocks/`) and reports the step's result.

One agent used to do all of it: 237 turns in one conversation that grew to 443k tokens, re-read
on every turn, the spec files written one after another for over an hour.

1. Stop whatever an earlier attempt of this step left running — a dev server of a failed run still
   holds its port and its memory: `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   Then POST `{"taskId":"T","step":5,"status":"in_progress","activeStep":5,"progress":0}`.
2. Ask which phase is due — now, and again after EVERY agent of this step that ends:

       node "<SKILL_DIR>/scripts/validation-next.cjs" --task-dir="<SESSION>/tasks/T"

   It answers from the files the phases leave, so a `retry`, a resumed session and a session
   attached later all go on where the step stopped: nothing is prepared or written twice. Add
   `--restart` (the plan and the authors' results are forgotten) only when the user asked for the
   step to start over, or when a step-1 revision or a retry of step 4 or 6 changed the code since
   the plan was made.
   - `{"next":"prepare"}` → render with `task-info.cjs --step=5 --render --phase=prepare` and spawn
     it per "Spawning a sub-agent" (`general-purpose`: it drives the Chrome extension). `errors` in
     the answer are what an earlier plan lacked: put them in the prompt under
     `## The plan an earlier attempt left was not usable`. Route its JSON by point 3.
   - `{"next":"author","specs":[…]}` → one agent per listed spec file, ALL spawned in ONE message:
     for each, `task-info.cjs --step=5 --render --phase=author --spec=<file>` (its `model` and
     `effort` are the `validationAuthor` role's) and an Agent call with
     `subagent_type: "doh:pipeline-worker"` when your Agent tool lists that type, else
     `general-purpose`. POST `{"taskId":"T","step":5,"progress":25,"currentOperation":"Writing the E2E suite: 0 of <N> spec files"}`.
     As each one ends, POST `progress` `25 + 35 × <files done> / <N>` (rounded down) with
     `currentOperation` `Writing the E2E suite: <k> of <N> spec files` — the authors post only
     their own log line. An author's `{"type":"result"}` or `{"type":"error"}` moves nothing by
     itself: once every author you spawned has ended, ask `validation-next.cjs` again. A spec it
     still lists has no result file — its author crashed or gave up: spawn that one ONCE more;
     listed a second time → failure protocol, the report naming the spec file.
   - `{"next":"verify"}` → render with `--phase=verify` and spawn it (`general-purpose`), with every
     `user` entry of step 5's `chat` since the step last started under
     `## What the user wrote during this step` (the authors heard none of it). Route its JSON by
     point 3.
3. A prepare or verify agent's final JSON:
   - `{"type":"question","id","text","options"?}` → the agent is blocked on something only the user
     can settle: the backend does not answer (`backend1`, …), the Chrome extension is unavailable
     (`chrome1`, …), the user must sign in because the form gave no credentials (`login1`), or — the
     verify agent, near the end — checklist lines the user has since overruled wait for a yes
     (`checklist1`). POST `{"taskId":"T","question":{...}}`, wait for T's `kind=="answer"` — the
     server has already taken the question down and logged the answer — then POST
     `{"taskId":"T","step":5,"currentOperation":"Retrying…"}` and hand the answer over as
     "Talking to a running agent" says for an agent that may have gone cold: `agent-context.cjs`
     with `--state-file="<SESSION>/tasks/T/state/step-5-<prepare|verify>.md"` decides between
     SendMessage and a fresh agent of the same phase, whose prompt then carries
     `## You take over from an agent that asked the user a question`, the state file's path, the
     question and the answer. The agent checks again itself; never tell it the backend answers,
     and never tell it to mock a backend that does not. Going on without the extension is the
     user's choice between the options the agent offered — forward the one they picked.
   - prepare's `{"type":"result","phase":"prepare",…}` → back to 2.
   - verify's `{"type":"result","compliance":NN,…}` with `compliance>=99` → POST completed with
     `activeStep` at the next step, then
     `node "<SKILL_DIR>/scripts/checkpoint.cjs" --root=<ROOT> --task=T --step=5` (a restore point of
     the validated tree; `CHECKPOINT_NONE` is fine). The agent wrote the same object to
     `<SESSION>/tasks/T/results/step-5.json`: the final summary is built from that file
     (`post-result.cjs summary`), so keep none of its fields. When the final review is off
     (`FINAL(T)` false, or the task is on the legacy route), delete `<SESSION>/tasks/T/auth.json`
     now unless step 6 still runs after this one: no later step logs in.
   - `{"type":"error","report"}` (<99% after 3 cycles, a unit failure that stayed red, or an
     extension or backend that never became available) → failure protocol:
     `node "<SKILL_DIR>/scripts/post-result.cjs" fail --port=PORT --task=T --step=5`.
4. A `message` for step 5 goes to the prepare or verify agent that is running. While only authors
   run there is nobody to forward it to: POST
   `{"taskId":"T","step":5,"logEntry":"Message kept for the verification phase"}` — the verify
   agent gets it with the step's transcript (point 2). A `stop` while authors run: TaskStop every
   one of them; what the user sends next goes into the prompts of FRESH authors for the specs
   `validation-next.cjs` still lists — each finds its half-written spec file and carries on from it.
5. When the step ends — completed, failed or skipped — stop what it left running; the agents' own
   cleanup is the rule, this is the backstop:
   `node "<SKILL_DIR>/scripts/task-processes.cjs" cleanup --task-dir="<SESSION>/tasks/T"`.
   `STILL_RUNNING <port> <pid>` → say so in the step's report: the port stays on the list for the
   next cleanup. A split task then runs its fix-ups call (`task-info.cjs` → `split.commands.fixups`),
   so what validation fixed lands in the part that wrote those lines.
