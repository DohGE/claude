// Testy UI steppera implementNewFeature — przycisk kopiowania zawartości pola:
// dekorator dokłada go do każdego pola tekstowego na każdym kroku, poza hasłem.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const state = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});

const clipboard = page => page.evaluate(() => navigator.clipboard.readText());

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-copy-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('krok 1 kopiuje pola tekstowe, ale hasło nie dostaje przycisku', async ({ page }) => {
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#task');
  await page.fill('#task', 'Zaproszenia dla adminów');
  await page.click('.copy-wrap:has(#task) button.copy');
  expect(await clipboard(page)).toBe('Zaproszenia dla adminów');
  // Także pole jednoliniowe — branch.
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('.copy-wrap:has(#branch) button.copy');
  expect(await clipboard(page)).toBe('feature/zaproszenia');
  // Hasło jest wyłączone z dekoratora, login już nie.
  expect(await page.locator('.copy-wrap:has(#authPassword) button.copy').count()).toBe(0);
  expect(await page.locator('.copy-wrap:has(#authLogin) button.copy').count()).toBe(1);
});

test('odsłonięte hasło nadal nie dostaje przycisku kopiowania', async ({ page }) => {
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#togglePassword');
  await page.fill('#authPassword', 'sekret');
  await page.click('#togglePassword');
  await expect(page.locator('#authPassword')).toHaveAttribute('type', 'text');
  // Panel przerysowuje się co tick; typ pola zmienił się na text, więc dekorator
  // musiałby je złapać, gdyby nie data-no-copy.
  await page.waitForTimeout(1200);
  expect(await page.locator('.copy-wrap:has(#authPassword) button.copy').count()).toBe(0);
});

test('krok 2 też dostaje przycisk przy polu odpowiedzi', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.fill('#freeAnswer', 'Trzy role');
  await page.click('.copy-wrap:has(#freeAnswer) button.copy');
  expect(await clipboard(page)).toBe('Trzy role');
});

test('brama planu i brama makiet też mają przyciski kopiowania', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#feedback');
  await page.fill('#feedback', 'Rozbij zadanie 2');
  await page.click('.copy-wrap:has(#feedback) button.copy');
  expect(await clipboard(page)).toBe('Rozbij zadanie 2');

  await state({ step: 3, enabled: true });
  await state({ step: 3, status: 'in_progress', activeStep: 3, reviewSummary: null,
    mockupReview: { rev: 1, text: 'Dwa ekrany', screens: [], chat: [] } });
  await page.waitForSelector('#mockupFeedback');
  await page.fill('#mockupFeedback', 'Szerszy przycisk');
  await page.click('.copy-wrap:has(#mockupFeedback) button.copy');
  expect(await clipboard(page)).toBe('Szerszy przycisk');
});

test('ikona wraca do stanu wyjściowego po skopiowaniu', async ({ page }) => {
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#task');
  await page.fill('#task', 'Opis');
  const btn = page.locator('.copy-wrap:has(#task) button.copy');
  await btn.click();
  await expect(btn.locator('rect')).toHaveCount(0);   // ptaszek, nie schowek
  await expect(btn.locator('rect')).toHaveCount(1, { timeout: 4000 });
});
