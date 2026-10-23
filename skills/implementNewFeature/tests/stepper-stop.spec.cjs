// Testy UI steppera implementNewFeature — przycisk Stop: przerywa agenta kroku, który
// właśnie pracuje, a brama porażki z Retry i Finish pojawia się od razu.
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

test('Stop przerywa krok od razu i zostawia wybór między Retry a Finish', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30 });
  await page.goto(base);
  await page.click('#stopStep');
  await expect(page.locator('#confirmTitle')).toHaveText('Stop this step?');
  await page.click('#confirmOk');
  // Serwer oznacza krok sam, więc brama nie czeka na orkiestratora.
  await expect(page.locator('#panel h2')).toHaveText('Implementation — stopped');
  await expect(page.locator('#panel .report')).toHaveText('Stopped by the user.');
  await expect(page.locator('#retry')).toBeVisible();
  await expect(page.locator('#finish')).toBeVisible();
  await expect(page.locator('#stopStep')).toHaveCount(0);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 4, taskId: 't1' });
  expect((await taskNow()).steps.find(s => s.id === 4).status).toBe('failed');
});

test('Cancel w potwierdzeniu niczego nie przerywa', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 30 });
  await page.goto(base);
  await page.click('#stopStep');
  await page.click('#confirmCancel');
  await expect(page.locator('#stopStep')).toBeEnabled();
  expect(await takeAnswer(1)).toBeNull();
  expect((await taskNow()).steps.find(s => s.id === 4).status).toBe('in_progress');
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
  // Formularz wymagań nie ma swojego agenta.
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#task')).toBeVisible();
  await expect(page.locator('#stopStep')).toHaveCount(0);
});

test('Stop na pytaniu agenta zamyka pytanie', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.click('#stopStep');
  await page.click('#confirmOk');
  await expect(page.locator('#panel h2')).toHaveText('Feature Refinement — stopped');
  await expect(page.locator('#freeAnswer')).toHaveCount(0);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 2, taskId: 't1' });
  expect((await taskNow()).question).toBeNull();
});

test('Stop na przeglądzie makiet zamyka przegląd', async ({ page }) => {
  const d = path.join(dir, 'tasks', 't1', 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '1.0-login.html'), '<!doctype html><h1>Logowanie</h1>');
  await state({ step: 3, enabled: true, status: 'in_progress', activeStep: 3,
    mockupReview: { rev: 1, text: 'Jeden ekran',
      screens: [{ id: '1.0', view: 'Logowanie', title: 'Pusty formularz', file: '1.0-login.html' }] } });
  await page.goto(base);
  await page.waitForSelector('#mockupFrame');
  await page.click('#stopStep');
  await page.click('#confirmOk');
  await expect(page.locator('#panel h2')).toHaveText('Mockups — stopped');
  await expect(page.locator('#approveMockup')).toHaveCount(0);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 3, taskId: 't1' });
  expect((await taskNow()).mockupReview).toBeNull();
});
