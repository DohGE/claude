## Step 7 — Mockoon mocks (on demand, view-only, per task)

Never part of a task's run: the tile waits until the user clicks "Generate Mockoon mocks" on that
task's summary screen, which reaches you as `{"kind":"summary","decision":"mockoon","taskId":"T"}`.
It can run any number of times ("Regenerate" is the same step over the same file).

1. POST `{"taskId":"T","step":7,"status":"in_progress","activeStep":7,"progress":0}` — this also
   pulls the browser off the summary and onto the step's panel.
2. Spawn the mockoon agent from `references/mockoon-agent.md`, per "Spawning a sub-agent", on the
   model and effort `agents(T)` gives step 7 like any other step. It reads spec/plan (the task
   description and the story when refinement did not run), the contracts and the implemented code,
   and writes `<SESSION>/tasks/T/mockoon.json` (one environment on `localhost:3000`). The browser
   fetches that file itself from `/api/mockoon?taskId=T` — NEVER read it, never paste it into a
   message or into `/api/state`.
3. `{"type":"result","routes":N,"summary"}` → POST `{"taskId":"T","step":7,"status":"completed","progress":100}`;
   the panel then shows the JSON with a Copy button. Keep the route count and the summary only.
4. `{"type":"error","report"}` → POST `{"taskId":"T","step":7,"status":"failed","report":"<report>"}`, then wait
   for T's `kind=="decision"`: `retry` → the server has already put step 7 back
   `in_progress`, so just re-spawn the agent **fresh**; `finish` → the user went back to the summary, so leave the step
   failed and keep looping.
