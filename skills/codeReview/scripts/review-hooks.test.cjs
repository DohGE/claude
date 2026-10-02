'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hooks = require('./review-hooks.cjs');
const bundle = require('./review-bundle.cjs');
const { tempDir } = require('./test-helpers.cjs');

const script = path.join(__dirname, 'review-hooks.cjs');
const skillDir = path.resolve(__dirname, '..').replace(/\\/g, '/');
const slash = (p) => p.replace(/\\/g, '/');

// A file bundle cut to what the hooks read: the plan's item lines with a sub-line each, and a
// line outside the plan shaped like an item.
const bundleText = (file, addresses) => [
  `# ${file}`,
  '',
  '## Plan',
  '',
  '### General (`general:1-3`)',
  ...addresses.flatMap((address) => [`- ${address}: Treść pozycji ${address}.`, `  - drugie pytanie: ${address} w tym pliku?`]),
  '',
  '## Zapis części',
  '',
  '- general#1: linia spoza planu zostaje',
  '',
].join('\n');

// One target of two files laid out as review-context.cjs writes it: the run folder
// `runs/<stamp>/feature/` with its work folder (contents, diffs, bundles, the cross bundle), the
// run's context in the cache folder of its branch - the context check-part.test.cjs checks its
// parts against - and the sessions' state in a folder of its own.
function fixture(t, { batches = [], dedupItems = false } = {}) {
  const dir = tempDir(t, 'review-hooks-');
  const branchDir = path.join(dir, 'runs', '2026-01-02-03-04-05', 'feature');
  const reportPath = path.join(branchDir, 'raport.md');
  const workDir = slash(reportPath.replace(/\.md$/, '.work'));
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(reportPath, '# Code Review: feature → master | 2026-01-02 03:04\n');
  const walked = (k, name, lines, addresses) => {
    const stem = `${workDir}/0${k}-${name}`;
    fs.writeFileSync(stem, 'x\n'.repeat(lines));
    fs.writeFileSync(`${stem}.diff`, '@@ -1,5 +1,5 @@\n');
    fs.writeFileSync(`${stem}.bundle.md`, bundleText(`src/${name}`, addresses));
    return { contentPath: stem, diffPath: `${stem}.diff`, bundlePath: `${stem}.bundle.md` };
  };
  const crossBundlePath = `${workDir}/${bundle.crossBundleName}`;
  fs.writeFileSync(crossBundlePath, ['# Przejście międzyplikowe', '', bundle.reportedStart, ...bundle.renderReported(null), bundle.reportedEnd, '', '## Zapis części', ''].join('\n'));
  const context = {
    outputFormat: 'md',
    rulebookNotesPath: `${slash(dir)}/cache/rules/rulebook-notes.md`,
    claudeMd: null,
    checklistPlans: [
      { kind: 'component', role: 'Angular component class.', checklist: ['general:1-3', 'security:1-2', 'component:1-2'] },
      { kind: 'service', role: 'Injectable service.', checklist: ['general:1-3'] },
    ],
    checklistGates: { security: 'The file handles input.' },
    targets: [{
      kind: 'branch',
      branch: 'feature',
      reportPath,
      workDir,
      crossBundlePath,
      batches,
      ...(dedupItems ? { dedupItems: true } : {}),
      commands: { grep: 'grep -rn', assemble: 'node check-part.cjs --context=c --report=r && { …; }' },
      files: [
        { path: 'src/a.ts', status: 'M', plan: 0, checklistTotal: 7, changedLines: '1-5', ...walked(1, 'a.ts', 20, ['general#1', 'general#2', 'component#1']) },
        { path: 'src/b.ts', status: 'A', plan: 1, checklistTotal: 3, changedLines: null, ...walked(2, 'b.ts', 5, ['general#1', 'general#3']) },
      ],
    }],
  };
  const cacheDir = path.join(dir, 'cache', 'feature');
  fs.mkdirSync(cacheDir, { recursive: true });
  const contextPath = path.join(cacheDir, '.review-context-branch.json');
  const save = () => fs.writeFileSync(contextPath, JSON.stringify(context));
  save();
  const stateDir = path.join(dir, 'state');
  return {
    dir, context, target: context.targets[0], contextPath, reportPath, workDir, stateDir, save,
    env: { DOH_REVIEW_STATE_DIR: stateDir },
    part: (k) => bundle.partPathOf(reportPath, k, 2),
    draft: (k) => `${workDir}/raport.part0${k}.draft.md`,
  };
}

// The parts check-part.test.cjs shows passing against this context.
const partA = (general13 = '[x] general#1,#3 — OK (brak wystąpień)') => [
  '## src/a.ts',
  '',
  '🟡 **Medium**',
  '- **Linia:** 4, 9',
  '- **Problem:** Opis.',
  '- **Reguła:** component#1; general#2',
  '- **Expected Result:** Poprawka.',
  '',
  '<!-- checklist: src/a.ts',
  general13,
  '[x] general#2 nazwy — NARUSZENIE (4, 9)',
  '[x] security#1-2 — BRAMKA: plik nie przyjmuje danych z zewnątrz',
  '[x] component#1 OnPush — NARUSZENIE (4, 9)',
  '[ ] component#2 walidatory — NIEZWERYFIKOWANE: działająca aplikacja: komunikat walidacji po wysłaniu formularza',
  '-->',
  '<!-- coverage: src/a.ts 6/7 -->',
  '',
].join('\n');

const partB = [
  '<!-- checklist: src/b.ts',
  '[x] general#1 — OK (L1, L4)',
  '[x] general#2-3 — OK (brak wystąpień)',
  '-->',
  '<!-- coverage: src/b.ts 3/3 -->',
  '',
].join('\n');

const read = (f, file, session = 's1') => hooks.onRead({ session_id: session, tool_name: 'Read', tool_input: { file_path: file } }, f.env);
const compact = (f, session = 's1') => hooks.onCompact({ session_id: session, source: 'compact' }, f.env);
const stateOf = (f, session = 's1') => JSON.parse(fs.readFileSync(path.join(f.stateDir, `${session}.json`), 'utf8'));
const noteOf = (out) => out && out.hookSpecificOutput.additionalContext;

test('read: the context ties the session to its run; a week-old state and a stale lock are cleared', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  const old = path.join(f.stateDir, 'old.json');
  fs.writeFileSync(old, '{}');
  const lock = path.join(f.stateDir, 's1.json.lock');
  fs.writeFileSync(lock, '');
  const past = (file, ms) => fs.utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));
  past(old, 8 * 24 * 60 * 60 * 1000);
  past(lock, 20 * 1000);
  assert.strictEqual(read(f, f.contextPath), null);
  assert.deepStrictEqual(stateOf(f), { contextPath: path.resolve(f.contextPath), shown: {} });
  assert.ok(!fs.existsSync(old) && !fs.existsSync(lock));
  // A session id unfit for a file name, or a JSON that is no review context: nothing recorded.
  assert.strictEqual(read(f, f.contextPath, '../s2'), null);
  const other = path.join(f.dir, 'package.json');
  fs.writeFileSync(other, '{"targets":[{}]}');
  assert.strictEqual(read(f, other, 's3'), null);
  assert.deepStrictEqual(fs.readdirSync(f.stateDir), ['s1.json']);
});

test('read: the cross bundle shows what the parts on disk report, rewritten before every Read of it', (t) => {
  const f = fixture(t);
  const cross = f.target.crossBundlePath;
  // No session: the run is found from the report next to the work folder.
  assert.strictEqual(read(f, cross, null), null);
  assert.match(fs.readFileSync(cross, 'utf8'), /\n## Już zgłoszone w częściach plików\n\n- brak\n/);
  assert.ok(!fs.existsSync(f.stateDir));
  fs.writeFileSync(f.part(1), partA());
  fs.writeFileSync(f.part(2), partB);
  assert.strictEqual(read(f, cross), null);
  const text = fs.readFileSync(cross, 'utf8');
  assert.ok(text.includes('\n- src/a.ts: component#1, general#2 (4, 9)\n'), text);
  assert.ok(text.includes('\n- brak - część przejścia nie ma bloku unverified\n'), text);
  assert.ok(text.startsWith(`# Przejście międzyplikowe\n\n${bundle.reportedStart}\n`) && text.endsWith(`${bundle.reportedEnd}\n\n## Zapis części\n`), text);
  assert.strictEqual(stateOf(f).contextPath, f.contextPath);
});

test('read under --dedup-items: an item another bundle showed since the last compaction is a reference, line for line', (t) => {
  const f = fixture(t, { dedupItems: true });
  const [a, b] = f.target.files.map((file) => file.bundlePath);
  assert.strictEqual(read(f, a), null);
  // Its own items again: read as written.
  assert.strictEqual(read(f, a), null);
  const copy = `${f.workDir}/02-b.ts.bundle.dedup.md`;
  assert.deepStrictEqual(read(f, b), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'codeReview --dedup-items: 1 pozycji z treścią z wcześniejszej paczki',
      updatedInput: { file_path: copy },
    },
  });
  const original = fs.readFileSync(b, 'utf8').split('\n');
  const shown = fs.readFileSync(copy, 'utf8').split('\n');
  assert.strictEqual(shown.length, original.length);
  assert.deepStrictEqual(shown.filter((line, i) => line !== original[i]), ['- general#1: treść jak w paczce 01-a.ts.bundle.md, przeczytanej wcześniej']);
  assert.deepStrictEqual(stateOf(f).shown, {
    'general#1': '01-a.ts.bundle.md', 'general#2': '01-a.ts.bundle.md', 'component#1': '01-a.ts.bundle.md', 'general#3': '02-b.ts.bundle.md',
  });
  // A compaction takes the texts out of the conversation: the next Read shows them in full.
  assert.ok(compact(f));
  assert.deepStrictEqual(stateOf(f).shown, {});
  assert.strictEqual(read(f, b), null);
});

test('read without --dedup-items: every bundle is read as written', (t) => {
  const f = fixture(t);
  for (const file of f.target.files) assert.strictEqual(read(f, file.bundlePath), null);
  assert.deepStrictEqual(fs.readdirSync(f.workDir).filter((name) => name.endsWith('.dedup.md')), []);
  assert.deepStrictEqual(stateOf(f), { contextPath: f.contextPath, shown: {} });
});

test('draft: an Edit that fixes a refused part\'s draft moves it into place, and the drafts waiting behind it follow', (t) => {
  const f = fixture(t);
  const edit = (k) => hooks.onDraft({ tool_name: 'Edit', tool_input: { file_path: f.draft(k), old_string: 'a', new_string: 'b' }, cwd: f.dir });
  fs.writeFileSync(f.draft(2), partB);
  fs.writeFileSync(f.draft(1), partA('[x] general#1,#3 — OK'));
  const refused = edit(1);
  assert.strictEqual(refused.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(noteOf(refused).startsWith('Szkic raport.part01.draft.md nadal nie przechodzi kontroli formatu (codeReview SKILL.md, Step 3 point 4) - popraw kolejnym Edit tylko wskazane miejsca, hook sprawdzi go znowu:\n- '), noteOf(refused));
  assert.ok(noteOf(refused).includes('OK bez dowodu'), noteOf(refused));
  assert.ok(fs.existsSync(f.draft(1)) && !fs.existsSync(f.part(1)));
  fs.writeFileSync(f.draft(1), partA());
  assert.strictEqual(noteOf(edit(1)), 'check-part: raport.part01.md zapisana ze szkicu.\ncheck-part: raport.part02.md zapisana ze szkicu.');
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
  assert.deepStrictEqual(fs.readdirSync(f.workDir).filter((name) => name.endsWith('.draft.md')), []);
  // A draft older than its part: the part was written again since.
  fs.writeFileSync(f.draft(1), partA('[x] general#1,#3 — OK'));
  const old = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(f.draft(1), old, old);
  assert.strictEqual(noteOf(edit(1)), 'check-part: raport.part01.md zapisano po tym szkicu - szkic był nieaktualny i został usunięty.');
  assert.ok(!fs.existsSync(f.draft(1)));
  // A part itself is check-part.cjs's to check, and a draft outside a run's work folder no one's.
  assert.strictEqual(hooks.onDraft({ tool_name: 'Write', tool_input: { file_path: f.part(1) } }), null);
  const stray = path.join(f.dir, 'raport.part01.draft.md');
  fs.writeFileSync(stray, partA());
  assert.strictEqual(hooks.onDraft({ tool_name: 'Edit', tool_input: { file_path: stray } }), null);
  assert.strictEqual(hooks.onDraft({ tool_name: 'Read', tool_input: { file_path: f.draft(2) } }), null);
});

test('skillLines: from a little before the cut of the re-attached body to the one-time part', (t) => {
  const dir = tempDir(t, 'review-hooks-skill-');
  const file = path.join(dir, 'SKILL.md');
  const body = `${'a'.repeat(99)}\n`.repeat(200);
  // 3 frontmatter lines, then 100-char lines: the cut at body char 19000 opens line 3 + 190 + 1.
  fs.writeFileSync(file, `---\nname: x\n---\n${body}${hooks.oneTimeMarker}\nraz\n`);
  assert.deepStrictEqual(hooks.skillLines(file), { path: file, from: 194, limit: 10 });
  fs.writeFileSync(file, `---\nname: x\n---\n${body}`);
  assert.strictEqual(hooks.skillLines(file), null);
  fs.writeFileSync(file, `---\nname: x\n---\n${hooks.oneTimeMarker}\n${body}`);
  assert.strictEqual(hooks.skillLines(file), null);
  assert.strictEqual(hooks.skillLines(path.join(dir, 'missing.md')), null);
});

test('skillLines: the shipped SKILL.md sends a compacted session back for the rest of the walk, not for Steps 1-2', () => {
  // A marker inside the re-attached head, or none, and the hook sends nobody back: the
  // report format and the rest of Step 3 would be lost to the first compaction.
  const file = path.join(__dirname, '..', 'SKILL.md');
  const lines = hooks.skillLines(file);
  assert.ok(lines, 'SKILL.md carries the one-time marker past the re-attached head');
  const text = fs.readFileSync(file, 'utf8').split('\n');
  const reread = text.slice(lines.from - 1, lines.from - 1 + lines.limit).join('\n');
  assert.match(reread, /^## Step 4 /m, 'the re-read reaches the report format');
  assert.match(reread, /^## Skip rationalizations/m, 'and the rationalizations');
  assert.doesNotMatch(reread, /^## Step [12] /m, 'and stops before the steps run once');
  assert.strictEqual(text.join('\n').split(hooks.oneTimeMarker).length, 2, 'the marker stands once');
});

test('compact: where the run stands - the next file or batch with its Reads, the cross pass, the assembly', (t) => {
  const f = fixture(t, { batches: [[1, 2]] });
  const skillFile = path.join(f.dir, 'SKILL.md');
  fs.writeFileSync(skillFile, `---\nname: x\n---\n${`${'a'.repeat(99)}\n`.repeat(200)}${hooks.oneTimeMarker}\n`);
  const at = () => hooks.position(f.context, f.contextPath, skillFile);
  const head = [
    'codeReview: sesję skompaktowano w trakcie recenzji. Kontynuuj od miejsca niżej; zapisanych części nie pisz od nowa.',
    `- kontekst: ${f.contextPath}`,
    `- cel 1/1: feature, raport ${f.reportPath}`,
    `- rulebook (Step 2) wraca tylko z pliku: przeczytaj (Read) ${f.context.rulebookNotesPath}`,
  ];
  const skill = `- SKILL.md wrócił po kompaktowaniu tylko do około linii 194 (po wznowieniu sesji - wcale): przeczytaj (Read) ${skillFile} z offset 194 i limit 10 - reszta kroku 3 i format raportu.`;
  const [a, b] = f.target.files;
  assert.deepStrictEqual(at(), [
    ...head,
    `- zapisane części plików: 0/2; następny plik 1/2: src/a.ts, część ${f.part(1)}`,
    '- partia: pliki 1-2, ich części razem w jednej odpowiedzi',
    '- przeczytaj (Read) w jednej odpowiedzi:',
    ...[a.bundlePath, a.contentPath, a.diffPath, b.bundlePath, b.contentPath, b.diffPath].map((p) => `  - ${p}`),
    skill,
  ]);
  // The batch's first part landed alone: the rest of the batch.
  fs.writeFileSync(f.part(1), partA());
  fs.writeFileSync(f.draft(2), partB);
  assert.deepStrictEqual(at().slice(head.length), [
    `- zapisane części plików: 1/2; następny plik 2/2: src/b.ts, część ${f.part(2)}`,
    '- przeczytaj (Read) w jednej odpowiedzi:',
    ...[b.bundlePath, b.contentPath, b.diffPath].map((p) => `  - ${p}`),
    `- szkice odrzuconych części czekają na Edit (hook przenosi szkic po Edit): ${f.draft(2)}`,
    skill,
  ]);
  fs.rmSync(f.draft(2));
  fs.writeFileSync(f.part(2), partB);
  assert.deepStrictEqual(at().slice(head.length, -1), [
    `- części plików zapisane (2/2); następne: przejście międzyplikowe, część ${f.part(3)}`,
    '- przeczytaj (Read) w jednej odpowiedzi:',
    `  - ${f.target.crossBundlePath}`,
    `  - ${skillDir}/references/cross-file.md`,
  ]);
  fs.writeFileSync(f.part(3), '');
  assert.deepStrictEqual(at().slice(head.length, -1), [
    `- następne: złożenie - przeczytaj (Read) ${skillDir}/references/assembly.md i uruchom \`target.commands.assemble\`:`,
    `  ${f.target.commands.assemble}`,
  ]);
  // A later target waits its turn; a target with no files closes on its first part.
  const empty = { ...f.target, branch: 'hotfix', files: [], batches: [], reportPath: path.join(f.dir, 'runs', '2026-01-02-03-04-05', 'hotfix', 'raport.md') };
  empty.workDir = slash(empty.reportPath.replace(/\.md$/, '.work'));
  fs.mkdirSync(empty.workDir, { recursive: true });
  f.context.targets.push(empty);
  assert.strictEqual(at()[2], `- cel 1/2: feature, raport ${f.reportPath}`);
  assert.strictEqual(at().at(-2), '- potem cele: hotfix');
  fs.rmSync(f.workDir, { recursive: true });
  assert.deepStrictEqual(at().slice(2, 5), [
    `- cel 2/2: hotfix, raport ${empty.reportPath}`,
    head[3],
    `- następne: ${bundle.partPathOf(empty.reportPath, 1, 0)} z jedyną linią \`Nie wykryto zmian do analizy.\`, potem złożenie (${skillDir}/references/assembly.md)`,
  ]);
  fs.rmSync(empty.workDir, { recursive: true });
  assert.strictEqual(at(), null);
});

test('compact: the session\'s run, once assembled, ends its state; a session with no run gets nothing', (t) => {
  const f = fixture(t);
  assert.strictEqual(compact(f), null);
  read(f, f.contextPath);
  const out = compact(f);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(noteOf(out).startsWith(`codeReview: sesję skompaktowano w trakcie recenzji. Kontynuuj od miejsca niżej; zapisanych części nie pisz od nowa.\n- kontekst: ${path.resolve(f.contextPath)}\n`), noteOf(out));
  fs.rmSync(f.workDir, { recursive: true });
  assert.strictEqual(compact(f), null);
  assert.ok(!fs.existsSync(path.join(f.stateDir, 's1.json')));
});

test('registration: the plugin runs every codeReview hook, SKILL.md none of them', () => {
  // A hook in the skill's frontmatter stops firing once the session is compacted - the parts
  // written after it went unchecked - so the plugin's hooks.json carries them all.
  // core.autocrlf may check SKILL.md out with CRLF; the YAML is the same.
  const text = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.ok(!/review-hooks\.cjs|check-part\.cjs/.test(front), front);
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const run = (name, args, timeout) => ({
    hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/skills/codeReview/scripts/${name}`, ...args], timeout }],
  });
  // The compaction note comes through the plugin's shared hook, which asks every skill's part.
  assert.deepStrictEqual(config.hooks.SessionStart, [{
    matcher: 'compact',
    hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/compact-hook.cjs', '--event=compact'], timeout: 10 }],
  }]);
  assert.ok(require('../../../scripts/compact-hook.cjs').parts.some((file) => file === path.join(__dirname, 'review-hooks.cjs')));
  assert.deepStrictEqual(config.hooks.PreToolUse, [
    { matcher: 'Write|Edit|Bash', ...run('check-part.cjs', [], 30) },
    { matcher: 'Read', ...run('review-hooks.cjs', ['--event=read'], 30) },
  ]);
  assert.deepStrictEqual(config.hooks.PostToolUse, [{ matcher: 'Write|Edit', ...run('review-hooks.cjs', ['--event=draft'], 30) }]);
  for (const event of ['read', 'draft', 'compact']) assert.strictEqual(hooks.parseArgs([`--event=${event}`]).event, event);
});

test('CLI: prints the hook\'s JSON; a bad input is exit 0 with no output, a bad argument exit 1', (t) => {
  const f = fixture(t);
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, ...f.env } });
  let r = run(['--event=read'], JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: f.contextPath } }));
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  r = run(['--event=compact'], JSON.stringify({ session_id: 's1', source: 'compact' }));
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`następny plik 1/2: src/a.ts, część ${f.part(1)}`));
  r = run(['--event=compact'], 'nie JSON');
  assert.deepStrictEqual([r.status, r.stdout], [0, '']);
  r = run(['--event=draft'], JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: f.draft(1) } }));
  assert.deepStrictEqual([r.status, r.stdout], [0, '']);
  r = run(['--event=nope'], '{}');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--event=read\|draft\|compact/);
  assert.strictEqual(run([], '{}').status, 1);
});

test('compact: the walk card rides in every compaction note, since a resumed session gets no SKILL.md back', () => {
  const card = hooks.walkCard(path.join(__dirname, '..', 'SKILL.md'));
  assert.ok(card && card.length >= 5, 'the shipped card is read');
  assert.ok(card.join('\n').length <= 3000, 'the card stays short: it rides in every compaction');
  assert.match(card.join('\n'), /Do odpowiedzi/);
  assert.strictEqual(hooks.walkCard(path.join(__dirname, 'no-such-skill', 'SKILL.md')), null);
});
