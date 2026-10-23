// Testy UI steppera implementNewFeature — bramka Story review w kroku Story Description:
// story.md na ekranie, akceptacja, uwagi z obrazkiem, nowa wersja i Stop.
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
const writeStory = text => fs.writeFileSync(path.join(dir, 'tasks', 't1', 'story.md'), text);

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-story-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  fs.mkdirSync(path.join(dir, 'tasks', 't1'), { recursive: true });
  writeStory('## Opis\nJako zapraszający chcę wysłać zaproszenie.\n\n## Kryteria akceptacji\n1. Pole e-mail jest wymagane.\n');
  await state({ step: 1, status: 'completed' });
  await state({ step: 2, status: 'completed' });
  await state({ step: 8, enabled: true, status: 'in_progress', activeStep: 8, progress: 90,
    reviewSummary: { text: 'Jedno kryterium z planu' } });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('bramka pokazuje story.md z podsumowaniem, a Approve rusza implementację', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#panel h2')).toHaveText('Story review');
  await expect(page.getByText('Jedno kryterium z planu')).toBeVisible();
  await expect(page.locator('#storyText')).toContainText('1. Pole e-mail jest wymagane.');
  await expect(page.locator('#copyStory')).toBeEnabled();
  await page.click('#approve');
  await expect(page.locator('#confirmTitle')).toHaveText('Approve the story?');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toEqual({ kind: 'decision', decision: 'approve', taskId: 't1' });
});

test('uwagi do story niosą obrazek', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#feedback');
  await page.setInputFiles('[data-attach-input="answer"]', [file('kryteria.png')]);
  await page.fill('#feedback', 'Dodaj kryterium o błędnym adresie');
  await page.click('#sendFeedback');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'decision', decision: 'feedback',
    text: 'Dodaj kryterium o błędnym adresie' });
  expect(answer.attachments.map(p => path.basename(p))).toEqual(['1-kryteria.png']);
  await expect(page.locator('#sentTrail .msg')).toHaveCount(1);
});

test('nowa wersja story podmienia tekst i czyści niewysłane uwagi', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#storyText')).toContainText('Pole e-mail');
  await page.fill('#feedback', 'Krócej');
  writeStory('## Opis\nNowa wersja.\n\n## Kryteria akceptacji\n1. Adres musi być poprawny.\n');
  await state({ step: 8, reviewSummary: { text: 'Po uwagach' } });
  await expect(page.locator('#storyText')).toContainText('Adres musi być poprawny.');
  await expect(page.locator('#feedback')).toHaveValue('');
});

test('refinement obejrzany w trakcie bramki story nie pokazuje planu do akceptacji', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#storyText');
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#panel h2')).not.toHaveText('Plan review');
  await expect(page.locator('#approve')).toHaveCount(0);
});

test('Stop zamyka bramkę story', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#storyText');
  await page.click('#stopStep');
  await page.click('#confirmOk');
  await expect(page.locator('#panel h2')).toHaveText('Story Description — stopped');
  await expect(page.locator('#approve')).toHaveCount(0);
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 8, taskId: 't1' });
});
