// Testy UI steppera implementNewFeature — przycisk Stop: przerywa tylko to, co agent kroku
// właśnie robi. Panel kroku zostaje taki, jaki był, z notką, że agent stoi, a to, co
// użytkownik wyśle na tym kroku jako następne, mówi agentowi, jak ma iść dalej.
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
const takeAnswer = async (wait = 10) =>
  (await (await fetch(`${base}/api/answer?wait=${wait}`)).json()).answer;
const taskNow = async () => (await (await fetch(`${base}/api/state`)).json()).tasks[0];
const stepNow = async id => (await taskNow()).steps.find(s => s.id === id);

// Stop z potwierdzeniem, a potem notka w miejscu przycisku.
async function stop(page) {
  await page.click('#stopStep');
  await expect(page.locator('#confirmTitle')).toHaveText('Stop the agent?');
  await page.click('#confirmOk');
  await expect(page.locator('#stoppedNote')).toBeVisible();
  await expect(page.locator('#stopStep')).toBeHidden();
}

// Znacznik na nagłówku panelu przeżywa tylko wtedy, gdy panel nie został przerysowany.
const markPanel = page => page.evaluate(() => { document.querySelector('#panel h2').dataset.mark = '1'; });
const panelKept = page => expect(page.locator('#panel h2[data-mark="1"]')).toHaveCount(1);

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-stop-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'completed' });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('Stop przerywa agenta, a panel kroku zostaje taki, jaki był', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30,
    currentOperation: 'Piszę testy' });
  await page.goto(base);
  await page.waitForSelector('#stopStep');
  await expect(page.locator('#stoppedNote')).toBeHidden();
  await markPanel(page);
  await stop(page);
  await panelKept(page);
  await expect(page.locator('#panel h2')).toHaveText('Implementation');
  await expect(page.locator('#op')).toHaveText('30% — Piszę testy');
  await expect(page.locator('#barFill')).toHaveCSS('width', /px$/);
  await expect(page.locator('#stepMessage')).toBeVisible();
  await expect(page.locator('#retry')).toHaveCount(0);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 4, taskId: 't1' });
  const step = await stepNow(4);
  expect(step.status).toBe('in_progress');
  expect(step.stopped).toBeTruthy();
  // Zatrzymany agent czeka na użytkownika, więc zakładka taska pokazuje znacznik oczekiwania.
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab[data-task=t1] .pending')).toBeVisible();
});

test('wiadomość po Stopie wznawia agenta: notka znika, Stop wraca', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4 });
  await page.goto(base);
  await page.waitForSelector('#stopStep');
  // Bez postępu pasek się przesuwa, póki agent pracuje, i staje, gdy stoi.
  await expect(page.locator('#barFill')).toHaveClass(/indeterminate/);
  await stop(page);
  await expect(page.locator('#barFill')).not.toHaveClass(/indeterminate/);
  await takeAnswer();
  await markPanel(page);
  await page.fill('#stepMessage', 'Dokończ, ale bez eksportu');
  await page.click('#sendStepMessage');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'message', step: 4, text: 'Dokończ, ale bez eksportu',
    afterStop: true });
  await expect(page.locator('#stoppedNote')).toBeHidden();
  await expect(page.locator('#stopStep')).toBeEnabled();
  await expect(page.locator('#barFill')).toHaveClass(/indeterminate/);
  await panelKept(page);
  expect((await stepNow(4)).stopped).toBeFalsy();
});

test('Cancel w potwierdzeniu niczego nie przerywa', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30 });
  await page.goto(base);
  await page.click('#stopStep');
  await page.click('#confirmCancel');
  await expect(page.locator('#stopStep')).toBeEnabled();
  await expect(page.locator('#stoppedNote')).toBeHidden();
  expect(await takeAnswer(1)).toBeNull();
  expect((await stepNow(4)).stopped).toBeFalsy();
});

test('Stop jest tylko na kroku, który właśnie pracuje', async ({ page }) => {
  await state({ step: 2, status: 'completed' });
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30 });
  await page.goto(base);
  await expect(page.locator('#stopStep')).toBeVisible();
  // Zakończony krok oglądany z boku nie ma czego zatrzymać.
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#panel h2')).toContainText('Feature Refinement');
  await expect(page.locator('#stopStep')).toHaveCount(0);
  await expect(page.locator('#stoppedNote')).toHaveCount(0);
  // Formularz wymagań nie ma swojego agenta.
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#task')).toBeVisible();
  await expect(page.locator('#stopStep')).toHaveCount(0);
});

test('Stop na pytaniu agenta zostawia pytanie, a odpowiedź na nie wznawia agenta', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await stop(page);
  await expect(page.locator('#panel h2')).toHaveText('Feature Refinement');
  await expect(page.locator('#freeAnswer')).toBeVisible();
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 2, taskId: 't1' });
  expect((await taskNow()).question).toMatchObject({ id: 'q1', text: 'Ile ról?' });
  await page.fill('#freeAnswer', 'Dwie');
  await page.click('#send');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toMatchObject({ kind: 'answer', questionId: 'q1', value: 'Dwie',
    afterStop: true });
  await expect(page.locator('#stoppedNote')).toBeHidden();
});

test('Stop na przeglądzie makiet zostawia przegląd', async ({ page }) => {
  const d = path.join(dir, 'tasks', 't1', 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '0-login.html'), '<!doctype html><h1>Logowanie</h1>');
  await state({ step: 3, enabled: true, status: 'in_progress', activeStep: 3,
    mockupReview: { rev: 1, text: 'Jeden ekran',
      screens: [{ id: '0.0', view: 'Logowanie', title: 'Pusty formularz', file: '0-login.html' }] } });
  await page.goto(base);
  await page.waitForSelector('#mockupFrame');
  await stop(page);
  await expect(page.locator('#panel h2')).toHaveText('Mockups');
  await expect(page.locator('#approveMockup')).toBeVisible();
  await expect(page.locator('#mockupFrame')).toHaveCount(1);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 3, taskId: 't1' });
  expect((await taskNow()).mockupReview).toMatchObject({ text: 'Jeden ekran' });
});
