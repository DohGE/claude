---
name: fixPrComments
description: Use when the user wants the open review comments of one or more pull requests fixed - takes a list of branches separated by `;` or `,` like codeReview, pulls every UNRESOLVED review thread plus the pull request conversation from the GitHub API, fixes them in a background sub-agent per branch inside its own git worktree, verifies with the project's own lint/test/build, and lands one commit named after the pull request title up to its first colon plus `CR`
---

# fixPrComments — background fixing of open pull request comments

You are the **orchestrator**. You never read a comment body, never open a project file and never fix
a line of code yourself: one background sub-agent per branch does all of that inside its own git
worktree, and you hold only paths, counts and short summaries.

The user's own checkout is never touched. Every branch is fixed in a worktree created next to the
repository and removed afterwards, so the tree the user is standing in keeps whatever it held.

## Hard rules

- NEVER read `commentsPath`, the project's files or the worktree's files into your own context — pass
  **paths** to the agent. A review of a busy pull request runs to tens of thousands of words, and
  reading one branch's comments is what makes the third branch run out of room.
- Branches run in PARALLEL, one background agent each. Never fix a branch yourself, not for a single
  comment, not to save time, not because only one branch was named.
- A resolved thread is finished work. The collector already dropped them; never reach for the REST
  comment endpoints, which cannot tell you a thread was closed.
- A thread is marked resolved on GitHub only after its fix was COMMITTED and PUSHED, and only for the
  ids the agent reported as `fixed`. Resolving anything else tells every reviewer on the pull request
  that their comment was addressed when it was not.
- One branch failing never stops the others.

## Step 1 — Parse the arguments

1. `SKILL_DIR` = this skill's base directory (from the skill header). `PROJECT` = the current working
   directory, unless `--project=` overrides it.
2. Strip the flags FIRST, from the whole argument list, wherever they sit — an unstripped flag is
   mapped below as a branch name:
   - `--project=<path>` → `PROJECT=<path>`. Everything is relative to it: which repository is read,
     where the worktrees are created and where the artifacts land.
   - `--dry-run` → collect and report only. No worktree, no agent, no commit, no push, no resolve.
   - `--no-push` → the agent commits but does not push. Threads are then NOT resolved either: a fix
     nobody can see on GitHub is not an addressed comment.
   - `--keep-worktree` → leave every worktree in place after the run.
3. Everything REMAINING is the branch list, verbatim. The collector splits it on `,` and `;`.
   No arguments at all → stop and say, in Polish, that the skill needs at least one branch name
   (`/doh:fixPrComments feature/a;feature/b`). Never fall back to the current branch: a run that
   guesses its own target commits to a branch nobody named.

## Step 2 — Collect the open comments (one call, all branches)

Run (Bash tool):

    node "<SKILL_DIR>/scripts/pr-comments.cjs" --branches="<arguments verbatim>" --project="<PROJECT>"

Parse the JSON from stdout:

- Report every `errors[]` entry to the user immediately, in Polish. Each one names the branch it
  belongs to and drops only that branch.
- Report every `warnings[]` entry, in Polish. A branch whose pull request had nothing open is a
  warning, not an error — say so plainly rather than letting it look like a failure.
- `targets` empty → stop here, after reporting. There is nothing to fix.

Each target carries: `branch`, `pr` (`number`, `title`, `url`, `base`), `commitMessage`,
`commentsPath`, `reportPath`, `promptPath`, `worktree`, and `counts` (`openThreads`,
`resolvedThreads`, `outdatedThreads`, `conversation`, `reviews`, `candidates`). Keep exactly those;
the comment bodies stay in the file.

Tell the user, in Polish, what was found per branch — the pull request number and title, how many
threads are open, how many were already resolved and skipped, how many conversation comments and
review summaries there are.

**`--dry-run` stops here**, after that listing.

## Step 3 — One worktree per branch

For each target, in order:

    node "<SKILL_DIR>/scripts/worktree.cjs" --action=add --branch="<branch>" --project="<PROJECT>"

Parse its JSON. `errors[]` non-empty → that branch is OUT of the run: report the error in Polish and
move to the next target. The errors are deliberate refusals, each with the fix in its text, and none
of them is something to work around:

- the branch is already checked out somewhere — usually the user's own terminal is standing on it;
- it has no `origin/<branch>`, so the fix could never reach the pull request;
- it has diverged from `origin/<branch>`, so no push could succeed;
- the worktree directory is already there from an earlier run.

Never pass `--force` to git, never delete the directory in the way, and never re-run the command
hoping for a different answer. Report `warnings[]` too — a fast-forward, an install that failed (so
the verification gate will be skipped), and the `.env*` files copied in.

## Step 4 — One background agent per branch

For every branch that got a worktree: FIRST render its brief, THEN spawn the agent on it. Spawn all
of them, in the BACKGROUND, before you wait for any of them.

### 4a — Render the brief

    node "<SKILL_DIR>/../../scripts/render-agent-prompt.cjs" --template="<SKILL_DIR>/references/fix-agent.md" --out="<promptPath>" --set=ROOT=<worktree> --set=BRANCH=<branch> --set=PR_NUMBER=<pr.number> --set=PR_URL=<pr.url> --set=COMMENTS=<commentsPath> --set=REPORT=<reportPath> --set=COMMIT_MESSAGE=<commitMessage> --set=PROJECT=<PROJECT> --set=SKILL_DIR=<SKILL_DIR> --set=PUSH=<yes|no> --set=LANGUAGE=<language>

| Value | Where it comes from |
|---|---|
| `ROOT` | the target's `worktree` |
| `BRANCH`, `PR_NUMBER`, `PR_URL` | from the target |
| `COMMENTS`, `REPORT` | the target's `commentsPath` and `reportPath` |
| `COMMIT_MESSAGE` | the target's `commitMessage`, verbatim — never re-derive it yourself |
| `PROJECT`, `SKILL_DIR` | the values from Step 1 |
| `PUSH` | `no` when `--no-push` was passed, otherwise `yes` |
| `LANGUAGE` | the language THIS conversation is being held in, named plainly (`Polish`, `English`, …) — never a locale code, never "the user's language" left unresolved |

`errors[]` non-empty → that branch is OUT of the run, exactly like a refused worktree: report the
error in Polish, remove the worktree, move on. The commonest one names a placeholder nobody filled,
and the fix is the missing `--set`, never spawning the agent without it.

**Never assemble that prompt by hand.** Reading `fix-agent.md` into your own context and writing the
substituted copy back out as the Agent argument costs you the whole file TWICE per branch — the same
context the comment bodies are kept out of on purpose. The renderer also refuses a brief with an
unfilled placeholder; a hand-made one delivers `{{ROOT}}` to the agent as if it were a path.

### 4b — Spawn

Agent tool, `subagent_type: "general-purpose"`, background. The prompt is short and points at the
rendered brief — it never repeats it:

    Your complete instructions are in the file <promptPath>. Read it in full with the Read tool
    before doing anything else, then follow it exactly. It is already resolved: every path,
    branch and setting it names is final. You fix the open review comments of pull request
    #<pr.number> on branch <branch>, and you end with the single JSON object it specifies.

Anything this particular run has to add — a note about a previous failure, something the user said
after the fact — goes in that spawn prompt, under its own heading, after the pointer. It never goes
into the rendered file.

Then wait for the completion notifications and handle each branch as it lands. Never predict a
result that has not arrived, and never summarise a branch whose agent is still running — if the user
asks in the meantime, say it is still working.

Each agent ends with one JSON object. An agent that finishes with NO parsable JSON — it crashed, was
cut off, or answered in prose — counts as `{"type":"error"}` for its branch: nothing is resolved,
the worktree is kept, and the report says the agent ended without a result.

## Step 5 — Land each branch

On `{"type":"result", …}`:

1. **Resolve the threads**, but only when `fixedThreadIds` is non-empty AND `committed` is true AND
   `pushed` is true. Any of the three missing → skip this point entirely and say why in the summary.

       node "<SKILL_DIR>/scripts/resolve-threads.cjs" --project="<PROJECT>" --threads="<id,id,…>"

   Report `failed[]` entries in Polish — usually a token that may not resolve other people's threads.
   A failed resolve never fails the branch: the fix is pushed, and an open thread is a leftover the
   user can close by hand.
2. **Remove the worktree**, unless `--keep-worktree` was passed or the agent reported
   `committed: false` with work still in the tree:

       node "<SKILL_DIR>/scripts/worktree.cjs" --action=remove --branch="<branch>" --project="<PROJECT>"

   A refusal here means the worktree still holds uncommitted files: report the path in Polish and
   leave it alone. Never reach for `--force` — that would delete the very work the verification gate
   protected.

On `{"type":"error", …}`: resolve nothing, remove nothing. Report the branch as failed, with the
agent's report and the path of the worktree the user can go and inspect.

## Step 6 — Terminal summary (Polish)

After every branch has landed, print one summary, in Polish, and nothing else:

- one row per branch: pull request number and title, commit message and sha (or why no commit was
  made), whether it was pushed, how many comments were fixed / rejected / left without action, and
  how many threads were resolved on GitHub;
- for every REJECTED comment, its one-line ground — this is the part the user has to act on, and it
  exists nowhere else in their terminal;
- the verification result per branch (which commands ran, which passed, which were skipped and why);
- where the report is (`reportPath`) and, for a branch whose worktree survived, where the worktree is
  and why it is still there;
- every error and warning from Steps 1–5 that has not already been reported.

Then stop. Do not offer to merge, do not offer to open a pull request, and do not remove a worktree
the user has not been told about yet.

## Skip rationalizations — all invalid

| Excuse | Reality |
|---|---|
| "One branch, one comment — I will just fix it here" | The fix happens in a worktree, in a background agent, always. A fix made in the user's own checkout is a change they did not ask for in a tree they were using. |
| "Let me read the comments to see what we are dealing with" | You never read `commentsPath`. The counts in `targets[]` are what you report; the bodies are the agent's job. |
| "The branch is checked out in the main worktree, I will just use it" | That is the user's working tree. The refusal names the branch and the checkout holding it; report it and move on. |
| "The push was rejected, I will rebase and retry" | Every state that cannot fast-forward was refused before the agent started, so a rejection means the remote moved during the run. Leave the commit local and say so. |
| "The thread is obviously handled, resolve it too" | Only ids the agent returned in `fixedThreadIds`, and only after a push. Everything else is a public claim you cannot back. |
| "The gate failed but the fixes look right" | A red gate means no commit. The worktree stays for the user to inspect — that is the outcome, not a problem to route around. |
| "Nothing was committed, so I will clean up the worktree" | An uncommitted worktree holds work. Removing it destroys it; git refuses for the same reason. |
| "The agent is still running, I will summarise what it will probably find" | A result that has not arrived is not a result. Say it is still running. |
| "I will read `fix-agent.md` and paste it into the prompt myself" | That is the file twice over, per branch, in the context you emptied of comment bodies to make room. Render it with the script and pass the path. |
