// Testy UI steppera implementNewFeature — opcjonalna sekcja "Additional materials" w kroku 1:
// pliki + opis, który pojawia się dopiero po wgraniu pliku i trafia do odpowiedzi kroku 1.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

// 1x1 px PNG — wystarczy, by input miał plik
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const file = name => ({ name, mimeType: 'image/png', buffer: PNG });

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-hints-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', step: 1, status: 'in_progress', activeStep: 1 })
  });
  await page.goto(base);
  await page.waitForSelector('#hints');
  await page.fill('#task', 'Opis zadania');
  await page.fill('#biz', 'Wymagania biznesowe');
  await page.fill('#branch', 'feature/test');
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const submit = async page => { await page.click('#next'); await page.click('#confirmOk'); };
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=10`)).json()).answer;

test('sekcja materiałów leży między wymaganiami biznesowymi a makietami', async ({ page }) => {
  const y = async sel => (await page.locator(sel).boundingBox()).y;
  expect(await y('#biz')).toBeLessThan(await y('#hints'));
  expect(await y('#hints')).toBeLessThan(await y('#mockups'));
});

test('opis pojawia się dopiero po wgraniu pliku i znika po jego usunięciu', async ({ page }) => {
  await expect(page.locator('#hintsNote')).toBeHidden();
  await page.setInputFiles('#hints', [file('inspiracja.png')]);
  await expect(page.locator('#hintsNote')).toBeVisible();
  await page.setInputFiles('#hints', []);
  await expect(page.locator('#hintsNote')).toBeHidden();
});

test('pliki i opis trafiają do odpowiedzi kroku 1 oraz na dysk', async ({ page }) => {
  await page.setInputFiles('#hints', [file('ekran-a.png'), file('ekran-b.png')]);
  await page.fill('#hintsNote', 'Skopiuj układ kart z ekranu A, kolory zignoruj');
  await submit(page);
  expect(await takeAnswer()).toMatchObject({
    kind: 'step1',
    hints: ['ekran-a.png', 'ekran-b.png'],
    hintsNote: 'Skopiuj układ kart z ekranu A, kolory zignoruj'
  });
  expect(fs.readdirSync(path.join(dir, 'tasks', 't1', 'hints')).sort()).toEqual(['ekran-a.png', 'ekran-b.png']);
});

test('sekcja jest opcjonalna — bez plików odpowiedź niesie puste wartości', async ({ page }) => {
  await submit(page);
  expect(await takeAnswer()).toMatchObject({ kind: 'step1', hints: [], hintsNote: '' });
  expect(fs.existsSync(path.join(dir, 'tasks', 't1', 'hints'))).toBe(false);
});
