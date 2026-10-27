## Step 8 — Story Description (interactive, conditional)

Runs ONLY when `STORY(T)`, as the last step before implementation. Its id is 8 only because ids
are never renumbered; the stepper shows its tile between Mockups and Implementation. Otherwise
skip it like step 3.

1. POST `{"taskId":"T","step":8,"status":"in_progress","activeStep":8,"progress":5,"currentOperation":"Writing the story"}`.
2. Spawn the story agent from `references/story-agent.md`, per "Spawning a sub-agent". It picks its
   sources from what exists — the refinement and mockup results when those steps ran, the task
   description and the uploaded mockups when they did not — so nothing about the switches goes
   into the prompt.
3. Loop on the agent's final JSON:
   - `{"type":"result","criteria":N,"summary"}` → `<SESSION>/tasks/T/story.md` exists. Keep the
     count and the summary only: the browser fetches the story itself from
     `/api/story?taskId=T`, so NEVER read story.md, and never paste it into a message or into
     `/api/state`. Open the gate — the plan gate's `reviewSummary`, whose `rev` the server stamps
     the same way — with
     `{"taskId":"T","step":8,"progress":90,"currentOperation":"Waiting for your review","reviewSummary":{"text":"<summary>"},"logEntry":"Story written: <N> acceptance criteria"}`,
     then wait for T's `kind=="decision"`:
     - `feedback` → SendMessage the feedback text to the agent, with its attachments line, and
       post nothing: the server already took the gate off the screen, put the step at `Reworking
       the story…` and put the feedback in its transcript. What the user adds while the agent
       reworks comes from the step's composer as `message`: SendMessage each one as it comes, in
       order. Back to 3 — every result opens the gate again, and its new `rev` puts the revised
       story on screen.
     - `approve` → POST
       `{"taskId":"T","reviewSummary":null,"step":8,"status":"completed","progress":100,"activeStep":4}`
       and start step 4 — with `afterStop`, only once the agent has restored the story it
       showed ("Stopping a step", point 3). When a feedback you forwarded has no result yet, wait for the agent's
       next result first and post this instead of a new gate: the user approved with the change
       on its way, and implementation must not start on a story that is being rewritten.
   - `{"type":"error","report"}` → failure protocol for step 8.
4. A result that arrives after step 8 completed means the agent was still busy with something the
   user sent — a second feedback, or a line typed before the gate opened — and story.md was
   rewritten: POST only `{"taskId":"T","step":8,"logEntry":"Story updated"}`. The steps already
   past it read the file when they start, so say so in the terminal if the user asks why a running
   step missed the edit.
