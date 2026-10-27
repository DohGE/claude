'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ps = require('./project-styles.cjs');

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  });
  return dir;
}

function writeFile(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// An Angular workspace of two apps, a Storybook rendered with the first one's build, its themes
// by class name, and one stories file.
function workspace(t) {
  const project = tempDir(t, 'ps-proj-');
  writeFile(project, 'angular.json', JSON.stringify({
    projects: {
      web: {
        projectType: 'application',
        architect: {
          build: { options: { styles: ['projects/web/src/styles.scss', './node_modules/toast/toast.css'] } },
          'build-storybook': { builder: '@storybook/angular:build-storybook', options: { configDir: 'projects/sb/.storybook', browserTarget: 'web:build', outputDir: 'dist/storybook' } },
          storybook: { builder: '@storybook/angular:start-storybook', options: { configDir: 'projects/sb/.storybook', browserTarget: 'web:build', port: 6006 } },
        },
      },
      admin: { projectType: 'application', architect: { build: { options: { styles: ['projects/admin/src/styles.scss'] } } } },
    },
  }));
  writeFile(project, 'package.json', JSON.stringify({ scripts: { storybook: 'ng run web:storybook' } }));
  writeFile(project, 'projects/web/src/styles.scss', '$brand: #123456; .btn { color: $brand; }\n');
  writeFile(project, 'projects/admin/src/styles.scss', '.admin { color: red; }\n');
  writeFile(project, 'node_modules/toast/toast.css', '.toast { opacity: 1; }\n');
  writeFile(project, 'projects/sb/.storybook/main.ts', 'export default { stories: ["../src/**/*.stories.ts"] };\n');
  writeFile(project, 'projects/sb/.storybook/preview.ts', "decorators: [withThemeByClassName({ themes: { light: '', dark: 'dark-mode' }, defaultTheme: 'light' })]\n");
  writeFile(project, 'projects/sb/src/button.stories.ts', "const meta = { title: 'Components/Buttons/Button' };\nexport default meta;\nexport const Primary = {};\nexport const DisabledState: Story = {};\n");
  writeFile(project, 'projects/web/src/app/theme/_tokens.scss', '$space: 8px;\n');
  const files = ['angular.json', 'package.json', 'projects/web/src/styles.scss', 'projects/admin/src/styles.scss',
    'projects/sb/.storybook/main.ts', 'projects/sb/.storybook/preview.ts', 'projects/sb/src/button.stories.ts', 'projects/web/src/app/theme/_tokens.scss'];
  return { project, files };
}

const fakeCompile = (file) => `/* compiled */ .from-${path.basename(file, '.scss')} { color: blue; }`;

test('the app the Storybook renders with is compiled into one stylesheet next to the mockups', (t) => {
  const { project, files } = workspace(t);
  const out = tempDir(t, 'ps-out-');
  const result = ps.projectStyles({ project, out, files, compile: fakeCompile });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.app, 'web', 'the Storybook\'s browserTarget');
  assert.strictEqual(result.css, 'project-web.css', 'a bare name: the preview serves the folder flat');
  const css = fs.readFileSync(path.join(out, result.css), 'utf8');
  assert.ok(css.includes('.from-styles') && css.includes('.toast { opacity: 1; }'), 'every global style of the app, in order');
  assert.ok(css.indexOf('.from-styles') < css.indexOf('.toast'));
  assert.deepStrictEqual(result.apps, ['web', 'admin']);
  assert.deepStrictEqual(result.tokens, ['projects/web/src/app/theme/_tokens.scss']);
});

test('the Storybook is found with its stories, theme classes and a build that writes nothing into the project', (t) => {
  const { project, files } = workspace(t);
  const out = tempDir(t, 'ps-out-');
  const { storybook } = ps.projectStyles({ project, out, files, compile: fakeCompile });
  assert.deepStrictEqual(storybook.configDirs, ['projects/sb/.storybook']);
  assert.strictEqual(storybook.stories, 1);
  assert.strictEqual(storybook.static, null, 'not built yet');
  assert.deepStrictEqual(storybook.themes, { light: '', dark: 'dark-mode' });
  const index = JSON.parse(fs.readFileSync(path.join(out, storybook.index), 'utf8'));
  assert.deepStrictEqual(index, [{ file: 'projects/sb/src/button.stories.ts', title: 'Components/Buttons/Button', ids: ['components-buttons-button--primary', 'components-buttons-button--disabled-state'] }]);
  const target = path.join(path.dirname(out), 'storybook-static');
  assert.strictEqual(storybook.buildDir, target);
  assert.strictEqual(storybook.build, `npx ng run web:build-storybook --output-dir="${target}" --compodoc=false`);
});

test('a built Storybook is taken where it is, and --app picks another app', (t) => {
  const { project, files } = workspace(t);
  writeFile(project, 'dist/storybook/iframe.html', '<html></html>');
  const out = tempDir(t, 'ps-out-');
  const result = ps.projectStyles({ project, out, files, compile: fakeCompile, app: 'admin' });
  assert.strictEqual(result.storybook.static, path.join(project, 'dist', 'storybook'));
  assert.strictEqual(result.css, 'project-admin.css');
  assert.ok(fs.readFileSync(path.join(out, 'project-admin.css'), 'utf8').includes('.from-styles'));
  assert.deepStrictEqual(ps.projectStyles({ project, out, files, compile: fakeCompile, app: 'nope' }).errors, ['No app "nope" with global styles - the apps are: web, admin.']);
});

test('a stylesheet that does not compile is a warning, and the others still make the file', (t) => {
  const { project, files } = workspace(t);
  const out = tempDir(t, 'ps-out-');
  const result = ps.projectStyles({ project, out, files, compile: () => { throw new Error('Undefined variable.\n  at line 1'); } });
  assert.strictEqual(result.css, 'project-web.css');
  assert.deepStrictEqual(result.warnings, ['projects/web/src/styles.scss did not compile: Undefined variable.']);
  assert.ok(fs.readFileSync(path.join(out, result.css), 'utf8').includes('.toast'));
});

test('a project with no global stylesheet and no Storybook says so and writes nothing', (t) => {
  const project = tempDir(t, 'ps-plain-');
  writeFile(project, 'package.json', '{}');
  const out = tempDir(t, 'ps-out-');
  const result = ps.projectStyles({ project, out, files: ['package.json'], compile: fakeCompile });
  assert.deepStrictEqual([result.app, result.css, result.storybook], [null, null, null]);
  assert.match(result.warnings.join(' '), /No global stylesheet/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test('a story id is Storybook\'s own: the title and the export name, lower case and hyphenated', () => {
  assert.strictEqual(ps.storyId('Components/Inputs/Input Reactive', 'WithError'), 'components-inputs-input-reactive--with-error');
  assert.strictEqual(ps.storyId('Patterns/Tables', 'HTMLTable'), 'patterns-tables--html-table');
});
