// Testy UI steppera implementNewFeature — powrót na krok 1 z trzech bram interaktywnych,
// i jego brak tam, gdzie agent pracuje albo implementacja już ruszyła.
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

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-back-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('brama planu wysyła decyzję powrotu po potwierdzeniu', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#backToStep1');
  await page.click('#backToStep1');
  await expect(page.locator('#confirmTitle')).toHaveText('Back to requirements?');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer).toMatchObject({ kind: 'back', taskId: 't1' });
});

test('Cancel w dialogu powrotu nic nie wysyła', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#backToStep1');
  await page.click('#backToStep1');
  await page.click('#confirmCancel');
  const { answer } = await (await fetch(`${base}/api/answer?wait=1`)).json();
  expect(answer).toBeNull();
  await expect(page.locator('#backToStep1')).toBeEnabled();
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

test('powrót blokuje panel do czasu reakcji orkiestratora', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#backToStep1');
  await page.click('#backToStep1');
  await page.click('#confirmOk');
  await expect(page.locator('#panel .notice')).toContainText('Going back to the requirements form');
  await expect(page.locator('#approve')).toBeDisabled();
  // Dopiero stan wystawiony przez orkiestratora wraca na formularz.
  await state({ step: 2, status: 'waiting' });
  await state({ step: 1, status: 'in_progress', activeStep: 1, reviewSummary: null });
  await expect(page.locator('#branch')).toBeVisible();
});
