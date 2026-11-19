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
| `/doh:fixPr part-1 --task="add … to the Load into label"` | one more change the user wants in that branch, beside its comments; the open pull requests based on it are moved onto the result afterwards (`restack.cjs --action=cascade`) |
| `/doh:fixPr feature/a --project=<path>` | against the repository at `<path>` instead of the current directory |
| `/doh:fixPr --resume` | go on with the project's newest run whose orchestrator stopped (a crash, a closed session): each target's next step from the run file, the result files and git |
| `/doh:fixPr --resume=<runPath>` | the same for that run file (`.claude/doh/fixpr-run-*.json`) |

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
A bot report posted again on every push (a vulnerability scan) travels once: its newest copy, cut to
its first 1 500 characters (`botDuplicatesDropped` counts the rest).

**Screenshots and recordings.** Every image and video a comment, a thread reply or a review summary
attaches (`<img>`, `![]()`, a bare `github.com/user-attachments/assets/…` link) is downloaded by
`pr-media.cjs` into `{branch}-fix-pr-media/` and rides on its comment as `media[]`. A private
repository answers the plain URL with a login page; the comment's rendered HTML (`body_html`) holds a
short-lived signed copy, which is fetched instead. The token only ever goes to `github.com`. A
recording becomes up to 8 still frames (`frames[]`): with `ffmpeg` on `PATH` (or `DOH_FFMPEG`), else
the plugin's Playwright drives the installed Chrome - GitHub recordings are H.264, which Playwright's
own Chromium and its bundled ffmpeg cannot decode. The agent looks at every image and frame before it
gives that comment a verdict (`sawMedia`). Measured on the DPXN-11967 part-4 review: one screenshot
and one recording, 8 frames, 6.6 s.

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

Before the worktree is created, the branch is fetched and its relation to `origin` decided. These
states are **refused**, each with the fix in the message, and none of them is forced through:

| State | Why it is refused |
|---|---|
| checked out somewhere AND holding commits origin lacks | a fix made beside them would leave them behind |
| no `origin/<branch>` | the fix could never reach the pull request |
| diverged from `origin/<branch>` | no push could succeed, and rebasing on the user's behalf is not this skill's call |
| a folder in the way that holds something of its own | a registered worktree, a `.git`, a link, or a file the branch does not have - named in the message |

A branch the user has checked out (and pushed) is no longer refused: it is worked on a branch of the
run's own, `doh-fixpr/<branch>`, made from `origin/<branch>`, and every push sends `HEAD` to
`refs/heads/<branch>` (`heldBy`, `localBranch`). On 2026-11-06 part-4 of a stack fell out of a run
because the user's terminal stood on it. `remove` deletes `doh-fixpr/<branch>` once origin holds it.

A folder left by an earlier run - empty, or holding only files ignored by the project or identical to
the branch's own (a removal that stopped half way) - is removed by `add` itself. Three such folders of
2026-11-06, left by a "Permission denied" on remove, blocked their branches until the user deleted
them. `remove` now retries the last `rmdir` for about 15 seconds before it leaves a held folder.

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

The link is the default whenever the lockfile matches and the main checkout's `node_modules` holds
what its `package.json` declares. Whatever is in the worktree's way - a stale or dangling link, the
half tree of a stopped install, an earlier run's folder - is cleared first, links unlinked and never
followed, and the link made in its place (`replaced` in `dependencies`, and a warning). A link to the
main checkout that is already there is kept. When `auto` still installs, the reason it could not
link travels with the answer (`dependencies.linkRefused`, and a warning): on 2026-11-18 one part of
seven installed for ten minutes and nobody could tell why.

An install never runs through a link: a `node_modules` link in the worktree is unlinked first, since
`npm ci` empties the folder it finds entry by entry - through a junction, the main checkout's
(measured with npm 10 on Windows). It is bounded: after 10 minutes the install is stopped with
every process it started (`taskkill /T` on Windows, a process group elsewhere - a timeout that killed
only the shell left npm writing on, and the retry met it with `ENOTEMPTY`), and its half tree is
cleared. Its failure is reported by the first error lines of the package manager's output, never by
the deprecation warnings before them, and a stopped install says so.

What an install rewrites in tracked files never leaves a worktree dirty. husky's `prepare` rewrites
`.husky/_/husky.sh` and `.husky/.gitignore`, and a repository that tracks them with CRLF checkouts
finds them "modified" after every install - on 2026-11-18 that made `remove` refuse every worktree of
a stack and a cascade stop at "already exists and is kept". `add` puts back every tracked file the
dependency step changed (only an unstaged modification, only one that was not changed before the
step) and records what the step made of it (path and content hash, in the worktree's private git
dir). `HUSKY=0` was not the way: it covers husky alone and skips the hook helpers a commit there
runs; `skip-worktree` would hide a real edit of the file from status and from the commit. `remove`
recognises such leftovers - a file whose content is what the recorded install made of it, or a
husky helper whose change is line endings only or equals the main checkout's copy - and discards
them, but only when they are ALL the worktree holds; anything else still makes it refuse, and the
tree is left exactly as it was.

The `add` steps that write the repository (fetch, `worktree add`, the fast-forward) run under a lock
in the shared git dir (`doh-worktree.lock`), so launches started side by side do not fail on git's
own config and ref locks; the dependency step runs outside it. A lock older than five minutes is a
crashed run's, and a wait longer than two minutes goes on without it.

After a successful commit the worktree is removed. `git worktree remove` is called **without**
`--force`, ever: git refuses a worktree holding modified or untracked files, and that refusal is the
last guard against deleting work the verification gate stopped from being committed. Before it, the
self-review's reports (`.claude/doh/codeReview/runs/`, gitignored, so git would delete them) move to
`<project>/.claude/doh/<branch>/codeReview/runs/`, and every link in the tree is unlinked: git's
recursive delete walks into a junction and empties what it points at. Take a worktree down with
`worktree.cjs --action=remove`, never with `git worktree remove --force`.

Every remove watches the main checkout's `node_modules`. When it existed before and is gone after
(or holds fewer entries), the answer carries `mainModulesLost: true` and an error - "The main
checkout's node_modules disappeared while removing <worktree>; run `npm ci` there" - which
`fixpr-after.cjs` puts in its `errors[]` and `restack.cjs` turns into a stop of the climb (resumable
with `--resume=yes` once the user has installed). On 2026-11-19 that folder was gone at the end of a
run, and no step had said when. What a shell can do to it is guarded too (`bash-guard.cjs`): an
install in a fix worktree (`npm ci`/`install`, `pnpm install`, `yarn`, …) and an `rm` of
`node_modules/` are refused, because both go through the link into the main checkout's packages.
Every recursive delete of a worktree folder (`add`'s leftover, implementNewFeature's
`verify-parts.cjs`) unlinks the links in it first (`removeTree`); `fs.rmSync`, `rmdir /s` and git
2.56 were measured not to follow a junction, `rm -rf <link>/` and npm were measured to.

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

### Single specs: `related`

A test entry may carry `related`, the command that runs a few given specs. A fix and a landing agent
run the specs of their change with it (`--tests=near` passes, and `checks.cjs --specs=<spec>,…`)
instead of a whole project's suite:

```json
{
  "steps": {
    "test": [
      {
        "command": "npx ng test web",
        "files": "^projects/(web|shared)/",
        "related": "node node_modules/@angular/cli/bin/ng.js test web --test-path-pattern={pattern}"
      },
      {
        "command": "npx jest --config packages/api/jest.config.js",
        "files": "^packages/api/",
        "related": "npx jest --config packages/api/jest.config.js {specs}"
      }
    ]
  }
}
```

`{pattern}` becomes the specs as one quoted regular expression, each path escaped (`+`, `(`, `.`
and the rest) and several joined as `(a|b)` - what `--testPathPattern` and `--test-path-pattern` take.
`{specs}` becomes the quoted paths themselves. A long list runs as several commands. An entry
without `related` is not run for single specs; the step says so.

    node scripts/checks.cjs --root=<worktree> --out-dir=<dir> --specs=projects/web/src/app/+state/tests/items.effects.spec.ts

answers `partial`, like every pass over part of the tests.

### Without a config

Whatever the project's `package.json` actually has, in this order: `lint`, `typecheck` (or
`type-check`), `test:unit` (else `test`), `build`. `test:unit` comes first because a project that has
both usually keeps `test` for everything, an e2e suite included, and that suite cannot pass in a
worktree with no backend. Missing scripts are `skipped`, not failures; so is the whole gate when
there is no `package.json`, the dependency install failed, or there is no lockfile to install from.

With neither `test:unit` nor `test` (npm's "no test specified" placeholder counts as none), the
test step looks further before it gives up - a gate that ran only `build` once reported seven pull
requests green that CI then failed on their specs:

- every unit-test target of `angular.json` (`@angular-builders/jest:run`, karma, jest, unit-test,
  web-test-runner; never an e2e builder), run through the script that runs it when there is one
  (`test:<project>`, or any script whose text is `ng test <project>`), else through the local
  Angular CLI (`node node_modules/@angular/cli/bin/ng.js`, which resolves where `npx` does not in a
  worktree with a linked `node_modules`);
- every other `test:<name>` script whose name is a folder (`<name>`, `packages/<name>`,
  `apps/<name>`, `libs/<name>`, `projects/<name>`).

Each runs for the files under its project's folder: with `--changed-since` only the projects the
change touches run. A library project's change runs every project's tests (the apps import it), and
so does a change to a workspace-wide file (`package.json`, `angular.json`, a root `tsconfig*.json`,
jest or karma config). The single specs of such a project run as `ng test <project>
--test-path-pattern=<escaped path>` (jest builder) or `--include=<path in the project>` (karma and
the others), or after `--` of a `jest` / `vitest` script. Other `test:*` scripts (`test:ci`,
`test:coverage`) are never guessed at: the skip reason names them. `testSource` in the result says
the commands were detected.

### Verdicts

A skipped gate is never a red one. Neither is a `partial` one: a `--only=<step>` re-run reports
`partial` however well that step went, because it never looked at the others — only a full pass can
answer for the whole gate, and only a green full pass lets the run commit.

`green-no-tests` is a full pass in which every command passed and no unit test ran, because the
project has no test command the gate knows (no script, nothing detected, or a checks.json without a
`test` step; one with `"test": false` turned them off on purpose and stays `green`). `noTests` says
why, and a warning names `.claude/doh/checks.json`. The run may commit on it, like on `green`, but
it is never reported as green: the fix agent's report and result (`gate`), the landing's `gate`
and the summary all say the tests did not run. A change that touched no project with tests is
plain `green`: the tests exist, and nothing of theirs changed.

### CI

The collector greps the project's CI files (`Jenkinsfile`, `.github/workflows/*.yml`,
`.gitlab-ci.yml`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`) for a test command
(`npm run test…`, `ng test`, `jest`, `vitest`, …) and warns once per run when the gate has no
counterpart for it (`ciTestGap` in the collector's JSON), with the checks.json that would close the
gap.

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

The fixing agent waits for long work in slices of under three minutes (`wait-part.cjs`) and never
loads a tool: its prompt cache lives five minutes, and the run of 2026-11-03 paid 1.3M cache-write
tokens - 27% of all - for `ToolSearch select:Monitor` and for waits that outlived it.

## Stacks

Pull requests of one run each based on another one's branch are a stack (`stacks[]`, bottom-first).
Its parts are fixed side by side but land bottom-up: landed side by side on 2026-11-03, part-1's
rebase onto master rewrote the commits part-2 sat on (part-2's rebase then conflicted), and part-4
pushed before part-3 had, so every part above part-1 had to be moved by hand.

The stack is read from GitHub, not only from the named branches: a part whose base is another open
pull request's branch is held on it (`stack.parentOutsideRun`), a part with open pull requests above
it keeps its base and carries them as `stack.above`, and `stack.allAbove` lists every part above a
target. On 2026-11-06 a failed fetch of part-2 made part-1 a plain `rebase`, and part-4 named alone
came out with no parent at all. Reads of GitHub that fail for a moment are retried (`pr-api.cjs`).

A fix that removes or renames something the parts above still use is caught before the commit
(`symbol-uses.cjs --refs=origin/<part>`), and reported as `stackImpact`: the orchestrator passes it to
the agents of those parts while they still work, and to their conflict agent as `PARENT_CHANGES`.
A held part's agent runs lint, typecheck and tests only; its build runs once, at the landing
(`restack.cjs --pending-steps=build`), and a move that leaves the tree as it was runs no gate.

`--restack` moves the whole stack onto its newest base before any fix (`/doh:restack`), so the fixes
land once on current code. `/doh:restack` alone (skills/restack) is the same climb without fixes.

`restack.cjs --action=land` moves a held part once its parent has landed: it fetches the parent,
replays only the part's own commits onto it (`git rebase --onto origin/<parent> <parent tip at the
start>`, with `rerere` on), runs the gate in the part's worktree when the move brought new code under
it, and pushes with a lease pinned to where the part stood when the run began. A conflict goes to a
conflict agent (`references/restack-agent.md`) with the files named: it keeps both sides' changes,
brings the gate green and pushes the same way. A part that did not land leaves its branch where it
was, and its children move onto that. After the run, `restack.cjs --action=verify` names every part
that does not sit on its parent, with the command that moves it.

A landing that moves nothing - the part already sits on its parent and origin already has it - is
`status: noop`, with a `reason`, and its worktree goes like a landed part's. It used to be `landed`
with `gate: skipped`, which read as a move that happened: on 2026-11-18 a cascade given a wrong old
tip answered exactly that, with the part where it was. That old tip is checked now: a
`--parent-tip-at-start` (land), `--from-old-tip` (cascade) or `--parent-old-tip` (stack `--start`)
that is not an ancestor of the part being moved is refused with an error before anything moves. Inside
a climb, a part that did not sit on its parent's old tip (a stack out of line) moves off the last
commit it shares with it, with a warning.

A move writes commits, so git needs `user.name` and `user.email`. Without them land answers
`status: error`, its first error naming what is missing and the two `git config --global` commands,
and a climb checks it once before its first worktree. On 2026-11-18 the rebase stopped at its first
pick with "Committer identity unknown", land reported a `conflict` with no conflicting file, and a
landing agent spent 4 minutes and about 55k tokens finding why. A rebase that stops with no
conflicting file for any other reason is an `error` with git's own line too.

Two parts that only appended at the same spot - a translation key each, an enum member each, an
export each - no longer stop the move. `land` merges such a conflict itself: a JSON file key by key
(both sides' new keys kept in place, a key both changed differently refused, and only a file that
`JSON.stringify` reproduces byte for byte), any other file only where every conflicting hunk is two
insertions with an empty base. It does so only when the gate runs after the move, which proves the
merge; `autoResolved[]` names each file and how. On 2026-11-05 four restacks of DPXN-11967 stopped on
exactly these (`en.json`, `ButtonTooltip`), each spending a conflict agent.

A conflict held in the import block of a JS/TS file is merged the same way (`how: imports`): per
module specifier, the base's names, minus the ones a side removed, plus the ones a side added -
`type` modifiers and aliases kept, `import type` apart from the values of one module, a default
import kept beside the named ones, a side-effect or namespace import kept or dropped whole, an import
left with no name dropped. The parent's order and formatting stay (single- or multi-line, indent,
trailing comma, quotes, semicolons, line endings); a name only the part added comes after the one it
follows in the part. Only where every conflicting hunk holds import lines alone (or is an insertion
with an empty base): a hunk with any other line, a binding both sides changed differently, a comment
the part changed in the block or a statement it cannot read stays a conflict for the agent. On
2026-11-18 five parts of one stack each stopped on the same import block of one store file - the
parent had dropped names the child kept, the child had added others - and five landing agents
(55-75k tokens and 4-7 minutes each) resolved it the same way.

The landing agent's brief carries the parent's diff cut to what the landing is about (`PARENT_DIFF`):
the conflicting files, or in `adapt` mode the files and the quoted names of the red step's errors,
plus every file whose changed lines hold a name of the parts below that this part still uses.
`PARENT_CHANGES` lists only the entries whose name this part's files still hold. The whole diff stays
in `parent-diff-full.patch` next to it (`PARENT_DIFF_FULL`), for the agent to grep. On 2026-11-18 the
whole landed parent went to each agent, 10-14 KB of brief and diff for a conflict in one import block.

`restack.cjs --action=cascade` moves every part above a changed one, bottom-up, with no agent - after
a `--task` on part-1, the parts 2..n the run did not name. Each part gets a worktree for the move and
loses it after; the first part that does not land stops the climb (`waiting[]`) and keeps its
worktree for the conflict agent. `--action=push` is the agents' push: it retries what fails for a
moment (`fatal error in commit_refs_rules`, a 5xx, a dropped connection) and never a rejection.

Each closed thread gets a reply naming the commit first (`--no-reply` leaves it out), and a thread
whose fix landed in another file than its own - keys renamed in `en.json` for a thread on an effects
file - is closed when the commit changes that file (`fixedVia`).

## Resume

A run whose orchestrator stops half way - on 2026-11-18 one was killed (exit 137) in the middle of
seven landings - goes on with `/doh:fixPr --resume[=<runPath>]`. Every state it needs is on disk:
the run file keeps, per target, what its launch was given and made (`launch`: push, language,
worktree), what its landing and push did (`landingResult`, `pushResult`, with the lease), and what
`fixpr-after.cjs` did (`outcome`); the agent's result file holds its commit and verdicts.
`scripts/fixpr-resume.cjs` reads them with git and names, per target, the one next step and its
command:

| Action | When | Command |
|---|---|---|
| `spawn` | no result file, or an agent that ended in error with work in its worktree | `fixpr-launch.cjs --resume=yes` (the stopped run's worktree taken as it is), then the agent |
| `land` | a held part whose parent has landed; a `keep-base` bottom whose commit was never pushed | `restack.cjs --action=land` (`--keep-base=yes`: onto its base only when it no longer merges), the worktree made again first when it is gone |
| `push` | a commit landed and never pushed | `restack.cjs --action=push --commit=<sha>`, from the project when the worktree is gone, with the lease once the commit rewrote the branch |
| `landing-agent` | a landing agent stopped in the middle of its rebase | its brief rendered again |
| `after` | landed, `fixpr-after.cjs` never ran | `fixpr-after.cjs` with the landing's commit |
| `resolve` | pushed, threads left open (a 401) or a push made after `fixpr-after.cjs` | `fixpr-after.cjs --resolve-only=yes` |
| `cascade` | pushed under open parts the run does not name, still on the old commit | `restack.cjs --action=cascade` |
| `wait` / `manual` / `done` | a parent not landed yet / nothing a script can do / nothing left | - |

A held part still lands only after its parent. The orchestrator runs each command once and asks
again until every target is done, waits on a running agent, or needs the user.

`fixpr-after.cjs --resolve-only=yes` is the thread step alone, for a target that landed and pushed
while its resolves failed: it works with the worktree gone (the commit is read from the main
checkout's object store, after a fetch), checks that origin holds the commit, skips every thread
GitHub already shows resolved (`resolve-threads.cjs --skip-resolved`), posts no second reply naming
the same commit, and keeps the new state in the target's `outcome`, which the summary prints.

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

**Every comment checked at the end.** The agent writes its final JSON to `{report}.result.json`,
with a verdict per item of the comments file (`verdicts[]`). `verify-fix.cjs` holds the two against
each other and, once something was pushed, against the pull request as GitHub has it then: an item
with no verdict, a rejection without its ground, pictures the agent did not look at, `fixed` threads
missing from `fixedThreadIds` (or the other way round), a fixed thread GitHub still shows open, and a
thread opened while the agent worked. Each gap is a line of the summary, so a review summary with two
numbered requests cannot come back half done without anybody saying so - the part-4 review of
2026-11-05 asked for a padding and a row highlight, and only the user noticed the second.
The agent also lists `uiUnverified`: the stylesheets and templates its commit changes, whose look no
gate checks, for the user to open.

## GitHub access

The token comes from the `codeReview` skill's `github.cjs` — `GH_TOKEN`, `GITHUB_TOKEN`, the git
credential store, `.netrc`, the `gh` config file, then the `gh` CLI, in that order. No `gh` binary is
required. The account needs write access to the repository; resolving another person's thread also needs
write access, and a token without it produces a warning and leaves those threads open.

A token GitHub refuses (401) is not the end of the list: the request is asked once more with the next
source that holds a different token, and the one that works is kept for the rest of the process. A
stale `GH_TOKEN` in the environment no longer hides a valid stored credential - on 2026-11-18 it failed
26 resolves and replies of one run. The answer names the sources, never a token: `GH_TOKEN was
rejected; used git credential`, or, when nothing works, `GH_TOKEN was rejected; git credential was
rejected too`.

## Preflight

Before a comment is read, the collector checks what the run will need from this machine
(`scripts/preflight.cjs`, also runnable alone):

- `origin` answers `git ls-remote` without a prompt (`GIT_TERMINAL_PROMPT=0`, Git Credential Manager
  non-interactive, 20 s timeout). A failure carries git's first line and its fix - for Git Credential
  Manager's "Unable to persist credentials with the 'wincredman' credential store",
  `git config --global credential.credentialStore dpapi` or one login from a normal terminal.
- `user.name` and `user.email` are set: without them a rebase stops as if it conflicted.
- The GitHub token works: one call to the repository, naming the source used and any refused one.
- The main checkout's `node_modules` exists and holds every declared package (worktree.cjs's
  `dependencyHealth`, the same check as `mainBroken`).

Which failures stop the run depends on what it will do: an unreachable origin with `--push=yes`, a
missing identity whenever something is committed, a refused token when threads are resolved, broken
dependencies when a gate runs. `--dry-run=yes` turns every one into a warning. A stop comes before any
worktree exists, with the fix in its text (`preflight.ok: false` in the collector's JSON). On
2026-11-18 each of the four surfaced in the middle of a run instead: seven "Could not fetch" warnings
and a push refused 25 minutes in, a "conflict" with no conflicting file, 26 failed resolves, a ten-minute
install in one worktree. `restack.cjs --action=plan` and `--action=stack` run the same check
(`--preflight=no` skips it); implementNewFeature's commit and pull request step can call `preflight()`.
A fetch that still fails later says why (git's first line) instead of only that it failed.

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

## Visual check

A fix of what the user sees is looked at in the running app (`fix-agent.md` step 5b) when the project's
`.claude/doh/checks.json` describes how to start it:

    "visual": { "command": "npx ng serve dpx -c local --port {port}", "url": "http://localhost:{port}/#",
                "backend": ["http://localhost:3000/"], "authFile": ".claude/doh/auth.json" }

The agent preflights the backend (`e2e-preflight.cjs --fix`, which also copies the local proxy config
the worktree lacks), starts the app through `task-processes.cjs`, writes one Playwright spec per
checked comment - assertions of what the fix promises and a screenshot - and runs it through
`checks.cjs --only=e2e` with implementNewFeature's Playwright. A failed assertion is a red step; an
app that cannot start or a backend that does not answer skips the check, and the templates stay in
`uiUnverified`. `authFile` (`{"login","password"}`, gitignored) is read by the gate script only.
The orchestrator stops the app before it removes the worktree.

## Lessons and freshness

Each agent proposes `lessons` - the general rule behind a fixed comment - and the orchestrator offers
them to the user after the run (`codeReview/scripts/pr-lessons.cjs`), into the project's
`.claude/doh/local/pr-lessons-*.md` rules that every codeReview loads. Before the run, the collector
warns about every branch with commits newer than its last codeReview
(`codeReview/scripts/review-freshness.cjs`): reviewers saw that code, no review did. A warning every
branch gets alike ("no codeReview of this branch on record") is one line naming the branches, with
`<branch>` where each one's name stood.

## Permissions

`restack.cjs` force-pushes (with a lease) and `worktree.cjs` creates and removes folders, so the
auto-mode classifier may stop a call it cannot attribute - it refused a hand-made restack script on
2026-11-06. Allow the plugin's own scripts once, in `~/.claude/settings.json` (`permissions.allow`;
`*` matches any version folder; the user's path, in both slash styles):

    "Bash(node \"C:/Users/<you>/.claude/plugins/cache/implement-new-feature/doh/*)",
    "Bash(node \"C:\\Users\\<you>\\.claude\\plugins\\cache\\implement-new-feature\\doh\\*)"

An allow rule applies in auto mode unless `autoMode.classifyAllShell` is on. Claude cannot add the
rule itself: editing its own settings is refused as self-modification.

## Files

| Path | Role |
|---|---|
| `SKILL.md` | the orchestrator: arguments, collection, worktrees, dispatch, landing, summary |
| `references/fix-agent.md` | the background agent's prompt: verdicts, fixes, gate, commit, push |
| `scripts/pr-api.cjs` | GraphQL review threads and the resolve mutation, plus the two REST lists |
| `scripts/pr-comments.cjs` | argument parsing, the preflight (`--push`, `--dry-run`, `--preflight`), the commit prefix and `CR` message, the per-branch comment JSON, and identical per-branch warnings folded into one line |
| `scripts/preflight.cjs` | before any worktree: origin reachable without a prompt, a git identity, a GitHub token GitHub accepts (and its source), a complete main `node_modules`; each failure with its fix |
| `scripts/checks.cjs` | the gate: command discovery, non-interactive flags, timeouts, one log per step and an errors-only excerpt per failed one; implementNewFeature's agents run their unit tests and builds through it too |
| `scripts/worktree.cjs` | branch-state refusals, worktree creation under a repository lock, bootstrap (a main `node_modules` missing declared packages stops the run before any agent: `mainBroken`; a stale `node_modules` cleared and linked over; a bounded install that never runs through a link; install artefacts in tracked files put back), removal (install artefacts discarded when they are all there is, links first, git's own reason on a refusal, a main `node_modules` that disappeared or shrank reported as `mainModulesLost`); `--resume=yes` takes a stopped run's worktree as it is, or makes it again from the local branch holding its unpushed commit |
| `scripts/resolve-threads.cjs` | closes exactly the threads a run fixed, each after a reply naming the commit; a 5xx is retried and a reply that already landed is never posted twice; `--skip-resolved` leaves the threads GitHub shows closed alone |
| `scripts/restack.cjs` | lands a held part of a stack onto its landed parent (`land`, append and import-block conflicts merged, `noop` when nothing moves, a missing git identity or a wrong old tip an error, `--run` reads the part from the run file, `--pending-steps`, `--summary`), checks a stack (`verify`, `--run`), moves the parts above a changed one (`cascade`), moves a whole stack onto its base (`stack`, `plan` - /doh:restack) and pushes `HEAD` (or `--commit`) with retry (`push`); `land --keep-base=yes` moves a bottom only when it no longer merges; with `--run`, land and push keep their answer in the run file |
| `scripts/symbol-uses.cjs` | where names are still used - in the worktree (a rename's leftovers) and in the parts stacked above (`--refs`) |
| `scripts/agent-stop.cjs` | SubagentStop hook: a fix or restack agent ends with its JSON object alone, and never while its own background work runs |
| `scripts/pr-media.cjs` | downloads the screenshots and recordings of the comments, a recording as still frames |
| `scripts/verify-fix.cjs` | the end-of-run check that every comment got a verdict, and that GitHub agrees |
| `references/restack-agent.md` | the brief of the agent that resolves a conflict `restack.cjs` stopped at |
| `scripts/score-fix.cjs` | the quality meter's scorer: verdicts, checks on the result, landing, scope, gate |
| `test-key/` | the meter's fixture (`fixture/`, built by `make-fixture.cjs`), its key (`key.json`) and the reference fix (`solution/`) |
| `../../scripts/render-agent-prompt.cjs` | renders `fix-agent.md` to `promptPath` with every `{{PLACEHOLDER}}` filled and only the `{{#if …}}` blocks of this agent kept (its landing, push, inputs), so the orchestrator hands the agent a path instead of carrying the brief twice; an absolute path with `..` in it is written the way it resolves |
| `scripts/stack-preflight.cjs` | before the agents: every part of a stack that imports a file only a later part adds (`leaks`), and what each part restores verbatim first (`restore`), from git alone |
| `scripts/fixpr-launch.cjs` | one target ready for its agent: the worktree, the brief and its two step files (`fix-visual-agent.md`, `fix-land-agent.md`), every value read from the run file; what it was given and made kept there (`launch`); run in the background, one per target (`linked` says whether `node_modules` is the main checkout's) |
| `scripts/fixpr-after.cjs` | after a target lands: threads closed, every comment checked, the app stopped, the worktree down, the outcome kept in the run file, the next held part moved onto it (`--land-next=yes`); identical resolve and reply failures as one `{ error, count, ids }` each; `--resolve-only=yes` runs the thread step alone again |
| `scripts/fixpr-resume.cjs` | a stopped run's next step per target (`--resume`), from the run file, the result files and git |
| `scripts/fixpr-summary.cjs` | the closing summary in Polish, from the run file, the result files and the stack check; `stackImpact` one line per name, parts as ranges (`part-3..7`), paths cut to their distinct tail, capped with "+N" naming the result file |
| `scripts/split-work.cjs` | a fix agent's many items cut into groups of whole folders for `doh:pipeline-worker` agents (`references/fix-worker-agent.md`) |
| `scripts/bash-guard.cjs` | PreToolUse hook: a shell read of a fix worktree, or a `cd` into one that outlives its command, is refused with the tool to use; so are a package-manager install there and an `rm` of `node_modules/`, which reach the main checkout's packages through the link |

What changed in 0.35.0, measured on the five-part DPXN-12003 run of 2026-11-16 (94 min, 141M cache read):
the gate stops after a red typecheck and runs only the specs near the change until its last pass
(`--tests=near`), gives the bottom of a stack the first free slot (`--priority`) and lint none; the
waits end before the harness's 180 s; the stack's split is found before the agents start; the
landing agent gets every change of the parts below (`PARENT_CHANGES`) and the parent's diff, and
adapts a part whose gate is red after a clean move (`mode: adapt`); the self-review runs on Opus at
low effort with Sonnet walkers and the run's decisions, and the orchestrator works through scripts.

`pr-api.cjs` and `pr-comments.cjs` require `../../codeReview/scripts/github.cjs` and
`../../codeReview/scripts/review-context.cjs` — the token discovery, the pull request lookup, the HTTP
primitive and the artifact-path conventions already live there, and the two skills ship in one plugin.

Tests: `node --test skills/fixPr/scripts/*.test.cjs scripts/render-agent-prompt.test.cjs`
No test reaches the network and none installs anything: the GitHub layer is driven through an injected
sender, the git tests run against real temporary repositories with their remote refs written by
`git update-ref`, and `checks.cjs` takes its subprocess runner as a seam, so the command construction
is proved without spawning a package manager. `score-fix.test.cjs` builds the fixture and lands
commits in it, pushing to its local bare `origin`.
