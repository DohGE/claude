'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mechanical = require('./mechanical.cjs');

const renamed = (oldPath, path) => ({ status: 'R', oldPath, path });

test('the renames of a target teach which words it replaced', () => {
  const map = mechanical.substitutionMap([
    renamed('src/minio-volume/minio-volume.component.ts', 'src/s3-volume/s3-volume.component.ts'),
    renamed('src/edit-minio-settings/models/index.ts', 'src/edit-s3-settings/models/index.ts'),
    renamed('src/a/old.ts', 'src/b/c/new.ts'),
    { status: 'M', path: 'src/x.ts' },
  ]);
  assert.deepStrictEqual(map, { minio: 's3' }, 'a moved file with another depth teaches nothing');
  assert.deepStrictEqual(mechanical.substitutionMap([renamed('src/v1/a.ts', 'src/v2/a.ts')]), {}, 'a word too short to replace safely');
  assert.deepStrictEqual(mechanical.substitutionMap([renamed('src/old-x.ts', 'src/new-x.ts'), renamed('src/old-y.ts', 'src/other-y.ts')]), {}, 'a word replaced two ways is no rule');
});

test('a replaced word keeps the casing of every spot it replaces', () => {
  const map = { minio: 's3' };
  assert.strictEqual(mechanical.applyMap("toggleMinIOServer(): 'minio' | MINIO_PORT | Minio", map), "toggleS3Server(): 's3' | S3_PORT | S3");
});

test('a diff is mechanical when it renames, moves imports, reformats or replaces the learned words - and only then', () => {
  const map = { minio: 's3' };
  const classify = (status, removed, added, words = map) => mechanical.classify({ status, removed, added }, words);
  assert.strictEqual(classify('R', [], []), 'rename');
  assert.strictEqual(classify('M', ['export class MinioService {', '  toggleMinIOServer() {}'], ['export class S3Service {', '  toggleS3Server() {}']), 'substitution');
  assert.strictEqual(classify('M', ["import { A } from './a';"], ["import { A } from '../shared/a';", "import { B } from './b';"]), 'imports');
  assert.strictEqual(classify('M', ['  const a = 1;'], ['const a  =  1;', '']), 'format');
  assert.strictEqual(classify('M', ['if (a > 1) {'], ['if (a >= 1) {']), null, 'a changed condition is behaviour');
  assert.strictEqual(classify('M', ['export class MinioService {'], ['export class S3Service {', '  extra = 1;']), null, 'a line more is behaviour');
  assert.strictEqual(classify('M', ['run(a);', 'run(b);'], ['run(b);', 'run(a);']), null, 'an order of statements is behaviour');
  assert.strictEqual(classify('M', ['class Minio {}'], ['class S3 {}'], {}), null, 'nothing learned, nothing replaced');
  assert.strictEqual(classify('A', [], ['x']), null);
  assert.strictEqual(classify('D', ['x'], []), null);
});

test('the lines of a patch: only what its hunks remove and add', () => {
  const patch = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '--- a removed comment',
    '+new',
    '\\ No newline at end of file',
  ].join('\n');
  assert.deepStrictEqual(mechanical.diffLines(patch), { removed: ['old', '-- a removed comment'], added: ['new'] });
});

test('the old words still in the reviewed revision are listed with their place', () => {
  const texts = new Map([['src/a.ts', "const a = 'x';\nconst b = goToMinIO();\n"], ['src/b.ts', 'nothing here\n']]);
  assert.deepStrictEqual(mechanical.leftovers({ minio: 's3' }, texts), { total: 1, hits: [{ path: 'src/a.ts', line: 2, text: 'const b = goToMinIO();' }] });
  assert.deepStrictEqual(mechanical.leftovers({}, texts), { total: 0, hits: [] });
});
