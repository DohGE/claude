// Testy UI steppera implementNewFeature — powrót na formularz wymagań: dzieje się
// wyłącznie w przeglądarce, nie budzi orkiestratora i nie gasi bramy, z której wyszedł.
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

const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=1`)).json()).answer;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-back-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  // Krok 1 jest domknięty, ale osiągalny — dopiero to czyni powrót możliwym.
  await state({ step: 1, status: 'completed' });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('powrót na formularz nie wysyła nic do orkiestratora', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#backToStep1');
  await page.click('#backToStep1');
  await expect(page.locator('#branch')).toBeVisible();
  // Ani dialogu, ani odpowiedzi: przełączanie kroków jest sprawą przeglądarki.
  await expect(page.locator('#confirmDialog')).toBeHidden();
  expect(await takeAnswer()).toBeNull();
});

test('brama planu czeka nietknięta i wraca kafelkiem steppera', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#backToStep1');
  await page.click('#backToStep1');
  await expect(page.locator('#branch')).toBeVisible();
  await expect(page.locator('#viewbar')).toContainText('Feature Refinement');
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#approve')).toBeVisible();
  await expect(page.locator('.summary-text')).toHaveText('Plan na trzy zadania');
  await expect(page.locator('#viewbar')).toBeHidden();
});

test('pytanie kroku 2 i brama makiet mają przycisk, pytanie kroku 5 nie', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await expect(page.locator('#backToStep1')).toBeVisible();

  await state({ step: 3, enabled: true });
  await state({ step: 3, status: 'in_progress', activeStep: 3, question: null,
    mockupReview: { rev: 1, text: 'Dwa ekrany', screens: [], chat: [] } });
  await expect(page.locator('#backToStep1')).toBeVisible();

  // Krok 5 pyta tylko o rozszerzenie Chrome — powrót jest już za punktem bez odwrotu.
  await state({ step: 5, status: 'in_progress', activeStep: 5, mockupReview: null,
    question: { id: 'q9', text: 'Włącz rozszerzenie Chrome' } });
  await expect(page.locator('#panel')).toContainText('Włącz rozszerzenie Chrome');
  await expect(page.locator('#backToStep1')).toHaveCount(0);
});

test('panele postępu i podsumowanie nie mają przycisku powrotu', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30 });
  await page.goto(base);
  await page.waitForSelector('#barFill');
  await expect(page.locator('#backToStep1')).toHaveCount(0);

  await state({ step: 6, status: 'completed', activeStep: 6,
    summary: { finalStatus: 'Gotowe', changes: [], features: [] } });
  await page.waitForSelector('.summary');
  await expect(page.locator('#backToStep1')).toHaveCount(0);
});

test('niewysłana odpowiedź na pytanie przeżywa powrót na formularz', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.fill('#freeAnswer', 'Trzy, plus audytor');
  await page.click('#backToStep1');
  await expect(page.locator('#branch')).toBeVisible();
  // Powrót przerysowuje bramę od zera — pytanie jest to samo, więc i odpowiedź zostaje.
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#freeAnswer')).toHaveValue('Trzy, plus audytor');
});

test('niewysłany feedback do planu przeżywa powrót na formularz', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#feedback');
  await page.fill('#feedback', 'Rozbij zadanie 2');
  await page.click('#backToStep1');
  await expect(page.locator('#branch')).toBeVisible();
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#feedback')).toHaveValue('Rozbij zadanie 2');
});
