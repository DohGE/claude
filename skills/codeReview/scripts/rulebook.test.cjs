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

test('item facts, probes, second questions and answers are read, and a bad one warns instead of binding', (t) => {
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [instructionWith('code-quality', ['No duplicates.', 'No dead code.', 'Small.'], {
    1: { facts: ['repeated-literal', 'no-such-kind'], secondQuestion: 'Which other file holds this literal?', answer: 'repo-search' },
    2: { probe: [{ pattern: '^export\s', flags: 'm', message: 'eksport' }, { builtin: 'nope' }] },
    3: { secondQuestion: 7, answer: 'nope' },
  })])]);
  const extras = rules.instructions.get('code-quality').extras;
  assert.deepStrictEqual(extras.get(1), { facts: ['repeated-literal'], secondQuestion: 'Which other file holds this literal?', answer: 'repo-search' });
  assert.deepStrictEqual(extras.get(2), { probes: [{ pattern: '^export\s', flags: 'm', message: 'eksport' }] });
  assert.strictEqual(extras.has(3), false);
  assert.strictEqual(rules.warnings.length, 4, rules.warnings.join('\n'));
  assert.match(rules.warnings.join('\n'), /no-such-kind/);
  assert.match(rules.warnings.join('\n'), /code-quality#3 "answer" "nope" is not one of repo-search, input-binding, area-layout - ignored/);
  assert.match(rules.warnings.join('\n'), /unknown builtin probe "nope"/);
  assert.match(rules.warnings.join('\n'), /secondQuestion/);
});

test('two kinds disagreeing on an item\'s extras warn, and the first copy is kept', (t) => {
  const one = instructionWith('code-quality', ['No dead code.'], { 1: { facts: ['export-unused'] } });
  const two = instructionWith('code-quality', ['No dead code.'], { 1: { facts: ['barrel-unused'] } });
  const rules = rulebookOf(t, [kind('a', '<name>.a.ts', [one]), kind('b', '<name>.b.ts', [two])]);
  assert.deepStrictEqual(rules.instructions.get('code-quality').extras.get(1), { facts: ['export-unused'] });
  assert.match(rules.warnings.join('\n'), /code-quality#1 extras \(facts, probe, secondQuestion, answer, severity, sameAs, unverified, noSpec\) differ/);
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

test('lightRulebook leaves every item of severity low out of the plans', (t) => {
  const quality = instructionWith('code-quality', ['No duplicates.', 'No dead code.', 'Small.'], { 1: { severity: 'low' }, 3: { severity: 'high' } });
  const naming = { ...instruction('naming', ['Named.', 'Cased.']), severity: 'low' };
  naming.items[1].severity = 'medium';
  const style = { ...instruction('style', ['Spaced.']), severity: 'low' };
  const plain = kind('plain', '<name>.plain.ts', [instruction('general', ['One.'])]);
  const rules = rulebookOf(t, [kind('util', '<name>.util.ts', [quality, naming, style]), plain]);
  const { rules: light, dropped } = rulebook.lightRulebook(rules);
  const util = light.kinds.find((k) => k.name === 'util');
  assert.deepStrictEqual(util.plan, [{ id: 'code-quality', numbers: [2, 3] }, { id: 'naming', numbers: [2] }],
    'an item\'s own severity beats its instruction\'s, and a step left empty goes');
  assert.strictEqual(util.itemCount, 3);
  assert.deepStrictEqual(dropped, ['code-quality#1', 'naming#1', 'style#1']);
  assert.strictEqual(light.kinds.find((k) => k.name === 'plain'), rules.kinds.find((k) => k.name === 'plain'), 'a kind losing nothing is the same object');
  assert.strictEqual(rules.kinds.find((k) => k.name === 'util').itemCount, 6, 'the loaded rulebook is left as it was');
  assert.strictEqual(light.instructions, rules.instructions);
  assert.strictEqual(rulebook.matchKind(light, 'src/a.util.ts').kind, util);
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

// A project's Markdown rule, as `.claude/doh/local/*.md` carries it.
const localRule = (front, body = '') => `---\n${front}\n---\nPreamble line.\n\n## Checklist\n\n### Labels\n\n- one\n- two\n\n## Screenshots\n\n- not an item\n${body}`;

test('a local Markdown rule: front matter, numbered items under the checklist sections, the rest preamble', () => {
  const parsed = rulebook.parseLocalMarkdown(localRule('name: UI wording\nid: ui-wording\naliases:\n  - ui-wordnig\napplies-to:\n  - "**/*.component.ts"\napplies-when: user-text'), 'file-name');
  assert.strictEqual(parsed.entry.id, 'ui-wording');
  assert.strictEqual(parsed.entry.name, 'UI wording');
  assert.deepStrictEqual(parsed.entry.items, [{ id: 'ui-wording#1', text: '[Labels] one' }, { id: 'ui-wording#2', text: '[Labels] two' }]);
  assert.deepStrictEqual(parsed.entry.appliesTo, ['**/*.component.ts']);
  assert.deepStrictEqual(parsed.entry.appliesWhen, ['user-text']);
  assert.deepStrictEqual(parsed.aliases, ['ui-wordnig']);
  assert.deepStrictEqual(parsed.entry.preamble, ['Preamble line.']);
  assert.strictEqual(rulebook.parseLocalMarkdown('no front matter', 'x'), null);
  assert.strictEqual(rulebook.parseLocalMarkdown(localRule('name: n'), 'file-name').entry.id, 'file-name', 'the file name without an id');
});

test('local rules join every kind, scoped per file by appliesTo and appliesWhen', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [
    kind('component', '<name>.component.ts', [instruction('general', ['a', 'b'])]),
    kind('reducer', '<name>.reducer.ts', [instruction('general', ['a', 'b'])]),
  ]);
  const local = tempDir(t, 'rb-local-');
  fs.writeFileSync(path.join(local, 'ui-wording.md'), localRule('name: UI wording\napplies-to:\n  - "**/*.component.ts"\napplies-when: user-text'));
  const rules = rulebook.loadRulebook([skill], { localDir: local });
  assert.deepStrictEqual(rules.warnings, []);
  const component = rulebook.matchKind(rules, 'src/app/x.component.ts').kind;
  assert.deepStrictEqual(component.plan.map((step) => step.id), ['general', 'ui-wording']);
  assert.strictEqual(component.itemCount, 4);
  const plan = (p, text) => rulebook.planOf(rulebook.matchKind(rules, p).kind, p, text, rules.instructions);
  assert.strictEqual(plan('src/app/x.component.ts', "label: 'labels.save'"), component, 'a file the rule applies to walks the kind as it is');
  const quiet = plan('src/app/x.component.ts', 'const n = 1;');
  assert.deepStrictEqual([quiet.itemCount, quiet.skipped], [2, ['ui-wording']], 'no text a user reads: the rule drops out');
  assert.deepStrictEqual(plan('src/app/x.reducer.ts', "label: 'labels.save'").skipped, ['ui-wording'], 'outside applies-to: the rule drops out');
  assert.deepStrictEqual(plan('src/app/x.component.ts', null).skipped, ['ui-wording'], 'a file with nothing to read');
});

test('an alias reads a kind that still names the old id as the rule itself', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('component', '<name>.component.ts', [instruction('general', ['a'])])]);
  // A copy generated before the rename: the old id, with the rule's items.
  const project = writeLayer(tempDir(t, 'rb-project-'), [
    kind('component', '<name>.component.ts', [instruction('general', ['a']), instruction('ui-wordnig', ['[Labels] one', '[Labels] two'])]),
  ]);
  const local = tempDir(t, 'rb-local-');
  fs.writeFileSync(path.join(local, 'ui-wording.md'), localRule('name: UI wording\nid: ui-wording\naliases: [ui-wordnig]\napplies-to:\n  - "**/shared/**/*.ts"'));
  const rules = rulebook.loadRulebook([skill, project], { localDir: local });
  const component = rulebook.matchKind(rules, 'src/app/x.component.ts').kind;
  assert.deepStrictEqual(component.plan.map((step) => step.id), ['general', 'ui-wording'], 'one step, under the new id');
  assert.ok(!rules.instructions.has('ui-wordnig'));
  assert.deepStrictEqual(rules.instructions.get('ui-wording').scope.appliesTo, ['**/shared/**/*.ts'], 'and the rule\'s scope binds the copied step too');
  assert.deepStrictEqual(rulebook.planOf(component, 'src/app/x.component.ts', 'x', rules.instructions).skipped, ['ui-wording']);
});

test('a local rule fixes its severity, the severity of single items and its same-defect links in its front matter', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('component', '<name>.component.ts', [instruction('general', ['a', 'b'])])]);
  const local = tempDir(t, 'rb-local-');
  fs.writeFileSync(path.join(local, 'ui-wording.md'), localRule('name: UI wording\nid: ui-wording\nseverity: low\nitem-severity:\n  - 2: medium\nsame-as:\n  - 1: general#2'));
  const rules = rulebook.loadRulebook([skill], { localDir: local });
  assert.deepStrictEqual(rules.warnings, []);
  const rule = rules.instructions.get('ui-wording');
  assert.strictEqual(rulebook.fixedSeverity(rule, 1), 'low', 'the rule\'s own severity');
  assert.strictEqual(rulebook.fixedSeverity(rule, 2), 'medium', 'an item\'s severity outranks the rule\'s');
  assert.deepStrictEqual(rule.extras.get(1).sameAs, ['general#2']);
  assert.deepStrictEqual(rules.instructions.get('general').extras.get(2).sameAs, ['ui-wording#1'], 'the skill\'s item names the local one back');
  assert.deepStrictEqual(rulebook.lightRulebook(rules).dropped, ['ui-wording#1'], '--light leaves out the low items of a local rule');
});

test('a local rule\'s item severity or link that names no item of it, or no level, is a warning', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('component', '<name>.component.ts', [instruction('general', ['a'])])]);
  const local = tempDir(t, 'rb-local-');
  fs.writeFileSync(path.join(local, 'ui-wording.md'), localRule('name: UI wording\nid: ui-wording\nitem-severity:\n  - 9: medium\n  - 1: urgent\nsame-as:\n  - 2 general#1'));
  const rules = rulebook.loadRulebook([skill], { localDir: local });
  assert.strictEqual(rules.warnings.length, 3, rules.warnings.join('\n'));
  assert.ok(rules.warnings.every((w) => w.startsWith('local/ui-wording.md:')), rules.warnings.join('\n'));
  assert.strictEqual(rulebook.fixedSeverity(rules.instructions.get('ui-wording'), 1), null);
});

test('the user-text gate: translations, templates, translation keys, label literals', () => {
  const gate = rulebook.contentGates['user-text'];
  assert.ok(gate('src/assets/i18n/en.json', '{}'));
  assert.ok(gate('a.component.html', '<button>{{ "labels.save" | translate }}</button>'));
  assert.ok(gate('a.component.html', '<span>Zapisz</span>'));
  assert.ok(!gate('a.component.html', '<div class="x"><span>{{ value }}</span></div>'));
  assert.ok(gate('a.const.ts', "export const labels = { [S.on]: 'labels.online' };"));
  assert.ok(gate('a.ts', "this.notify({ message: 'Saved' });"));
  assert.ok(!gate('a.enum.ts', "export enum S { online = 'online' }"));
  assert.ok(!gate('a.ts', "import { x } from './models/x.const';\nconst f = 'data.json';"));
});

test('a kind\'s walker setting is validated, and a project kind replacing it keeps it unless it states its own', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [
    kind('enum', '<name>.enum.ts', [instruction('models', ['a'])], { walker: { model: 'sonnet', effort: 'medium' } }),
    kind('pipe', '<name>.pipe.ts', [instruction('models', ['a'])], { walker: { effort: 'huge' } }),
  ]);
  const project = writeLayer(tempDir(t, 'rb-project-'), [kind('enum', '<name>.enum.ts', [instruction('models', ['a'])])]);
  const rules = rulebook.loadRulebook([skill, project]);
  assert.deepStrictEqual(rulebook.matchKind(rules, 'a.enum.ts').kind.walker, { model: 'sonnet', effort: 'medium' });
  assert.strictEqual(rulebook.matchKind(rules, 'a.pipe.ts').kind.walker, null);
  assert.ok(rules.warnings.some((w) => w.includes('"walker"')), rules.warnings.join('\n'));
});

test('a project kind copied from an older version is named as such', (t) => {
  const skill = writeLayer(tempDir(t, 'rb-skill-'), [kind('enum', '<name>.enum.ts', [instruction('models', ['a'])])]);
  const old = instruction('models', ['a']);
  old.items[0].facts = ['i18n-invalid-json'];
  const project = writeLayer(tempDir(t, 'rb-project-'), [kind('enum', '<name>.enum.ts', [old])]);
  const rules = rulebook.loadRulebook([skill, project]);
  assert.ok(rules.warnings.some((w) => w.includes('looks like a copy of an older version\'s kind')), rules.warnings.join('\n'));
});
