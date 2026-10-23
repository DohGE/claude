// Testy UI steppera implementNewFeature — obrazki dołączane do odpowiedzi i wiadomości
// w krokach Feature Refinement, Mockups i Story Description (makiety: stepper-mockups.spec.cjs).
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
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=10`)).json()).answer;
// 1x1 px PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const file = name => ({ name, mimeType: 'image/png', buffer: PNG });
const names = answer => answer.attachments.map(p => path.basename(p));

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-attach-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'completed' });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('odpowiedź na pytanie refinementu niesie obrazek', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.setInputFiles('[data-attach-input="answer"]', [file('role.png')]);
  await expect(page.locator('[data-attach-tray="answer"] img')).toHaveCount(1);
  await page.fill('#freeAnswer', 'Jak na zrzucie');
  await page.click('#send');
  await expect(page.locator('#confirmText')).toHaveText(/^Jak na zrzucie\s+\+ 1 attached image$/);
  await page.click('#confirmOk');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'answer', questionId: 'q1', value: 'Jak na zrzucie' });
  // Orkiestrator dostaje ścieżki bezwzględne, które agent może przeczytać.
  expect(names(answer)).toEqual(['1-role.png']);
  expect(fs.readFileSync(answer.attachments[0]).equals(PNG)).toBe(true);
  await expect(page.locator('#sentTrail .msg img')).toHaveCount(1);
  await expect(page.locator('[data-attach-tray="answer"] img')).toHaveCount(0);
});

test('sam obrazek bez tekstu też jest odpowiedzią, a × zdejmuje go z tacki', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await page.setInputFiles('[data-attach-input="answer"]', [file('a.png'), file('b.png')]);
  await page.click('[data-attach-tray="answer"] .rm[aria-label="Remove a.png"]');
  await expect(page.locator('[data-attach-tray="answer"] img')).toHaveCount(1);
  await page.click('#send');
  await expect(page.locator('#confirmText')).toHaveText('+ 1 attached image');
  await page.click('#confirmOk');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'answer', questionId: 'q1', value: '' });
  expect(names(answer)).toEqual(['1-b.png']);
});

test('uwagi do planu refinementu niosą obrazek', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#feedback');
  await page.setInputFiles('[data-attach-input="answer"]', [file('uklad.png')]);
  await page.fill('#feedback', 'Układ jak na zrzucie');
  await page.click('#sendFeedback');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'decision', decision: 'feedback', text: 'Układ jak na zrzucie' });
  expect(names(answer)).toEqual(['1-uklad.png']);
});

test('wiadomość do agenta Story Description niesie obrazek i pokazuje go w czacie', async ({ page }) => {
  await state({ step: 8, enabled: true, status: 'in_progress', activeStep: 8, progress: 20 });
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  await page.setInputFiles('[data-attach-input="msg8"]', [file('przeplyw.png')]);
  await page.fill('#stepMessage', 'Uwzględnij ten przepływ');
  await page.click('#sendStepMessage');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'message', step: 8, text: 'Uwzględnij ten przepływ' });
  expect(names(answer)).toEqual(['1-przeplyw.png']);
  await expect(page.locator('#stepChat .msg.user img')).toHaveCount(1);
  await expect.poll(() => page.locator('#stepChat .msg.user img')
    .evaluate(img => img.naturalWidth)).toBe(1);
});

test('implementacja nie przyjmuje obrazków, a wiadomość bez nich nie ma klucza attachments',
  async ({ page }) => {
    await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 20 });
    await page.goto(base);
    await page.waitForSelector('#stepMessage');
    await expect(page.locator('[data-attach]')).toHaveCount(0);
    await page.fill('#stepMessage', 'Pomiń migrację');
    await page.click('#sendStepMessage');
    expect(await takeAnswer()).toEqual({ kind: 'message', step: 4, text: 'Pomiń migrację', taskId: 't1' });
  });
