# Lean mode — caveman ultra and headroom for every doh skill

Part of the `doh` plugin, added in 0.23.0.

Every doh skill (`/doh:codeReview`, `/doh:fixPr`, `/doh:implementNewFeature`) runs in lean mode, and so does every sub-agent it spawns.
Nothing has to be switched on: invoking the skill is enough.
Two independent layers cut tokens:

| Layer | What it cuts | Where it lives |
|---|---|---|
| caveman ultra | output: the chat prose of the orchestrator and of every sub-agent | this plugin, `shared/caveman-ultra.md` |
| headroom | input: tool results and context sent to the API | a local proxy, installed once per machine |

## caveman ultra

The rules are `shared/caveman-ultra.md`.
They are adapted from the caveman skill by Julius Brussee (MIT, notice in `shared/CAVEMAN-LICENSE`), fixed at its `ultra` level, plus the boundaries doh needs.

| Who | How the rules reach it | After auto-compaction |
|---|---|---|
| the orchestrator, i.e. the session that ran the skill | the block between `lean-mode:start` and `lean-mode:end` at the top of the skill's `SKILL.md` | kept: Claude Code re-attaches the first 5 000 tokens of every invoked skill, and a test keeps the block inside them |
| every sub-agent spawned or resumed afterwards | `hooks/hooks.json` runs `scripts/lean-mode.cjs --event=subagent` on `SubagentStart`, which returns the rules as `additionalContext` | kept: Claude Code injects them again once a sub-agent's compaction drops them |

Activation is a `PreToolUse` hook in the frontmatter of each `SKILL.md` (`scripts/lean-mode.cjs --event=activate`).
Claude Code registers a skill's frontmatter hooks when the skill is invoked, typed as a slash command or called by the model, and keeps them for the rest of the session.
The first tool call after that creates a flag named after the session id in `<os tmpdir>/claude-doh-lean/`.
`SubagentStart` fires for every sub-agent of every session, but injects the rules only where that flag exists.
A session that never ran a doh skill is left exactly as it was.

What lean mode never compresses:

- files written for a human: reports, spec, plan, checklist, validation and review reports, pull request replies, commit messages, code comments, docs and UI text;
- security warnings, confirmations of irreversible actions, and answers when the user asks what was meant;
- code, paths, commands, error strings, every FIXED IDENTIFIER, the effort keywords `think` / `think hard` / `ultrathink`, and every field a brief requires in a reply.

Saying "normal mode" (or "stop caveman") brings the orchestrator's chat back to normal prose.
Sub-agents stay terse, because nobody but the orchestrator reads them.

### Why it is built this way

- One plugin-level `SubagentStart` hook instead of one per skill.
  Claude Code never deduplicates hooks declared by different skills, so a session that ran two doh skills would give every sub-agent two copies of the rules.
- The flag is created with `O_EXCL`, and every later call returns before doing anything else.
  The frontmatter hook sets `once: true`, but Claude Code 2.1.280 runs a plugin skill's `once` hook on every tool call (measured: three calls, three runs), so nothing depends on it.
- The script reads the hook payload at its first complete JSON object, not at EOF.
  On Windows the host can hold the pipe open after writing, and a reader waiting for EOF burns the whole hook timeout.
- Every hook fails open.
  Any error ends in exit 0 with no output, which means lean mode off, never a blocked tool call.
- Flags older than a week are swept on the next first activation.

### Changing the rules

Edit `shared/caveman-ultra.md`, then copy it into every skill:

    node scripts/lean-mode.cjs --sync

`scripts/lean-mode.test.cjs` fails while any `SKILL.md` block differs from the source, or sits past the part compaction re-attaches.

## headroom

[headroom](https://github.com/headroomlabs-ai/headroom) is a local proxy.
It compresses what Claude Code sends to the API (tool output, file reads, logs) and keeps the originals retrievable through the `headroom_retrieve` MCP tool.
A skill cannot switch it on for its own session only.
The proxy is selected by `ANTHROPIC_BASE_URL` in the `env` of `~/.claude/settings.json`, which every session on the machine reads, and every in-process sub-agent shares its session's URL.
So headroom is installed once per machine and routes every session, the orchestrator and all its sub-agents included.

Install on Windows (PowerShell):

    winget install --id astral-sh.uv -e
    uv tool install --python 3.13 "headroom-ai[all]"
    setx HEADROOM_BEACON off
    setx HEADROOM_PROTECT_TOOL_RESULTS "Read,Grep,Glob,Edit,Write"

Open a new terminal, so that the next commands see both variables, and run:

    headroom init -g claude
    headroom doctor

Then restart every Claude Code window, so the hooks that restart the proxy inherit both variables too.

- `HEADROOM_BEACON=off` stops the anonymous usage summary that headroom otherwise sends to its beacon server every 5 minutes and at exit.
  `headroom init` leaves the beacon on.
- `HEADROOM_PROTECT_TOOL_RESULTS` passes the results of the listed tools through verbatim for the whole session.
  Without it, token mode may compress older file reads, while Edit needs an exact `old_string` and a review needs line-accurate reads.

`headroom init -g claude` does four things:

- writes `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and `ENABLE_TOOL_SEARCH=true` into the `env` of `~/.claude/settings.json`;
- adds hooks there that start the proxy whenever it is down, at session start and before every Bash or PowerShell call;
- installs the `headroom` Claude Code plugin, which runs the same hooks once more;
- registers the `headroom_retrieve` MCP tool.

Claude Code applies the new `env` without a restart, so the running session goes through the proxy at once.

### When the proxy is down

Every request then fails with `ECONNREFUSED`, `/compact` included.
The hooks time out after 15 s, and a cold start of the proxy takes about 24 s, so after a reboot the proxy can stay down.
Start it from any terminal with `headroom init hook ensure --profile init-user`; the command returns once the proxy answers, or after 45 s.
Do not run `headroom proxy` by hand: it ignores the deployment profile, runs in cache mode instead of token mode, and sends the beacon unless `HEADROOM_BEACON=off` is set.
doh installs no supervisor that keeps the proxy alive across reboots; `headroom install --help` lists headroom's persistent presets.

### Limits

- Behind a custom `ANTHROPIC_BASE_URL`, Claude Code turns off `/remote-control`, on-demand tool loading and the 1M-token context window.
  `ENABLE_TOOL_SEARCH=true` brings on-demand tool loading back.
  For the 1M window, `headroom doctor` points to `headroom wrap claude --1m` (headroom issue #1158).
- Compression of plain-text output, such as a test log, is lossy: labels, numbers and error wording can change.
  Such a result carries a `hash=<hash>` marker, and the lean-mode rules tell every agent to call `headroom_retrieve` before quoting, counting or editing from it.

### What doh checks

doh only checks headroom.
The first tool call of a doh skill verifies that `ANTHROPIC_BASE_URL` points at a local proxy answering `/readyz`.
If it does not, the user sees one warning for that session, and the skill runs on without compression.
Set `DOH_LEAN_HEADROOM=off` to skip the check.

### Undo

    headroom unwrap claude
    claude plugin uninstall headroom@headroom-marketplace
    reg delete HKCU\Environment /v HEADROOM_BEACON /f
    reg delete HKCU\Environment /v HEADROOM_PROTECT_TOOL_RESULTS /f
    uv tool uninstall headroom-ai

`unwrap` removes the proxy `env`, the hooks and the MCP registration from `settings.json` and stops the proxy.
`~/.headroom` keeps the logs, the deployment manifest and the install id; delete it to remove them.
