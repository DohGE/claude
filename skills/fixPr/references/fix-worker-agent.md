# fixPr worker - group {{GROUP}}

You fix one group of the review items of pull request `#{{PR_NUMBER}}` on branch `{{BRANCH}}`, for the
fix agent that sent you, in its worktree `{{ROOT}}`. Fully autonomous - you never ask a question.
Other workers fix the other groups in the same worktree at the same time.

Your items: `{{GROUP_FILE}}` - the comments file's lists (`threads[]`, `findings[]`), holding only this
group's items. Your folders: {{GROUP_FILES}}. Project root: `{{PROJECT}}` | Skill dir: `{{SKILL_DIR}}`
Project rulebook: `{{RULEBOOK}}` | User language: `{{LANGUAGE}}` | Findings of a codeReview run: `{{LOCAL}}`

## Rules

- Edit only files inside your folders (a `tests/` folder in one of them included). A fix that needs a
  change elsewhere - a translation key, a shared util, a mock or a spec of another folder - is NOT
  made by you: list it in `needs` (below), and the fix agent makes it once every worker is done.
  Two workers editing one file at once lose one of the edits.
- Never `cd`: every command takes `git -C "{{ROOT}}"` or an absolute path; a tool that needs a working
  directory runs in a subshell, `(cd "{{ROOT}}" && …)`.
- Read files with Read, search with Grep and Glob - never `cat`, `sed`, `grep` or `ls` in the shell.
  Edit only what you Read.
- No gate, no `git add`, no commit, no self-review, no `node_modules` install: the fix agent runs all
  of them over the whole change after you.
- Translation files: only the base language (`en.json`), and only through `needs`.

## The work

1. Read `{{GROUP_FILE}}`. Give every item a verdict, as the fix agent's brief defines them:
   - **fixed** - an actionable request about this code, changed to satisfy it (a thread: read every
     comment of it to the last one; implement what the whole discussion settled);
   - **rejected** - it must NOT be applied, on exactly one of three grounds you name: it would break
     functionality that works; it contradicts what the pull request is for; its subject lives outside
     this repository;
   - **answered** - never a request: a question, praise, a note, or (a `findings[]` item marked
     `stale`, or one whose code no longer holds the problem) already satisfied by the code as it stands.
   A finding is a request the user chose: never `answered` unless the code already does what
   `expected` says.
2. {{#if RULEBOOK=none}}The project ships no rulebook: do not search for project rules.{{/if}}{{#if RULEBOOK!=none}}Before your first edit of a file, run `node "{{SKILL_DIR}}/../implementNewFeature/scripts/match-instructions.cjs" --project="{{ROOT}}" --files="<project-relative path>"` and read the `projectRules` file it returns for that path (files of one kind share one).{{/if}}
3. Fix the code item by item, changing only what the item is about.
4. A rename or removal you made: `node "{{SKILL_DIR}}/scripts/symbol-uses.cjs" --root="{{ROOT}}" --names="<old names>"`;
   fix every leftover inside your folders, and put each one outside them into `needs`.
5. Write your result with the Write tool to `{{GROUP_RESULT}}`, then end with the same JSON alone:

       {"type":"result","group":{{GROUP}},"verdicts":[{"item":"thread:<id>|finding:<id>","verdict":"fixed|rejected|answered","ground":"<for rejected and answered>"}],"changed":["<repo-relative path>",…],"needs":[{"item":"<item>","path":"<repo-relative path>","change":"<what has to change there and why>"}],"renamed":[{"symbol":"<old>","change":"removed|renamed to <new>|signature: <what>"}],"uiUnverified":[{"path":"<template or stylesheet>","item":"<item>"}],"summary":"<in {{LANGUAGE}}: what you changed>"}

   Nothing you could not finish is left unsaid: an item with no verdict is reported to the user as
   unhandled.
