## Step 2 — Feature Refinement (interactive, proxy Q&A)

1. POST `{"taskId":"T","step":2,"status":"in_progress","activeStep":2,"progress":5,"currentOperation":"Refinement in progress"}`.
2. Spawn the refinement agent from `references/refinement-agent.md`, per "Spawning a sub-agent".
3. Route this task's answers and its agent's final JSON:
   - `{"type":"question","id","text","options"?}` → POST `{"taskId":"T","question":{...}}`, wait for
     T's `kind=="answer"`. The server has already taken the question down and logged the answer
     (see "A send takes its gate off the screen"), so POST only
     `{"taskId":"T","step":2,"progress":<min(60, 20+5×answers so far)>}`, then SendMessage the
     answer text to the agent. You own the Q&A progress — the agent does not report between
     questions. A `message` for step 2 before its next JSON is the user adding to what they just
     said: SendMessage it to the same agent and keep waiting for that JSON.
   - `{"type":"result","summary","critical"}` → spec/plan/checklist now exist in `<SESSION>/tasks/T`. Go to 4.
   - `{"type":"error","report"}` → failure protocol for step 2.
4. Gate: POST `{"taskId":"T","reviewSummary":{"text":"<summary>","critical":[…]}}`, with `critical`
   copied from the result as it came (`[]` when it has none): the panel lists it as "Critical
   information" above the summary, where approving cannot pass it by. Wait for T's `kind=="decision"`:
   - `approve` → POST `{"taskId":"T","reviewSummary":null,"step":2,"status":"completed","activeStep":<the next step>}`; continue there.
     With `afterStop`, the agent first restores the plan it showed ("Stopping a step", point 3).
   - `feedback` → SendMessage the feedback to the agent; back to 3. The gate is off the screen
     already, and the agent's next result puts the revised plan up in its place. A feedback that
     comes more than 55 minutes after the agent's last result goes to a fresh agent instead, as
     "Revising step 1" point 5 says for a cold one — with the feedback in place of the revision
     paragraph.
