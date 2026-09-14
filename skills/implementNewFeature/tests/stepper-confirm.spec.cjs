// Testy UI steppera implementNewFeature — dialog potwierdzenia przed wysłaniem odpowiedzi
// w krokach 1-3 (własny <dialog>, nigdy natywne window.confirm) oraz pytania poza krokiem 2.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const postState = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});
// wait=1: gdyby klik jednak coś wysłał, sekunda wystarczy by to złapać
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=1`)).json()).answer;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-confirm-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

async function openStep1(page) {
  await postState({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#task');
  await page.fill('#task', 'Opis zadania');
  await page.fill('#biz', 'Wymagania biznesowe');
  await page.fill('#branch', 'feature/test');
}

async function openQuestion(page) {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Czy lista ma paginację?', options: ['Tak', 'Nie'] } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
}

test('Next w kroku 1 otwiera własny dialog, nie natywne confirm', async ({ page }) => {
  // natywny confirm zablokowałby stronę (i rozszerzenie sterujące przeglądarką)
  let nativeDialogs = 0;
  page.on('dialog', d => { nativeDialogs++; d.dismiss(); });
  await openStep1(page);
  await page.click('#next');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  expect(nativeDialogs).toBe(0);
  expect(await takeAnswer()).toBe(null);
});

test('Cancel zamyka dialog, nic nie wysyła i zostawia formularz do edycji', async ({ page }) => {
  await openStep1(page);
  await page.click('#next');
  await page.click('#confirmCancel');
  await expect(page.locator('#confirmDialog')).toBeHidden();
  expect(await takeAnswer()).toBe(null);
  await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('#task')).toBeEditable();
});

test('Escape działa jak Cancel', async ({ page }) => {
  await openStep1(page);
  await page.click('#next');
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmDialog')).toBeHidden();
  expect(await takeAnswer()).toBe(null);
});

test('potwierdzenie wysyła odpowiedź kroku 1 i blokuje panel', async ({ page }) => {
  await openStep1(page);
  await page.click('#next');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'step1', taskDescription: 'Opis zadania' });
  await expect(page.locator('#next')).toBeDisabled();
});

test('klik w opcję kroku 2 pokazuje jej treść w dialogu i wysyła dopiero po OK', async ({ page }) => {
  await openQuestion(page);
  await page.click('[data-opt="0"]');
  await expect(page.locator('#confirmText')).toHaveText('Tak');
  await page.click('#confirmCancel');
  expect(await takeAnswer()).toBe(null);
  await page.click('[data-opt="0"]');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'answer', questionId: 'q1', value: 'Tak' });
});

test('własna odpowiedź w kroku 2 też przechodzi przez dialog', async ({ page }) => {
  await openQuestion(page);
  await page.fill('#freeAnswer', 'Tylko sortowanie');
  await page.click('#send');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'answer', value: 'Tylko sortowanie' });
});

test('Approve planu wymaga potwierdzenia', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Podsumowanie planu' } });
  await page.goto(base);
  await page.waitForSelector('#approve');
  await page.click('#approve');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'decision', decision: 'approve' });
});

test('feedback do planu idzie bez potwierdzenia — nie przesuwa pipeline dalej', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Podsumowanie planu' } });
  await page.goto(base);
  await page.waitForSelector('#sendFeedback');
  await page.fill('#feedback', 'Dodaj walidację formularza');
  await page.click('#sendFeedback');
  expect(await takeAnswer()).toMatchObject({ kind: 'decision', decision: 'feedback' });
  await expect(page.locator('#confirmDialog')).toBeHidden();
});

test('pytanie spoza kroku 2 renderuje się z nazwą swojego kroku i nie pyta o potwierdzenie',
  async ({ page }) => {
    await postState({ step: 5, status: 'in_progress', activeStep: 5,
      question: { id: 'chrome1', text: 'Włącz rozszerzenie Claude in Chrome i kliknij Gotowe',
        options: ['Gotowe'] } });
    await page.goto(base);
    await page.waitForSelector('[data-opt="0"]');
    await expect(page.locator('#panel h2')).toHaveText('Validation & E2E');
    await page.click('[data-opt="0"]');
    expect(await takeAnswer())
      .toMatchObject({ kind: 'answer', questionId: 'chrome1', value: 'Gotowe' });
  });

test('powtórzone id pytania nadal odświeża panel', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Pierwsze pytanie?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.fill('#freeAnswer', 'Tak');
  await page.click('#send');
  await page.click('#confirmOk');
  // odpowiedź nie blokuje panelu: pole jest czyste, a wysłane widać w śladzie
  await expect(page.locator('#sentTrail .msg.user')).toContainText('Tak');
  await expect(page.locator('#freeAnswer')).toHaveValue('');
  await expect(page.locator('#send')).toBeEnabled();
  // ten sam id, nowa treść — bez licznika po stronie serwera panel by się nie odświeżył
  await postState({ question: null });
  await postState({ step: 2, question: { id: 'q1', text: 'Drugie pytanie?' } });
  await expect(page.locator('#panel p').first()).toHaveText('Drugie pytanie?');
  await expect(page.locator('#sentTrail .msg')).toHaveCount(0);
});

test('do wysłanej odpowiedzi można dorzucić kolejną', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.fill('#freeAnswer', 'Trzy');
  await page.click('#send');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'answer', value: 'Trzy' });
  await page.fill('#freeAnswer', 'Właściwie cztery — dochodzi audytor');
  await page.click('#send');
  await page.click('#confirmOk');
  expect(await takeAnswer())
    .toMatchObject({ kind: 'answer', value: 'Właściwie cztery — dochodzi audytor' });
  await expect(page.locator('#sentTrail .msg.user')).toHaveCount(2);
});

test('feedback do planu też zostawia bramę czynną', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Podsumowanie planu' } });
  await page.goto(base);
  await page.waitForSelector('#sendFeedback');
  await page.fill('#feedback', 'Rozbij zadanie 2');
  await page.click('#sendFeedback');
  expect(await takeAnswer()).toMatchObject({ kind: 'decision', decision: 'feedback' });
  await expect(page.locator('#feedback')).toHaveValue('');
  await expect(page.locator('#sentTrail .msg.user')).toContainText('Rozbij zadanie 2');
  await expect(page.locator('#approve')).toBeEnabled();
});
