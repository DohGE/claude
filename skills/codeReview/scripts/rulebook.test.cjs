'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rulebook = require('./rulebook.cjs');
const { tempDir } = require('./test-helpers.cjs');

// One instruction as a kind file carries it: `texts` lists the items numbered from 1,
// or maps item numbers to texts when the kind walks only some of them.
function instruction(id, texts, props = {}) {
  const entries = Array.isArray(texts)
    ? texts.map((text, i) => [i + 1, text])
    : Object.entries(texts).map(([n, text]) => [Number(n), text]);
  return { id, name: id, ...props, items: entries.map(([n, text]) => ({ id: `${id}#${n}`, text })) };
}

function kind(name, pattern, instructions = [], extra = {}) {
  return { kind: name, pattern, role: `${name} files`, ...extra, instructions };
}

function writeLayer(dir, kinds) {
  for (const k of kinds) fs.writeFileSync(path.join(dir, `${k.kind}.json`), JSON.stringify(k, null, 2));
  return dir;
}

function rulebookOf(t, kinds) {
  return rulebook.loadRulebook([writeLayer(tempDir(t, 'rb-'), kinds)]);
}

const kindName = (rules, relPath) => (rulebook.matchKind(rules, relPath).kind || { name: null }).name;

test('formatItemSpec collapses consecutive item numbers into ranges', () => {
  assert.strictEqual(rulebook.formatItemSpec([1, 2, 3]), '1-3');
  assert.strictEqual(rulebook.formatItemSpec([1, 3, 4, 5, 9]), '1,3-5,9');
  assert.strictEqual(rulebook.formatItemSpec([7]), '7');
  assert.strictEqual(rulebook.formatItemSpec([]), '');
});

test('(a|b) groups expand innermost first, and a repeated choice is one pattern', () => {
  assert.deepStrictEqual(rulebook.expandAlternations('<name>.component.(scss|css)'),
    ['<name>.component.scss', '<name>.component.css']);
  assert.deepStrictEqual(rulebook.expandAlternations('a/(b|c(d|e))/f'), ['a/b/f', 'a/cd/f', 'a/ce/f']);
  assert.deepStrictEqual(rulebook.expandAlternations('(x|x).ts'), ['x.ts']);
  assert.deepStrictEqual(rulebook.expandAlternations('plain.ts'), ['plain.ts']);
});

test('a pattern matches the end of a path, one segment per placeholder or star', () => {
  const matches = (pattern, relPath) => rulebook.compilePattern(pattern).some((v) => v.regex.test(relPath));
  const service = 'src/app/<area>/<name>.service.ts';
  assert.ok(matches(service, 'src/app/users/users.service.ts'));
  assert.ok(matches(service, 'apps/web/src/app/users/users.service.ts'), 'inside a workspace too');
  assert.ok(!matches(service, 'src/app/users/api/users.service.ts'), 'a placeholder is one segment');
  assert.ok(!matches(service, 'xsrc/app/users/users.service.ts'), 'segments match whole');
  assert.ok(!matches('<name>.ts', '.ts'), 'a placeholder is never empty');
  assert.ok(matches('*.ts', 'main.ts') && matches('*.ts', 'src/main.ts'));
  assert.ok(matches('src/**/x.ts', 'src/x.ts') && matches('src/**/x.ts', 'src/a/b/x.ts'), '** is any number of folders');
  assert.ok(matches('src/assets/**', 'src/assets/i18n/en.json'));
  assert.ok(!matches('src/assets/**', 'src/assets'), 'a trailing ** needs a file under it');
  assert.ok(matches('+state/<name>.(actions|reducer).ts', 'x/+state/a.reducer.ts'), 'regex characters are literal');
  assert.ok(!matches('a.ts', 'abts'), 'a dot is a dot');
  assert.ok(matches(['<name>.component.html', '*.html'], 'index.html'), 'a list is any of its patterns');
});

test('a pattern the grammar cannot read is refused with the reason', () => {
  const reason = (pattern) => {
    try {
      rulebook.compilePattern(pattern);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  // `**/*.{ts,html}` reads like a normal glob and is one almost everywhere else. Taken
  // literally it would match no file at all, and a kind that matches nothing produces
  // no findings - so it is refused, with the spelling that works.
  assert.match(reason('**/*.{ts,html}'), /braces are not alternatives here - write \(a\|b\)/);
  assert.match(reason('!**/models/**'), /cannot exclude - a more specific kind takes the files it describes/);
  assert.match(reason('src//a.ts'), /empty path segment/);
  assert.match(reason('src/a**.ts'), /"\*\*" must be a whole path segment/);
  assert.match(reason('src/<>.ts'), /placeholder/);
  assert.match(reason('src/<name.ts'), /placeholder/);
  assert.match(reason('src/(a|b.ts'), /unbalanced "\("/);
  assert.match(reason('src/a|b.ts'), /unbalanced "\|"/);
  assert.match(reason([]), /non-empty string/);
  assert.match(reason(['a.ts', '']), /non-empty string/);
  assert.strictEqual(reason('src/app/<area>/(a|b).ts'), null);
});

test('the most specific kind wins: file name first, then a full path over a name alone, then folders', (t) => {
  const rules = rulebookOf(t, [
    kind('any-html', '*.html'),
    kind('template', '<name>.component.html'),
    kind('feature-template', 'src/app/<area>/feature/<name>/<name>.component.html'),
    kind('ui-template', 'src/app/<area>/ui/<name>/<name>.component.html'),
  ]);
  assert.strictEqual(kindName(rules, 'src/index.html'), 'any-html');
  assert.strictEqual(kindName(rules, 'src/app/x.component.html'), 'template', 'a longer literal file name beats *.html');
  assert.strictEqual(kindName(rules, 'src/app/users/feature/list/list.component.html'), 'feature-template',
    'the whole path beats the file name alone');
  assert.strictEqual(kindName(rules, 'src/app/users/ui/card/card.component.html'), 'ui-template');
  assert.strictEqual(kindName(rules, 'src/app/users/ui/card/card.component.ts'), null, 'no kind, no review plan');
});

test('a file outside the folder its kind expects is still that kind - unless the kind is bound to its place', (t) => {
  const rules = rulebookOf(t, [
    kind('actions', 'src/app/<area>/data-access/+state/<name>.actions.ts'),
    kind('ts', '*.ts'),
    kind('helper', 'src/app/<area>/components-<area>/<name>.<suffix>.ts', [], { exactLocation: true }),
  ]);
  assert.strictEqual(kindName(rules, 'src/app/users/users.actions.ts'), 'actions',
    'reviewed as what it is - its misplacement is one of its own items');
  assert.strictEqual(kindName(rules, 'src/app/users/components-users/x.helpers.ts'), 'helper');
  assert.strictEqual(kindName(rules, 'src/app/users/x.helpers.ts'), 'ts',
    'a location-bound kind never takes a stray file by its name alone');
});

test('two kinds describing a path equally well are a reported tie, decided the same way every time', (t) => {
  const rules = rulebookOf(t, [kind('b-util', '<name>.util.ts'), kind('a-util', '<name>.util.ts')]);
  const match = rulebook.matchKind(rules, 'src/x.util.ts');
  assert.strictEqual(match.kind.name, 'a-util', 'by name, whatever order the files load in');
  assert.deepStrictEqual(match.tied, ['a-util', 'b-util']);
  assert.deepStrictEqual(rulebook.matchKind(rules, 'src/x.ts'), { kind: null, tied: [] });

  // Across layers a tie falls to the project's kind.
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('util', '<name>.util.ts')]);
  const project = writeLayer(tempDir(t, 'rb-project-'), [kind('house-util', '<name>.util.ts')]);
  assert.strictEqual(kindName(rulebook.loadRulebook([skill, project]), 'src/x.util.ts'), 'house-util');
});

test('a project layer replaces a kind of the same name and overrides only what it restates', (t) => {
  const naming = instruction('naming', ['skill one', 'skill two'], { gate: 'the file names things' });
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [
    kind('service', '<name>.service.ts', [naming, instruction('http', ['h1'])]),
    kind('pipe', '<name>.pipe.ts', [naming]),
  ]);
  const project = writeLayer(tempDir(t, 'rb-project-'), [
    kind('service', 'src/<name>.service.ts', [instruction('naming', { 2: 'project two' }), instruction('domain', ['d1'])]),
    kind('styles', '*.scss', [instruction('naming', { 3: 'project three' })]),
  ]);
  const rules = rulebook.loadRulebook([skill, project]);
  assert.deepStrictEqual(rules.warnings, []);
  assert.deepStrictEqual(rules.kinds.map((k) => k.name).sort(), ['pipe', 'service', 'styles']);
  const service = rules.kinds.find((k) => k.name === 'service');
  assert.strictEqual(service.layer, 1, 'the project kind replaced the skill kind');
  assert.deepStrictEqual(service.plan, [{ id: 'naming', numbers: [2] }, { id: 'domain', numbers: [1] }], 'its plan with it');
  const merged = rules.instructions.get('naming');
  assert.deepStrictEqual([...merged.items].sort((a, b) => a[0] - b[0]),
    [[1, 'skill one'], [2, 'project two'], [3, 'project three']], 'item texts are overridden per number');
  assert.strictEqual(merged.gate, 'the file names things', 'a header field the project does not restate is kept');
  assert.ok(rules.instructions.has('http'), 'an instruction only the replaced kind carried stays defined');
});

test('a project layer that does not exist, or none at all, leaves the skill rulebook alone', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('ts', '*.ts', [instruction('ts', ['rule'])])]);
  for (const project of [null, path.join(skill, 'missing')]) {
    const rules = rulebook.loadRulebook([skill, project]);
    assert.deepStrictEqual(rules.kinds.map((k) => k.name), ['ts']);
    assert.deepStrictEqual(rules.warnings, []);
  }
});

test('a project rulebook still written in Markdown is named, not silently ignored', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('ts', '*.ts', [instruction('ts', ['rule'])])]);
  fs.writeFileSync(path.join(skill, 'README.md'), '# notes\n');
  const project = tempDir(t, 'rb-project-');
  fs.mkdirSync(path.join(project, 'global'));
  fs.writeFileSync(path.join(project, 'global', 'naming.md'), '---\nname: Naming\n---\n- rule\n');
  const rules = rulebook.loadRulebook([skill, project]);
  assert.strictEqual(rules.warnings.length, 1, rules.warnings.join('\n'));
  assert.match(rules.warnings[0],
    /holds Markdown instructions \(global\/naming\.md\) - the rulebook is JSON file kinds now, so they are ignored\.$/);
  assert.deepStrictEqual(rules.kinds.map((k) => k.name), ['ts'], 'the skill layer may keep its own notes');
});

test('a defect in a kind file is reported with the file it is in, and the rest still loads', (t) => {
  const dir = tempDir(t, 'rb-');
  const good = kind('good', '*.ts', [
    {
      id: 'good',
      name: 'Good',
      selectedItems: '1-3',
      checklistSize: 1,
      items: [
        { id: 'good#1', text: 'one' },
        { id: 'other#1', text: 'not this instruction' },
        { id: 'good#2', text: 'two' },
        { id: 'good#2', text: 'two again' },
      ],
    },
    instruction('Bad Id', ['rule']),
    instruction('good', ['again'], { name: 'Good' }),
  ], { itemCount: 7 });
  writeLayer(dir, [
    kind('braced', '**/*.{ts,html}', [instruction('braced', ['rule'])]),
    good,
    kind('other', '*.js', [instruction('good', ['changed'], { name: 'Good' })]),
  ]);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'nameless.json'), JSON.stringify({ pattern: '*.x', instructions: [] }));
  fs.writeFileSync(path.join(dir, 'zz-twin.json'), JSON.stringify(kind('good', '*.y')));

  const rules = rulebook.loadRulebook([dir]);
  const expected = [
    /^braced\.json: invalid pattern "\*\*\/\*\.\{ts,html\}" \(braces are not alternatives here.*\) - kind "braced" is skipped\.$/,
    /^broken\.json: not valid JSON \(.+\) - skipped\.$/,
    /^good\.json: item "other#1" is not an `good#<n>` id with a text - skipped\.$/,
    /^good\.json: item good#2 is listed twice - the first one is kept\.$/,
    /^good\.json: "good" declares selectedItems 1-3 but lists 1-2\.$/,
    /^good\.json: "good" lists an item beyond its checklistSize 1\.$/,
    /^good\.json: instruction id "Bad Id" is not a lowercase/,
    /^good\.json: "good" appears twice in kind "good" - the first one is kept\.$/,
    /^good\.json: kind "good" declares itemCount 7 but lists 2 items\.$/,
    /^nameless\.json: no "kind" name - skipped\.$/,
    /^other\.json: good#1 differs from good\.json - the one in good\.json is kept\.$/,
    /^zz-twin\.json: kind "good" is already defined by good\.json - the first one is kept\.$/,
  ];
  assert.strictEqual(rules.warnings.length, expected.length, rules.warnings.join('\n'));
  expected.forEach((re, i) => assert.match(rules.warnings[i], re));
  assert.deepStrictEqual(rules.kinds.map((k) => k.name), ['good', 'other']);
  assert.strictEqual(rules.instructions.get('good').items.get(1), 'one', 'the first definition is the one kept');
  assert.strictEqual(rules.instructions.get('good').items.get(2), 'two');
});

test('the numbered copy lists only the walked items, each under the address it is ticked by', () => {
  const text = rulebook.renderNumbered(
    { id: 'naming', name: 'Naming', preamble: ['Applies to every name.'], items: new Map([[1, 'one'], [2, 'two'], [5, 'five']]) },
    [1, 5],
  );
  assert.strictEqual(text, [
    '# Naming (`naming`)',
    '',
    'Applies to every name.',
    '',
    'Only the items this run walks are listed; each keeps its rulebook address `naming#<n>`, so a gap in the numbers is expected.',
    '',
    '- naming#1: one',
    '- naming#5: five',
    '',
  ].join('\n'));
});

// An instruction whose items carry extras: `extras` maps an item number to its fields.
function instructionWith(id, texts, extras) {
  const base = instruction(id, texts);
  base.items = base.items.map((item, i) => ({ ...item, ...(extras[i + 1] || {}) }));
  return base;
}

test('item facts, probes and second questions are read, and a bad one warns instead of binding', (t) => {
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [instructionWith('code-quality', ['No duplicates.', 'No dead code.', 'Small.'], {
    1: { facts: ['repeated-literal', 'no-such-kind'], secondQuestion: 'Which other file holds this literal?' },
    2: { probe: [{ pattern: '^export\s', flags: 'm', message: 'eksport' }, { builtin: 'nope' }] },
    3: { secondQuestion: 7 },
  })])]);
  const extras = rules.instructions.get('code-quality').extras;
  assert.deepStrictEqual(extras.get(1), { facts: ['repeated-literal'], secondQuestion: 'Which other file holds this literal?' });
  assert.deepStrictEqual(extras.get(2), { probes: [{ pattern: '^export\s', flags: 'm', message: 'eksport' }] });
  assert.strictEqual(extras.has(3), false);
  assert.strictEqual(rules.warnings.length, 3, rules.warnings.join('\n'));
  assert.match(rules.warnings.join('\n'), /no-such-kind/);
  assert.match(rules.warnings.join('\n'), /unknown builtin probe "nope"/);
  assert.match(rules.warnings.join('\n'), /secondQuestion/);
});

test('two kinds disagreeing on an item\'s extras warn, and the first copy is kept', (t) => {
  const one = instructionWith('code-quality', ['No dead code.'], { 1: { facts: ['export-unused'] } });
  const two = instructionWith('code-quality', ['No dead code.'], { 1: { facts: ['barrel-unused'] } });
  const rules = rulebookOf(t, [kind('a', '<name>.a.ts', [one]), kind('b', '<name>.b.ts', [two])]);
  assert.deepStrictEqual(rules.instructions.get('code-quality').extras.get(1), { facts: ['export-unused'] });
  assert.match(rules.warnings.join('\n'), /code-quality#1 extras \(facts, probe, secondQuestion, severity, sameAs, unverified\) differ/);
});

test('a project item restating a skill item replaces its extras too', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('util', '<name>.util.ts', [instructionWith('code-quality', ['No dead code.'], { 1: { facts: ['export-unused'] } })])]);
  const project = writeLayer(tempDir(t, 'rb-project-'), [kind('extra', '<name>.extra.ts', [instruction('code-quality', ['Our own dead-code rule.'])])]);
  const rules = rulebook.loadRulebook([skill, project]);
  const ins = rules.instructions.get('code-quality');
  assert.strictEqual(ins.items.get(1), 'Our own dead-code rule.');
  assert.strictEqual(ins.extras.has(1), false);
});

test('renderNumbered shows an item\'s second question under it', (t) => {
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [instructionWith('guards', ['Returns a UrlTree.', 'Typed.'], { 1: { secondQuestion: 'What does the false branch return?' } })])]);
  const text = rulebook.renderNumbered(rules.instructions.get('guards'), [1, 2]);
  assert.match(text, /- guards#1: Returns a UrlTree\.\n {2}- drugie pytanie: What does the false branch return\?\n- guards#2: Typed\./);
});

test('a fixed severity is read on an instruction or an item, and the item wins', (t) => {
  const quality = instructionWith('code-quality', ['No duplicates.', 'No dead code.', 'Small.'], { 1: { severity: 'high' }, 3: { severity: 'urgent' } });
  quality.severity = 'medium';
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [quality, { ...instruction('naming', ['Named.']), severity: 'loud' }])]);
  const ins = rules.instructions.get('code-quality');
  assert.strictEqual(ins.severity, 'medium');
  assert.strictEqual(rulebook.fixedSeverity(ins, 1), 'high');
  assert.strictEqual(rulebook.fixedSeverity(ins, 2), 'medium');
  assert.strictEqual(rulebook.fixedSeverity(ins, 3), 'medium');
  assert.strictEqual(rules.instructions.get('naming').severity, null);
  assert.strictEqual(rulebook.fixedSeverity(rules.instructions.get('naming'), 1), null);
  assert.strictEqual(rules.warnings.length, 2, rules.warnings.join('\n'));
  assert.match(rules.warnings.join('\n'), /code-quality#3 "severity" "urgent"/);
  assert.match(rules.warnings.join('\n'), /"naming" declares severity "loud"/);
});

test('sameAs pairs name each other, and a one-sided, dangling or self pair warns', (t) => {
  const utils = instructionWith('utils', ['Typed.', 'Pure.', 'Small.'], { 1: { sameAs: ['best-practices#1'] }, 2: { sameAs: ['best-practices#2'] }, 3: { sameAs: ['utils#3', 'nope'] } });
  const practices = instructionWith('best-practices', ['Explicit types.', 'Short.'], { 1: { sameAs: ['utils#1'] } });
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [utils, practices, instructionWith('general', ['One.'], { 1: { sameAs: ['models#9'] } })])]);
  assert.deepStrictEqual(rules.instructions.get('utils').extras.get(1), { sameAs: ['best-practices#1'] });
  const text = rules.warnings.join('\n');
  assert.match(text, /utils#3 "sameAs" \["utils#3","nope"\] names no other item address/);
  assert.match(text, /utils#2 "sameAs" names best-practices#2, which does not name it back/);
  assert.match(text, /general#1 "sameAs" names models#9, which no kind carries/);
  assert.strictEqual(rules.warnings.length, 3, text);
});

test('a prepared unverified verdict must open with a NIEZWERYFIKOWANE reason', (t) => {
  const rules = rulebookOf(t, [kind('spec', '<name>.spec.ts', [instructionWith('unit-tests', ['Test first.', 'Green.', 'Named.'], {
    1: { unverified: 'narzędzie: kolejność powstania testu i kodu nie wynika z plików' },
    2: { unverified: 'spec is green' },
    3: { unverified: 'narzędzie:' },
  })])]);
  const extras = rules.instructions.get('unit-tests').extras;
  assert.deepStrictEqual(extras.get(1), { unverified: 'narzędzie: kolejność powstania testu i kodu nie wynika z plików' });
  assert.strictEqual(extras.has(2), false);
  assert.strictEqual(extras.has(3), false);
  assert.strictEqual(rules.warnings.length, 2, rules.warnings.join('\n'));
});
