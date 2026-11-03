# /fixPr — background fixing of open pull request comments and red checks

Part of the `doh` plugin. Renamed from `/fixPrComments` on 2026-09-18, when it took on the checks.

Takes a list of branches and leaves each pull request with nothing open against it: everything the
reviewers left OPEN, **and** every red command in the project's own `lint` / `typecheck` / `test` /
`build` gate — whoever made it red.
All of it in a background sub-agent per branch inside its own `git worktree`.
Each branch ends in one commit named after its pull request title, pushed, with the threads it fixed
closed on GitHub.
The user's own checkout is never touched, never checked out, never staged and never committed to.

A branch whose pull request has no open comments left is **not** skipped: it runs for its gate alone.
That is the branch a reviewer most often wants finished off.

## Usage

| Invocation | Effect |
|---|---|
| `/doh:fixPr feature/a` | one branch: collect, fix the comments, bring the gate green, commit, push, resolve, clean up |
| `/doh:fixPr feature/a;feature/b,hotfix/c` | each listed branch, in parallel, one agent and one worktree each |
| `/doh:fixPr feature/a --dry-run` | collect and report only — no worktree, no agent, no change anywhere |
| `/doh:fixPr feature/a --no-push` | commit stays local; threads are then NOT resolved |
| `/doh:fixPr feature/a --keep-worktree` | leave the worktrees in place for inspection |
| `/doh:fixPr feature/a --local=da3d32cd,b4309764` | fix those findings of the branch's doh codeReview reports (the 8-hex id on a finding of the report page, newest run first) instead of the pull request's comments; everything else - worktree, gate, commit, rebase, push - as without it, and no thread is resolved |
| `/doh:fixPr feature/a --project=<path>` | against the repository at `<path>` instead of the current directory |

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

Comments from a GitHub App are flagged `isBot` wherever they appear — inline threads included. A
flagged **conversation** comment is treated as noise by default, unless it names a concrete defect;
an inline one is read like any other thread, because it is anchored to a line of the change.

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

The **prefix** is the pull request title up to and including its first colon:

| Pull request title | Prefix |
|---|---|
| `feat(TASK-1): New Feature` | `feat(TASK-1)` |
| `feat(X): add: a thing` | `feat(X)` |
| `Fix login bug` | `Fix login bug` |
| `: tidy up` | `tidy up` |

A title with no colon has no prefix to cut, so the whole title becomes the prefix and the colon is
supplied — the message stays derived from the title rather than invented from the branch name.

The **suffix** says what the run actually fixed, so it can only be decided once the work is done:

| What the run fixed | Message |
|---|---|
| at least one review comment | `feat(TASK-1): CR` |
| no comment, only red checks | `feat(TASK-1): Fix lint`, `feat(TASK-1): Fix lint, unit tests, build` |
| nothing | no commit |

The four labels are `lint`, `typecheck`, `unit tests` and `build`, in gate order, comma-separated, and
only for the steps this run took from red to green. A step that went red mid-run because one of the
agent's own fixes broke it is not among them — cleaning up after yourself is not a repair.

`Fix` and the four labels are **fixed identifiers**: written in English verbatim, even though the
agent's report and the terminal summary are in the user's language. A translated label would split
the repository's history between runs and nothing downstream could notice.

Because the suffix depends on the outcome, the agent builds the message and reports it back; the
collector supplies the prefix and the ready-made `CR` form, and the orchestrator prints whatever the
agent used rather than deriving it a second time.

The message is the whole commit: one line, no body, no trailer, no co-author line. One commit per
branch per run, never one per comment, never one per check, and never `--amend`.

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

A fresh worktree has neither `node_modules` nor the gitignored local config, so it is bootstrapped.
When its lockfile is the main checkout's, that checkout's `node_modules` is linked in (a junction on
Windows) - five worktrees installed one after another took about twenty minutes before the first
agent could start (2026-11-03). Otherwise, or with `--deps=install`, it installs: `npm ci` /
`pnpm install --frozen-lockfile` / `yarn install --immutable` according to the lockfile. The link is
made only where git ignores it, so no `git add` can carry it into a commit. Every `.env*` file of the
project is copied to the same relative path, and so is the project's gitignored doh config
(`.claude/doh/instructions/`, `.claude/doh/local/`, `.claude/doh/checks.json`), so the agent and its
self-review walk the project's own rules. A failed install is a warning, not a failure — it only means
the verification gate will be skipped.

After a successful commit the worktree is removed. `git worktree remove` is called **without**
`--force`, ever: git refuses a worktree holding modified or untracked files, and that refusal is the
last guard against deleting work the verification gate stopped from being committed. Before it, the
self-review's reports (`.claude/doh/codeReview/runs/`, gitignored, so git would delete them) move to
`<project>/.claude/doh/<branch>/codeReview/runs/`, and every link in the tree is unlinked: git's
recursive delete walks into a junction and empties what it points at. Take a worktree down with
`worktree.cjs --action=remove`, never with `git worktree remove --force`.

## The gate

The project's own gate config when it has one: `.claude/doh/checks.json` (or `doh.checks` in
`package.json`) names a command per step, and the scripts below are not looked at:

```json
{
  "maxParallel": 2,
  "steps": {
    "lint": { "command": "npx ng lint dpx --lint-file-patterns {files} --quiet", "files": "^projects/dpx/.+\\.(ts|html)$" },
    "typecheck": { "command": "npx tsc -p projects/dpx/tsconfig.app.json --noEmit", "files": "^projects/(dpx|c-lib)/.+\\.ts$" },
    "test": [
      { "command": "npx jest --config projects/dpx/jest.config.ts --setupFilesAfterEnv jest-preset-angular/setup-jest --findRelatedTests {files}", "files": "^projects/dpx/.+\\.ts$" },
      { "command": "npx jest --config projects/c-lib/jest.config.ts --findRelatedTests {files}", "files": "^projects/c-lib/.+\\.ts$" }
    ],
    "build": { "command": "npx ng build dpx", "files": "^projects/(dpx|c-lib)/" }
  }
}
```

`files` is a regex over the paths the pull request changes since `origin/<base>` (`--changed-since`,
uncommitted and untracked files included): a command none of whose files changed is skipped, and
`{files}` becomes the paths it matched - cut into several commands where one line would pass the
8,191 characters of `cmd.exe`. A list runs several commands for one step; `false` turns a step off; a
step the config does not name is skipped. Measured on dpx: its `build` script builds three apps and
there is no `test` script, so the gate of 2026-11-03 ran three builds a pass and no test at all.

Gate steps of every run on the machine share `maxParallel` slots (default: a quarter of the cores;
`DOH_CHECKS_SLOTS` or `--slots=` override it, `0` lifts the limit): five agents building at once made
a grep over one translation file take two minutes. A step waits for a free slot (`slotWaitMs`).

Without a config: whatever the project's `package.json` actually has, in this order: `lint`, `typecheck` (or
`type-check`), `test:unit` (else `test`), `build`. `test:unit` comes first because a project that has
both usually keeps `test` for everything, an e2e suite included, and that suite cannot pass in a
worktree with no backend. Missing scripts are `skipped`, not failures; so is the whole gate when
there is no `package.json`, the dependency install failed, or there is no lockfile to install from.
A skipped gate is never a red one. Neither is a `partial` one: a `--only=<step>` re-run reports
`partial` however well that step went, because it never looked at the others — only a full pass can
answer for the whole gate, and only a green full pass lets the run commit.

**Every red command is the run's work** — whether the agent's own fixes broke it or it was already red
when the run started. That is the change the rename is about: the gate used to be a guard that only
had to stay as green as it was found, and it is now a job.

The agent reads the failing command's errors, repairs the cause, and runs the gate again, with a budget
of **three passes**. Still red after the third: no commit, no push, no resolve, and the worktree is
left in place for inspection.

Repairing means fixing what makes the command fail. An `eslint-disable`, a `.skip`ped test, a deleted
test file, a loosened assertion, a relaxed `tsconfig` or coverage threshold — none of those are
repairs, and the agent's brief forbids each of them by name.

The commands themselves are run by `scripts/checks.cjs`, not assembled by the agent: it reads the
package manager from the lockfile, sets `CI=1` and `FORCE_COLOR=0`, appends the non-interactive flag
the project's own test runner understands (`--run` for Vitest, `--ci --watchAll=false` for Jest,
`--watch=false` for Angular and Karma), gives each command a finite timeout, and treats a timeout as a
failure rather than a hang.

Whether a command passed is its exit code, never the agent's reading of what it printed. A passing
command's output is never read at all.

Each command's output goes to its own log file next to the report, capped at the last 256 KB — the end,
where a runner puts its failure summary. That log is for the user. A failed command also gets
`<step>.errors.log`, cut out of the whole output by the script: the failure lines alone, with the line
each sits under and the lines that belong to it (a stack, a code frame, an expected/received pair).
Passing tests, progress counters, console output, the package manager's epilogue and stack frames
inside `node_modules` stay out, and the excerpt stops at 200 lines. The agent is handed that path and
reads only that file; the full log it may only Grep, for one test name the excerpt left without its
cause. It is the same discipline the skill applies to comment bodies.

## Order of work

1. Read every unresolved thread to its last reply (replies carry the details the discussion settled),
   the conversation and the review summaries - or, under `--local`, the picked codeReview findings.
2. Fix them.
3. Check every comment again against the final code, and Grep the uses of everything the fixes
   changed, so nothing outside the comments breaks.
4. Review the run's own change with `/doh:codeReview staged --project=<worktree> --only-md --light`,
   made by a background sub-agent of its own - its rules and bundles never enter the fixing agent's
   conversation - and apply the findings whose fix leaves behaviour as it is; the rest are named in
   the report, each on one of three grounds.
5. Bring the gate green.
6. Commit and land it, as the target's `landing` says:
   - `rebase` - onto `origin/<base>` (a conflict, or a gate the rebase turned red, leaves the commit
     un-rebased), then push - `--force-with-lease` pinned to the remote state the run started from
     when the rebase rewrote the branch;
   - `keep-base` - the bottom of a stack: rebased only when it no longer merges into its base
     (`git merge-tree`), since a rebase there rewrites every part above it;
   - `hold` - a part whose base is another branch of the run: committed only. The orchestrator lands
     it once its parent has, with `scripts/restack.cjs`.

The fixing agent waits for long work in slices of under four minutes (`wait-part.cjs`) and never
loads a tool: its prompt cache lives five minutes, and the run of 2026-11-03 paid 1.3M cache-write
tokens - 27% of all - for `ToolSearch select:Monitor` and for waits that outlived it.

## Stacks

Pull requests of one run each based on another one's branch are a stack (`stacks[]`, bottom-first).
Its parts are fixed side by side but land bottom-up: landed side by side on 2026-11-03, part-1's
rebase onto master rewrote the commits part-2 sat on (part-2's rebase then conflicted), and part-4
pushed before part-3 had, so every part above part-1 had to be moved by hand.

`restack.cjs --action=land` moves a held part once its parent has landed: it fetches the parent,
replays only the part's own commits onto it (`git rebase --onto origin/<parent> <parent tip at the
start>`, with `rerere` on), runs the gate in the part's worktree when the move brought new code under
it, and pushes with a lease pinned to where the part stood when the run began. A conflict goes to a
conflict agent (`references/restack-agent.md`) with the files named: it keeps both sides' changes,
brings the gate green and pushes the same way. A part that did not land leaves its branch where it
was, and its children move onto that. After the run, `restack.cjs --action=verify` names every part
that does not sit on its parent, with the command that moves it.

Each closed thread gets a reply naming the commit first (`--no-reply` leaves it out), and a thread
whose fix landed in another file than its own - keys renamed in `en.json` for a thread on an effects
file - is closed when the commit changes that file (`fixedVia`).

Comments first, then the gate. There is no separate baseline run before the fixes: it would name
exactly which failures pre-dated the run, at the price of a second full `build` on every branch, and
under the current rules both kinds are repaired anyway. What survives of the distinction is the report,
which says when a repaired command's cause sat in files no comment fix had touched.

## Output

One Markdown report per branch, in Polish, in `<project>/.claude/doh/{branch}/` when the project keeps a
`.claude/` folder, otherwise in `reports/{branch}/` inside this skill. codeReview keeps its own reports
apart, under `.claude/doh/codeReview/`. It lists every
comment under `## Naprawione`, `## Odrzucone` and `## Bez akcji`, then `## Naprawione checki`,
`## Weryfikacja` and `## Wynik`.

Next to it sit the collected-comments JSON the agent read (`{branch}-fix-pr-{stamp}.json`) and the
gate's logs (`{branch}-fix-pr-checks/{step}.log`, plus `{step}.errors.log` for a failed step). The stamped files are capped at the 30 newest per
folder, like the codeReview reports they share the directory with; the log directory is unstamped and
each run overwrites it. Everything lives outside the worktree on purpose, so writing a report or a
build log can never end up in the commit.

Runs from before the rename wrote `{branch}-fix-pr-comments-{stamp}.json`. The cap still matches that
spelling, so those files age out instead of sitting in the folder for good.

The terminal summary is Polish and names, per branch: the commit message the agent actually used and
whether it was pushed, the fixed/rejected/answered counts, every rejection with its ground, which
checks were repaired and which are still red, and the report path.

## GitHub access

The token comes from the `codeReview` skill's `github.cjs` — `GH_TOKEN`, `GITHUB_TOKEN`, the git
credential store, `.netrc`, the `gh` config file, then the `gh` CLI, in that order. No `gh` binary is
required. The account needs write access to the repository; resolving another person's thread also needs
write access, and a token without it produces a warning and leaves those threads open.

## Lean mode

The orchestrator and every fix agent run in the plugin's lean mode (caveman ultra).
The orchestrator reads the rules from the block at the top of `SKILL.md`, and each fix agent receives them from the plugin's `SubagentStart` hook.
The brief in `references/fix-agent.md` carries none of it.
Pull request replies, commit messages and the agent's report file stay normal prose.
With the headroom proxy installed, the whole run also goes through context compression.
[`../../shared/README.md`](../../shared/README.md) describes both.

## Quality meter

A change to the brief is measured, not argued: `test-key/` holds a fixture pull request whose every review item has one right verdict, and `scripts/score-fix.cjs` scores what a run left behind.

The fixture is a small cart library with its own `lint`, `test` and `build` and no dependencies, so `npm ci` installs offline.
Pull request #7 (`feat(METER-1): Shipping costs`) carries 11 review items, listed in `test-key/key.json`:
- 4 to fix, one of them on an outdated thread and one made in the conversation;
- 3 to reject, one per ground;
- 4 that ask for nothing: a question, a thread its reviewer withdrew, CI noise and a review summary.

Its gate starts red twice: a `var` in a file no comment touches (lint), and the unit test the free-shipping comment is about.

1. Build a fresh fixture: `node skills/fixPr/test-key/make-fixture.cjs --out=<empty dir>`.
   It prints `fixture.json`: the checkout (`<dir>/shop`, standing on `main`), a bare `origin` the agent's push lands in, and `replay.json`, the review as the GitHub API would return it.
2. Run the skill on it with the review replayed: set `DOH_FIXPR_REPLAY=<dir>/replay.json` and run `/doh:fixPr feature/meter --project=<dir>/shop`.
   `pr-comments.cjs` reads the recording instead of GitHub (`--replay=<file>` does the same by hand), and `resolve-threads.cjs` only rehearses.
   Nothing reaches GitHub.
3. Score it: `node skills/fixPr/scripts/score-fix.cjs --fixture=<dir>/fixture.json [--json]`.
   It reads the verdicts from the report's sections, by the comment urls their lines cite.
   It copies the branch head out of git and runs every item's check there, plus the fixture's gate.
   It checks for one commit with the right message, pushed, and no file changed beyond the fixes.
   A `fixed` verdict whose file the commit never changed is reported as a false fix.

`test-key/solution/` is the reference fix; the scorer's own tests land it and expect 11 of 11 with no problem.

## Files

| Path | Role |
|---|---|
| `SKILL.md` | the orchestrator: arguments, collection, worktrees, dispatch, landing, summary |
| `references/fix-agent.md` | the background agent's prompt: verdicts, fixes, gate, commit, push |
| `scripts/pr-api.cjs` | GraphQL review threads and the resolve mutation, plus the two REST lists |
| `scripts/pr-comments.cjs` | argument parsing, the commit prefix and `CR` message, and the per-branch comment JSON |
| `scripts/checks.cjs` | the gate: command discovery, non-interactive flags, timeouts, one log per step and an errors-only excerpt per failed one; implementNewFeature's agents run their unit tests and builds through it too |
| `scripts/worktree.cjs` | branch-state refusals, worktree creation, bootstrap, removal |
| `scripts/resolve-threads.cjs` | closes exactly the threads a run fixed, each after a reply naming the commit |
| `scripts/restack.cjs` | lands a held part of a stack onto its landed parent (`land`) and checks a stack after the run (`verify`) |
| `references/restack-agent.md` | the brief of the agent that resolves a conflict `restack.cjs` stopped at |
| `scripts/score-fix.cjs` | the quality meter's scorer: verdicts, checks on the result, landing, scope, gate |
| `test-key/` | the meter's fixture (`fixture/`, built by `make-fixture.cjs`), its key (`key.json`) and the reference fix (`solution/`) |
| `../../scripts/render-agent-prompt.cjs` | renders `fix-agent.md` to `promptPath` with every `{{PLACEHOLDER}}` filled, so the orchestrator hands the agent a path instead of carrying the brief twice |

`pr-api.cjs` and `pr-comments.cjs` require `../../codeReview/scripts/github.cjs` and
`../../codeReview/scripts/review-context.cjs` — the token discovery, the pull request lookup, the HTTP
primitive and the artifact-path conventions already live there, and the two skills ship in one plugin.

Tests: `node --test skills/fixPr/scripts/*.test.cjs scripts/render-agent-prompt.test.cjs`
No test reaches the network and none installs anything: the GitHub layer is driven through an injected
sender, the git tests run against real temporary repositories with their remote refs written by
`git update-ref`, and `checks.cjs` takes its subprocess runner as a seam, so the command construction
is proved without spawning a package manager. `score-fix.test.cjs` builds the fixture and lands
commits in it, pushing to its local bare `origin`.
