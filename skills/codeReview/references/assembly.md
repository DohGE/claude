# codeReview — assembly and terminal summary

Read with the Write of a target's cross-file part: `references/cross-file.md` names it, and after a compaction the hook does.

## Coverage gate

Before leaving Step 3 for a target: re-read `target.files` and confirm every entry had its `bundlePath`/`contentPath`/`diffPath` read, its part file written, and either all five points covered (point 3 collected, the other four verdicted) or — for a whole-diff mechanical file — the gate's two questions answered.
Analyze any missed file now.
A target with an unanalyzed file is not done, regardless of diff size or session length.

## Assembly

Once every target's cross-file part is written, run `commands.assembleAll` (a FIXED IDENTIFIER, like every key of the context JSON) verbatim, in ONE Bash call — the same line every time, never a variant of your own.
It is `node "<SKILL_DIR>/scripts/check-part.cjs" --context="<contextPath>" --assemble-all`: it runs each target's `target.commands.assemble` in turn and, once all of them passed, prints the run's terminal summary (Step 5 below).
Each target's assembly checks the parts against the context and only when they pass appends them to `target.reportPath` (which already holds the header), removes the parts, the import ledger and the work folder, and finishes the report with the renderer — the HTML page from the assembled Markdown, or, when `target.htmlReportPath` is null, the Markdown itself — with a code snippet under every finding, read from the revision the review read, except under `target.light`.
When a part is missing or breaks the format, that target's assembly exits 1, lists every problem by part file and leaves its parts, ledger and work folder on disk; the command goes on with the other targets and exits 1 naming the ones it could not assemble.
Fix each part it names with Edit — the hook checks an Edit of a part as the file it would leave behind, and a refused one waits in a draft as in Step 3 point 4 — and run the same command again: a target already assembled says so and changes nothing.
Once a target's check passes, it rewrites the numbers of every coverage marker from the block above it and every severity a fixed one overrides (Step 4), folds a finding reported twice into one (the two sides of a `ta sama wada` pair on the same lines; a template's finding and its class's, under items the rulebook pairs), and, on a stack of branches, marks the findings on lines a later part of the stack changes.

When `htmlReportPath` is null (`--only-md` was passed) the Markdown is the report: the renderer renders nothing and, without `--with-checklist`, cuts the checklists out of the Markdown.
Under `target.light` it also cuts every ⚪ **Low** finding — from the Markdown and the page alike, after the fixed severities are set — so its `severity:` line prints `low=0`.
Otherwise the renderer replaces the Markdown with `target.htmlReportPath`; if it prints warnings it keeps the Markdown too — but a kept Markdown has two very different causes, and only one of them is yours to fix.
`nierozpoznana…`/`nieczytelny…` warnings mean the report really did drift from the Step 4 format: a line the parser could not read, which costs the HTML that finding or that tick.
A `sprawdzono <checked>/<total>` warning (a `--with-checklist` run only) means the opposite — the block parsed perfectly and simply carries an item you left `[ ] NIEZWERYFIKOWANE`.
That one is the format working as intended; never answer it by going back and ticking an item you did not check.
Once the check passes it also prints `check-part: pliki z pełnym przejściem checklisty: <full>/<files>`, followed by every file whose walk left an item open with its `<checked>/<total>` — Step 5 takes the coverage from this line, because only a `--with-checklist` report keeps the markers.

## Step 5 — Terminal summary (Polish)

`commands.assembleAll` prints it, once every target is assembled, between the lines `=== PODSUMOWANIE (Step 5) ===` and `=== KONIEC PODSUMOWANIA ===` (FIXED IDENTIFIERS): print that block as your final message, as it is, and nothing else — it already holds everything below, read off what each assembly printed.
Written by hand, the summary of a five-target run left two warnings out (2026-10-30).
Only when you assembled with `target.commands.assemble` alone (an older context without `commands.assembleAll`) write it yourself, by these rules.

After writing all reports print, in Polish: each report path (`target.htmlReportPath`, or `target.reportPath` when it is null) + finding counts per severity exactly as the renderer's `severity:` line prints them (never count them from the report yourself), plus any errors/warnings from Step 1 and any warning the renderer printed.
Also state the checklist coverage of the target: how many files walked their whole checklist, and — when any did not — every such file with its `<checked>/<total>`, so an unticked item is read as the gap it is instead of disappearing into the report.
Read both off the `check-part: pliki z pełnym przejściem checklisty` line the assembly printed, not off the report: without `--with-checklist` the report no longer holds them.
For a `--since-last` run also say how many files were skipped as unchanged and where the previous report is (`target.unchangedSinceLastReview`, `target.previousReportPath`) — the reader must know the report covers only what moved.
For a resumed target (`target.resume`) say that it continued the run from `resume.from` and how many files it took over from it.
For a `--light` run (`target.light`) say that the checklists left out the items of severity low and the report leaves out every Low finding (and the HTML page every code snippet) — the reader must not take a short report for a clean one.
For a branch target also name the base it was reviewed against — `target.baseBranch` plus where that base came from, read off `target.baseSource`: `pr` = the target branch of PR #`target.prNumber`, `fork` = the branch it was created from, `candidate` = the default `main`/`master`/`develop`/`dev` detection. Staged and folder targets have no base (`baseSource` is null): a staged review covers the uncommitted changes themselves.
Nothing else.
