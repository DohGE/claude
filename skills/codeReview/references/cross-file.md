# codeReview — the cross-file pass

Read together with `target.crossBundlePath`, in the message that writes a target's last file part: the last bundle's `## Dalej` names both, and after a compaction the hook does.
This is point 3 of Step 3 (SKILL.md), answered once for the whole target.

After the per-file pass, do ONE cross-file pass over the whole diff for point 3, written as part
`N+1` (`N` = `target.files.length`): its findings sections and, when the rule below asks for it,
one `<!-- unverified:` block — no checklist block and no coverage marker.
That part is written on every target with files — empty when the pass found nothing, because the
assembly refuses a report without it.
The pass works from `target.crossBundlePath` (a FIXED IDENTIFIER, like every key of the context
JSON), read with the Read tool: the facts that span files (`## Fakty międzyplikowe` — repeated
literals and conditions, label mappings implemented twice, relative imports that leave their area),
the items the pass reports under with their text (`## Pozycje, pod którymi przejście raportuje`),
the jscpd candidates and the part's template (`## Zapis części`).
The hook fills in two lists as the bundle is read: `## Już zgłoszone w częściach plików` (what the file parts already report, by address and lines) and `## Otwarte w 3+ plikach (blok unverified)` (the addresses this part's block answers).
When it did not, the bundle says so, and you read both off the file parts yourself.
A cross-file fact is a lead, like a per-file `WSKAZÓWKA`: open the places it names, and report what
the questions below find there.
Answer each of these five questions explicitly, against the diff as a whole:
1. Duplication drift — is the same logic, formatting or literal implemented in two or more places
   of this diff, or re-implemented next to an existing shared util? Answer it from three sources:
   - `target.duplicationCandidates` — jscpd's scan of the whole reviewed revision, kept only where
     the diff wrote at least half of the copy: `path` and `lines` are the copy, `sources` what it
     repeats, `kinds` how it matched (`exact`, `renamed` identifiers, `similar` with a gap).
     Open both sides of every candidate.
     Dismiss one only when the two blocks share no logic: a shape the framework or a generator
     dictates (a TestBed skeleton, a module or route declaration, a generated `project.json` or
     `tsconfig`), parallel data (translation files), or — for a `renamed` or `similar` candidate —
     nothing but syntax, because the blocks call different functions and read different fields (two
     `ngOnInit`s, each calling its own initializers).
     Renamed local variables and parameters over the same operations are still a copy.
     Report every other one.
     A target without the list was not scanned (its warning says why), and the other two sources
     then carry the question alone.
   - A search for what a token scan cannot see: for every exported function, class, pipe,
     directive, validator, util or constant the diff ADDS, look for an existing equivalent in the
     reviewed revision with `target.commands.grep` (Read the file it names) — by its name, a
     synonym and the characteristic expression of its body — in the shared folders first (`shared/`, `utils/`, `common/`, `core/`,
     or wherever this project keeps them).
   - What the per-file walk already noticed.

   Report every copy the diff adds under the code-quality instruction as 🔴 High, anchored on a
   line of the copy that the diff changed, and name the source it repeats (`path:lines`).
2. Layering — Read `target.importLedger` and walk it edge by edge, together with the edges you
   noted for its `# not parsed` files. Each line is `<importing file>:<line> → <specifier>`, plus
   `(<resolved path>)` for a relative one; `<line>` is the import's line in that file's
   `contentPath`. Name the layer
   of the importing file and of the imported module, check the edge's direction AND its form
   (barrel vs concrete path, per the architecture instruction) against the architecture
   instruction, and report each forbidden edge at the importing file, on that line. A permitted
   direction does not end the edge's verdict — a legal edge taken through the wrong form is still a
   finding. "No layering findings" may be claimed only after every ledger entry has its verdict.
3. Derived-data flow — does any state field, action payload or component binding carry a value
   computable from other state? Report every station of the flow (the action, the reducer field,
   the dispatching component), each under its own instruction.
4. Naming consistency — the same concept named differently across the diff's files, or one name
   reused for different concepts; reported under the code-quality instruction (🟡 Medium), while a
   plain naming-convention breach stays a general-instruction finding.
5. View consistency (`accessibility#22`: WCAG 3.2.3, 3.2.4, 3.2.6) — when the diff renders
   navigation, a repeated control or a help mechanism in more than one view (a template, `index.html`,
   a layout component), compare them: the same navigation in the same relative order, the same
   function under the same label and icon, the same help link in the same relative place.
   No per-file walk can answer this — each template sees only itself.
   Report each inconsistency under `accessibility#22`, at a line the diff changed, naming the other
   view (`path:lines`).

**A defect a file part already reports is not reported again here.**
The check refuses a finding of this part on a file whose part already reports those lines under the same address, or under one the bundle marks `ta sama wada`: remove it from this part.
When the file's finding lacks the other side of a duplication, add that `path:lines` to its `**Problem:**` with one Edit of that part, never as a second finding.

The per-file walks leave some items open for want of what one file holds.
**An item left `[ ]` in 3 or more files' parts is answered once more here, for the whole target**,
because what one file could not settle, the files together often can (one name across several
files, one view against another).
List exactly those addresses, each once, in one block at the end of the cross-file part — the
bundle's `## Otwarte w 3+ plikach (blok unverified)` names them, and without it you count the `[ ]`
lines of the file parts yourself:

    <!-- unverified:
    [x] accessibility#22 spójne widoki — NARUSZENIE (index.html:12)
    [x] general#6 importy między obszarami — OK (src/app/users/user.const.ts)
    [ ] component#15 walidatory runtime — NIEZWERYFIKOWANE: działająca aplikacja: komunikat po wysłaniu formularza
    -->

Each line has a verdict of its own, with the same forms and reasons as a file's block, except
`BRAMKA`, which closes an instruction per file and so never stands here; a `NARUSZENIE` needs a
finding of this part whose `**Reguła:**` names that address.
The check counts the `[ ]` lines of every file part and refuses the cross-file part when the block
misses such an address, lists one that is not open in 3 or more files, or lists one twice.
An item with a prepared verdict (`gotowy werdykt:` in the file bundles) stays out: the rulebook answered it, so the bundle's list leaves it out and the check does not ask for it.
The opener `<!-- unverified:` is a FIXED IDENTIFIER: translated, the check sees a plain comment
and reports the block missing.
No address open in 3 or more files means no block.

A target whose whole review produced no finding closes with one more part file after the cross-file
one, holding the single line `Nie wykryto problemów.` — the per-file parts before it still carry
every checklist block and coverage marker, which is what a `--with-checklist` report then shows.
The bundle's `## Zapis części` names that part.

Write the cross-file part — and the closing part, when the target found nothing — and, in the same message, Read `references/assembly.md` in this skill's directory: the assembly comes next.
