# codeReview — a refused part

Read when the hook refuses the Write or Edit of a part (Step 3 point 4); a walk with no refusal never needs it.

A part that fails is NOT written: the refusal lists the problems, each quoting its draft lines
(`[szkic L<n>: "…"]`), and the text waits in `<stem>.part<NN>.draft.md` in `target.workDir`.
Read that draft once - with the next batch's Reads, or after the last batch before the cross-file
pass; the harness refuses an Edit of a file this conversation has not read - and fix exactly
those lines with Edit. The hook checks every Edit again and writes the part once it passes
(`check-part: <part> zapisana ze szkicu.`); only when no such note came back, run the `--promote`
command the refusal prints. A part refused only because an earlier part of the window is missing
(`najpierw brakujące wcześniejsze części`) needs nothing: its draft lands by itself once the
earlier part does - fix the earlier one. Only a refusal naming no draft means writing the part again.
A box that contradicts its word, or a NIEZWERYFIKOWANE that lost its colon, the hook puts right
itself (`check-part: <part> zapisana po poprawce formy`).
A part can pass with a note, `check-part: <part> zapisana, z uwagą:`, naming two findings with
the same lines - under items the bundle marks `ta sama wada` (point 3), or under two instructions.
One defect: merge them with ONE Edit of that part - one finding whose `**Reguła:**` names every
address, the most specific first, each item keeping its `NARUSZENIE` line. Two defects that only
share lines: leave the part as it is.
