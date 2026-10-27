## Step 3 — Mockups (interactive, conditional)

Runs ONLY when `MOCKUPS(T)`. Otherwise skip the whole step: it stays `enabled:false` / `waiting`, the
stepper never shows it, and the step before it already moved `activeStep` past it.

The agent designs from what refinement settled when step 2 ran, and from the requirements form
alone when it did not — its brief tells the two apart by whether `spec.md` exists, so nothing
about it reaches the prompt. It draws the dark theme too when the application has one.
Every screen wears the project's own styling: the app's global stylesheet compiled with the
project's Sass (`scripts/project-styles.cjs`) and, when the project has a Storybook, its components
as their stories render them (`scripts/storybook-snapshot.cjs`, from a build it makes in the
session when there is none) — the agent's brief says how.

1. POST `{"taskId":"T","step":3,"status":"in_progress","activeStep":3,"progress":5,"currentOperation":"Designing screens"}`.
2. Spawn the mockup agent from `references/mockup-agent.md`, per "Spawning a sub-agent".
3. Keep only `mockupRounds(T)`, for the progress bar. The chat transcript and the `rev` the UI
   re-renders on are the SERVER's — never hold either in your context. Loop on the agent's final JSON:
   - `{"type":"mockup","summary","screens":[{"id","view","title","file"}]}` → `mockupRounds(T)++`,
     take the round's screenshots (below), then POST
     `{"taskId":"T","step":3,"progress":<min(90, 20+10×mockupRounds)>,"currentOperation":"Waiting for your review","mockupReview":{"text":"<summary>","screens":[…]},"mockupChat":{"role":"agent","text":"<summary>"}}`.
     Omit `rev`: the server stamps the next one itself, so a round can never reuse a number and
     leave the panel locked. The chat is not part of the round at all — it belongs to step 3 and
     the server appends `mockupChat` to it, which is why clearing `mockupReview` never erases the
     conversation.
     Take the screenshots with `node "<SKILL_DIR>/scripts/screenshot-mockups.cjs" "<SESSION>/tasks/T"`.
     It refills `<SESSION>/tasks/T/mockup-screenshots/` with one full-page PNG per manifest entry —
     every state of every view, each loaded through its `#<id>` fragment — at desktop width
     (1280 px), named `<id> <view> - <title>.png`, the id numbered `{0-9}.{0-99}` (view, then
     state, both from 0); the panel's "Open screenshots folder"
     button opens that folder for the user. It prints one line, a FIXED IDENTIFIER:
     `SCREENSHOTS <count> <dir>`, or `SCREENSHOTS_FAILED <reason>` — then post the round anyway,
     with `Screenshots could not be taken: <reason>` at the end of the `mockupChat` text. The first
     time the reason says the skill's Playwright is not installed or Chromium did not start, run
     `npm --prefix "<SKILL_DIR>" install` and
     `node "<SKILL_DIR>/node_modules/@playwright/test/cli.js" install chromium`, then try once more.
     Never Read the screenshots: they are for the user.
     Then wait for T's `kind=="mockup"`:
     - `decision=="feedback"` → SendMessage the feedback text to the agent, and post nothing: the
       server already took the round off the screen, put the step at `Reworking the mockups…` and
       appended the line to the transcript — a `mockupChat` copy would show it twice. What the user
       adds while the agent reworks comes from the step's composer as `message`: SendMessage each
       one as it comes, in order, and keep waiting for the round. A feedback more than 55 minutes
       after the agent's last round goes to a fresh agent ("Revising step 1" point 5). Back to 3.
     - `decision=="approve"` → SendMessage exactly (a FIXED IDENTIFIER — English verbatim):
       `APPROVED — record the approved design as your brief's Approval section says, then reply
       with the result JSON.` Back to 3.
     - `decision=="approve"` with `duringRework: true` → the user approved the round on screen while
       the agent was reworking it after their feedback. Stop the agent with TaskStop (keep its id),
       then SendMessage `[Stopped] The user stopped you mid-work; what follows is what they sent next.`
       and, on the next line, the same `APPROVED — …` text: the brief has the agent put back the
       round the user saw before recording it. Back to 3.
     - `decision=="artifact"` → the "Create Claude artifact" button: the user wants the round on
       screen as a Claude artifact. The agent is not involved and the round stays up for review.
       Run `node "<SKILL_DIR>/scripts/mockup-artifact.cjs" "<SESSION>/tasks/T" --title="<T's branch>"`
       → one JSON line, `{page, files, screens}` (or `{error}`): a gallery page of every view and
       state at desktop and mobile width, and the screens and stylesheets it frames. Publish it with
       the Artifact tool - `file_path` = `page`, `files` = `files`, a one-sentence description naming
       the feature - always from that same `page` path, so a later press updates the same artifact.
       Then POST `{"taskId":"T","step":3,"mockupChat":{"role":"agent","text":"Claude artifact: <url>"}}`
       - or, when the script or the publish failed, the reason in the same field - and keep waiting
       for the round.
   - `{"type":"result","summary","screens":[…]}` (only ever arrives after the approval message) →
     POST `{"taskId":"T","step":3,"status":"completed","progress":100,"mockupReview":null,"activeStep":<the next step>}`
     and continue there. Keep the screen count and the summary only — never the mockup markup.
   - `{"type":"error","report"}` → failure protocol for step 3.
