'use strict';

const test = require('node:test');
const assert = require('node:assert');
const scope = require('./review-scope.cjs');

// A workspace of two applications and a library: `apps/web` imports the library through its
// alias, `apps/admin` does not; `projects/stories` is listed nowhere but sits next to projects.
const files = {
  'angular.json': JSON.stringify({ projects: { web: { root: 'apps/web/' }, admin: { root: 'apps/admin' } } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['libs/ui/src/*'], '@web-shared/*': ['apps/web/src/shared/*'] } } }),
  'package.json': '{}',
  'apps/web/src/app/page.ts': "import { Button } from '@lib/button';\nimport { util } from '../shared/util';\nexport const page = 1;\n",
  'apps/web/src/shared/util.ts': 'export const util = 1;\n',
  'apps/admin/src/app/admin.ts': 'export const admin = 1;\n',
  'libs/ui/package.json': '{}',
  'libs/ui/src/button.ts': 'export class Button {}\n',
  'projects/dpx/tsconfig.app.json': '{}',
  'projects/stories/src/page.stories.ts': "import { util } from '@web-shared/util';\n",
};
const paths = new Set(Object.keys(files));
const readText = (p) => (p in files ? files[p] : null);
// A git grep over every file: the needles found per file.
const importersOf = (needles) => new Map(needles.map((needle) => [needle, Object.keys(files).filter((p) => files[p].includes(needle))]));
const reviewed = (...ps) => new Map(ps.map((p) => [p, files[p]]));

test('projectRoots: marker folders, the workspace file\'s roots, deepest first', () => {
  assert.deepStrictEqual(scope.projectRoots(paths, readText), ['projects/dpx', 'apps/admin', 'apps/web', 'libs/ui']);
  assert.deepStrictEqual(scope.projectRoots(new Set(['package.json', 'src/a.ts'])), [], 'a single-project repository has none below its root');
});

test('rootOf: a folder next to projects is a project of its own', () => {
  const roots = scope.projectRoots(paths, readText);
  assert.strictEqual(scope.rootOf(roots, 'apps/web/src/app/page.ts'), 'apps/web');
  assert.strictEqual(scope.rootOf(roots, 'projects/stories/src/page.stories.ts'), 'projects/stories');
  assert.strictEqual(scope.rootOf(roots, 'tools/build.js'), null);
});

test('reviewScope: the reviewed projects and the ones their imports reach', () => {
  const found = scope.reviewScope({ paths, reviewed: reviewed('apps/web/src/app/page.ts'), readText, importersOf });
  assert.deepStrictEqual(found.roots, ['apps/web', 'libs/ui'], 'the alias leads into the library, the relative import stays home');
  assert.ok(found.has('libs/ui/src/button.ts') && !found.has('apps/admin/src/app/admin.ts'));
  assert.deepStrictEqual([...found.open], [], 'no alias exposes the page');
});

test('reviewScope: a file another project imports through an alias from outside is open', () => {
  const found = scope.reviewScope({ paths, reviewed: reviewed('apps/web/src/shared/util.ts'), readText, importersOf });
  assert.deepStrictEqual(found.roots, ['apps/web']);
  assert.deepStrictEqual([...found.open], ['apps/web/src/shared/util.ts'], 'the stories import it through @web-shared/');
  const unknown = scope.reviewScope({ paths, reviewed: reviewed('apps/web/src/shared/util.ts'), readText, importersOf: () => null });
  assert.deepStrictEqual([...unknown.open], ['apps/web/src/shared/util.ts'], 'a search that did not run leaves its importers unknown');
});

test('reviewScope: the whole repository when it cannot be narrowed safely', () => {
  assert.strictEqual(scope.reviewScope({ paths: new Set(['src/a.ts']), reviewed: new Map([['src/a.ts', '']]) }), null, 'no projects');
  const script = new Set([...paths, 'tools/build.js']);
  assert.strictEqual(scope.reviewScope({ paths: script, reviewed: new Map([['tools/build.js', '']]), readText, importersOf }), null, 'a script outside every project');
  const config = scope.reviewScope({ paths, reviewed: new Map([['package.json', '{}'], ['apps/admin/src/app/admin.ts', files['apps/admin/src/app/admin.ts']]]), readText, importersOf });
  assert.deepStrictEqual(config.roots, ['apps/admin'], 'a workspace file outside every project does not widen it');
});
