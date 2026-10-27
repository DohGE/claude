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
  await page.fill('#branch', 'feature/test');
  await page.fill('#commitMessage', 'feat: test');
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const submit = async page => { await page.click('#next'); await page.click('#confirmOk'); };
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=10`)).json()).answer;

test('sekcja materiałów leży między opisem zadania a makietami', async ({ page }) => {
  const y = async sel => (await page.locator(sel).boundingBox()).y;
  expect(await y('#task')).toBeLessThan(await y('#hints'));
  expect(await y('#hints')).toBeLessThan(await y('#mockups'));
});

test('opis pojawia się dopiero po wgraniu pliku i znika po jego usunięciu', async ({ page }) => {
  await expect(page.locator('#hintsNote')).toBeHidden();
  await page.setInputFiles('#hints', [file('inspiracja.png')]);
  await expect(page.locator('#hintsNote')).toBeVisible();
  await page.click('#picked-hints .rm');
  await expect(page.locator('#hintsNote')).toBeHidden();
});

test('kolejny wybór dokłada pliki, ta sama nazwa podmienia, a × usuwa', async ({ page }) => {
  await page.setInputFiles('#hints', [file('ekran-a.png')]);
  await page.setInputFiles('#hints', [file('ekran-b.png'), file('ekran-a.png')]);
  // Jedna pozycja na nazwę, każdy obrazek z podglądem.
  await expect(page.locator('#picked-hints li')).toHaveCount(2);
  await expect(page.locator('#picked-hints img')).toHaveCount(2);
  await expect.poll(() => page.locator('#picked-hints img').first()
    .evaluate(img => img.naturalWidth)).toBe(1);
  await page.click('#picked-hints .rm[aria-label="Remove ekran-b.png"]');
  await expect(page.locator('#picked-hints li')).toHaveCount(1);
  await submit(page);
  expect((await takeAnswer()).hints).toEqual(['ekran-a.png']);
  expect(fs.readdirSync(path.join(dir, 'tasks', 't1', 'hints'))).toEqual(['ekran-a.png']);
});

test('wgrany obrazek ma podgląd serwowany przez stepper', async ({ page }) => {
  await page.setInputFiles('#hints', [file('ekran-a.png')]);
  await submit(page);
  await takeAnswer();
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#files-hints img')).toHaveCount(1);
  await expect.poll(() => page.locator('#files-hints img')
    .evaluate(img => img.naturalWidth)).toBe(1);
  await expect(page.locator('#picked-hints li')).toHaveCount(0);
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
