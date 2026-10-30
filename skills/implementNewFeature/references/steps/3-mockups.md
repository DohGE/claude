## Step 3 — Mockups (interactive, conditional)

Runs ONLY when `MOCKUPS(T)`. Otherwise skip the whole step: it stays `enabled:false` / `waiting`, the
stepper never shows it, and the step before it already moved `activeStep` past it.

The agent designs from what refinement settled when step 2 ran, and from the requirements form
alone when it did not — its brief tells the two apart by whether `spec.md` exists, so nothing
about it reaches the prompt. It draws the dark theme too when the application has one, unless the
form switched "Dark theme mockups" off (`Dark mockups: off` in requirements.md's `## Pipeline steps`).
When the user's feedback adds, removes or rewords text on a screen, the agent brings the checklist
(or `ui-design.md`) in line at approval, so validation never measures the screens against a
requirement the user has since changed.
Every screen wears the project's own styling: the app's global stylesheet compiled with the
project's Sass (`scripts/project-styles.cjs`) and, when the project has a Storybook, its components
as their stories render them (`scripts/storybook-snapshot.cjs`, from a build it makes in the
session when there is none) — the agent's brief says how.

1. POST `{"taskId":"T","step":3,"status":"in_progress","activeStep":3,"progress":5,"currentOperation":"Designing screens"}`.
2. Spawn the mockup agent from `references/mockup-agent.md`, per "Spawning a sub-agent".
3. Keep only `mockupRounds(T)`, for the progress bar. The chat transcript and the `rev` the UI
   re-renders on are the SERVER's — never hold either in your context. Loop on the agent's final JSON:
   - `{"type":"mockup","summary","screens":[…]}` → `mockupRounds(T)++`, then put the round on
     screen with ONE call — never copy its screens into a body yourself:

         node "<SKILL_DIR>/scripts/mockup-round.cjs" --task-dir="<SESSION>/tasks/T" --port=PORT --task=T --round=<mockupRounds(T)>

     It reads the screens from the manifest and the summary from the `round.md` the agent wrote
     for the round, takes the screenshots (`screenshot-mockups.cjs`: one full-page PNG per state at
     1280 px into `<SESSION>/tasks/T/mockup-screenshots/`, named `<id>-<lm|dm>-<view>-<title>.png`,
     for the panel's "Open screenshots folder" button) and POSTs the round — progress, `Waiting for
     your review`, `mockupReview`, the `mockupChat` line; the server stamps `rev` itself, so a round
     never reuses a number. Its first line (FIXED IDENTIFIERS):
     - `ROUND_POSTED <screens>` → the round is on screen.
     - `ROUND_HELD <n> <file or url>…` → a screen loads a stylesheet, font or image it does not
       inline, so the preview would show it unstyled. Nothing was posted: SendMessage the agent
       `Your round loads files the preview cannot load: <the files>. Inline them (CSS in <style>, fonts and images as data: URIs), then end the round again.`
       (a FIXED IDENTIFIER, English verbatim) and wait for its next `mockup` JSON. When that round
       is held again, run the call once more with `--allow-external`: it posts the round with a
       note saying which files are missing.
     - `ROUND_FAILED <reason>` → the manifest is missing or the server refused the body: SendMessage
       the reason to the agent and wait for its next round.
     The second line is the screenshot script's own: `SCREENSHOTS_FAILED <reason>` naming a missing
     Playwright or a Chromium that did not start → run `npm --prefix "<SKILL_DIR>" install` and
     `node "<SKILL_DIR>/node_modules/@playwright/test/cli.js" install chromium` once, for the next
     round. Never Read the screenshots: they are for the user.
     When `artifact(T)` is set — the user created the artifact on an earlier round — every new
     round updates it first: the same `mockup-artifact.cjs` call and the same publish from the same
     `page` path, so the artifact always shows the round on screen; then pass
     `--artifact-url=<url>` to `mockup-round.cjs` (the publish may return a new url), or
     `"--artifact-note=Claude artifact not updated: <reason>"` when the publish failed. The
     approved round is the last one the artifact shows: nothing changes it after approval.
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
       Then POST `{"taskId":"T","step":3,"mockupArtifact":"<url>","mockupChat":{"role":"agent","text":"Claude artifact: <url>"}}`
       and keep the url as `artifact(T)`. `mockupArtifact` is what the page pins to the top of the
       screen — the button is gone once pressed, so this bar is the only way back to the artifact.
       - or, when the script or the publish failed, the reason in the same field - and keep waiting
       for the round.
   - `{"type":"result","summary","screens":[…]}` (only ever arrives after the approval message) →
     POST `{"taskId":"T","step":3,"status":"completed","progress":100,"mockupReview":null,"activeStep":<the next step>}`
     and continue there. Keep the screen count and the summary only — never the mockup markup.
   - `{"type":"error","report"}` → failure protocol for step 3.
