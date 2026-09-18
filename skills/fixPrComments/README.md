# /fixPrComments — background fixing of open pull request comments

Part of the `doh` plugin.
Takes a list of branches, pulls everything the reviewers of their pull requests left OPEN, and fixes it
in a background sub-agent per branch inside its own `git worktree`.
Each branch ends in one commit named after its pull request title, pushed, with the threads it fixed
closed on GitHub.
The user's own checkout is never touched, never checked out, never staged and never committed to.

## Usage

| Invocation | Effect |
|---|---|
| `/doh:fixPrComments feature/a` | one branch: collect, fix, verify, commit, push, resolve, clean up |
| `/doh:fixPrComments feature/a;feature/b,hotfix/c` | each listed branch, in parallel, one agent and one worktree each |
| `/doh:fixPrComments feature/a --dry-run` | collect and report only — no worktree, no agent, no change anywhere |
| `/doh:fixPrComments feature/a --no-push` | commit stays local; threads are then NOT resolved |
| `/doh:fixPrComments feature/a --keep-worktree` | leave the worktrees in place for inspection |
| `/doh:fixPrComments feature/a --project=<path>` | against the repository at `<path>` instead of the current directory |

The branch list is split on `,` and `;`, exactly like `codeReview`. Git allows both characters inside a
ref name, so a branch literally called `feature/a,b` cannot be named here — it would be read as two
branches and reported as two missing ones.

There is no "current branch" mode on purpose. A run commits and pushes to whatever it is pointed at,
so it is only ever pointed at branches the user typed.

## What counts as an open comment

Three sources, and only one of them has a resolved state:

- **Inline review threads** — read through the GitHub **GraphQL** API, which is the only place
  `isResolved` exists. Resolved threads are dropped before anything else happens. This is the reason
  the skill does not use the REST comment endpoints: they return every inline comment with no hint
  that its thread was closed, so a fixer built on them would re-fix work the reviewer already signed
  off on.
- **Conversation comments** — the comments on the pull request itself. GitHub has no resolved state
  for them, so all of them travel and the agent classifies them instead.
- **Review summaries** — the text a reviewer writes above their inline comments. Empty ones (a bare
  Approve click) and `PENDING` ones (an unsubmitted draft) are dropped.

An **outdated** thread — unresolved, but the code moved under it — is included, flagged, and carries
both its dead `line` and its `originalLine` plus the original `diffHunk`, so the agent locates the
subject by content rather than by a number that now means something else.

Comments from a GitHub App are flagged `isBot` and treated as noise by default, unless they name a
concrete defect.

## Verdicts

Every comment gets exactly one of three verdicts, and all three reach the report and the terminal:

- **fixed** — an actionable request; the code changed.
- **rejected** — actionable but not applied. Only three grounds count: it would break working
  functionality, it contradicts what the pull request is for, or its subject is in another repository.
  The ground is named per comment. "Risky", "large" and "I disagree" are not grounds.
- **answered** — never a request: praise, a question, "LGTM", CI noise, a discussion that ended in
  "never mind", or something the code already satisfies.

Only **fixed** threads are resolved on GitHub, and only after the commit has been pushed.

## The commit message

The pull request title up to and including its **first** colon, then ` CR`:

| Pull request title | Commit message |
|---|---|
| `feat(TASK-1): New Feature` | `feat(TASK-1): CR` |
| `feat(X): add: a thing` | `feat(X): CR` |
| `Fix login bug` | `Fix login bug: CR` |
| `: tidy up` | `tidy up: CR` |

A title with no colon has no prefix to cut, so the whole title becomes the prefix and the colon is
supplied — the message stays derived from the title rather than invented from the branch name.

The message is the whole commit: one line, no body, no trailer, no co-author line. One commit per
branch per run, never one per comment, and never `--amend`.

## Worktrees

Each branch is fixed in `<parent of project>/<project name>-worktrees/fixpr-<branch slug>` — next to
the repository, never inside it, so nothing a run creates can be staged by the project or walked by
its test runner. The same shape `implementNewFeature` uses.

Before the worktree is created, the branch is fetched and its relation to `origin` decided. Four
states are **refused**, each with the fix in the message, and none of them is forced through:

| State | Why it is refused |
|---|---|
| already checked out somewhere | usually the user's own terminal; two working copies of one branch diverge silently |
| no `origin/<branch>` | the fix could never reach the pull request |
| diverged from `origin/<branch>` | no push could succeed, and rebasing on the user's behalf is not this skill's call |
| the worktree directory already exists | a previous run left it; inspect it rather than overwrite it |

A branch that is **behind** its remote is fast-forwarded first, so the fixes are built on the code the
reviewer actually saw. A branch that is **ahead** keeps its unpushed commits and they ride along.

A fresh worktree has neither `node_modules` nor the gitignored local config, so it is bootstrapped:
`npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable` according to the lockfile, and
every `.env*` file of the project is copied to the same relative path. A failed install is a warning,
not a failure — it only means the verification gate will be skipped.

After a successful commit the worktree is removed. `git worktree remove` is called **without**
`--force`, ever: git refuses a worktree holding modified or untracked files, and that refusal is the
last guard against deleting work the verification gate stopped from being committed.

## Verification gate

Whatever the project's `package.json` actually has, in this order: `lint`, `typecheck` (or
`type-check`), `test`, `build`. Missing scripts are `skipped`, not failures; so is the whole gate when
the dependency install failed or there is no `package.json`.

**A red gate stops the commit.** The agent first tries to repair it — a failure its own fixes caused is
its problem — and if it stays red there is no commit, no push, no resolve, and the worktree is left in
place for inspection. A failure that was already there before the run (reproduced against `HEAD`) is
reported and treated as `skipped` rather than red.

## Output

One Markdown report per branch, in Polish, next to the codeReview reports: `<project>/.claude/doh/{branch}/`
when the project keeps a `.claude/` folder, otherwise `reports/{branch}/` inside this skill. It lists every
comment under `## Naprawione`, `## Odrzucone` and `## Bez akcji`, then `## Weryfikacja` and `## Wynik`.

Next to it sits the collected-comments JSON the agent read (`{branch}-fix-pr-comments-{stamp}.json`).
Both are capped at the 30 newest per folder, like the codeReview reports they share the directory with.
The reports live outside the worktree on purpose, so writing one can never end up in the commit.

The terminal summary is Polish and names, per branch: the commit and whether it was pushed, the
fixed/rejected/answered counts, every rejection with its ground, the verification result, and the
report path.

## GitHub access

The token comes from the `codeReview` skill's `github.cjs` — `GH_TOKEN`, `GITHUB_TOKEN`, the git
credential store, `.netrc`, the `gh` config file, then the `gh` CLI, in that order. No `gh` binary is
required. The account needs write access to the repository; resolving another person's thread also needs
write access, and a token without it produces a warning and leaves those threads open.

## Files

| Path | Role |
|---|---|
| `SKILL.md` | the orchestrator: arguments, collection, worktrees, dispatch, landing, summary |
| `references/fix-agent.md` | the background agent's prompt: verdicts, fixes, gate, commit, push |
| `scripts/pr-api.cjs` | GraphQL review threads and the resolve mutation, plus the two REST lists |
| `scripts/pr-comments.cjs` | argument parsing, the commit message, and the per-branch comment JSON |
| `scripts/worktree.cjs` | branch-state refusals, worktree creation, bootstrap, removal |
| `scripts/resolve-threads.cjs` | closes exactly the threads a run fixed |

`pr-api.cjs` and `pr-comments.cjs` require `../../codeReview/scripts/github.cjs` and
`../../codeReview/scripts/review-context.cjs` — the token discovery, the pull request lookup, the HTTP
primitive and the artifact-path conventions already live there, and the two skills ship in one plugin.

Tests: `node --test skills/fixPrComments/scripts/pr-api.test.cjs skills/fixPrComments/scripts/pr-comments.test.cjs skills/fixPrComments/scripts/worktree.test.cjs skills/fixPrComments/scripts/resolve-threads.test.cjs`
No test reaches the network: the GitHub layer is driven through an injected sender, and the git tests
run against real temporary repositories with their remote refs written by `git update-ref`.
