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
  // story.md jest zawsze po angielsku, niezależnie od języka rozmowy.
  writeStory('## Description\nAs an inviter I want to send an invitation.\n\n## Acceptance criteria\n1. The e-mail field is required.\n');
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
  await expect(page.locator('#storyText')).toContainText('1. The e-mail field is required.');
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
  // Bramka znika do następnej wersji story; uwagi z obrazkiem zostają w rozmowie kroku.
  await expect(page.locator('#approve')).toHaveCount(0);
  await expect(page.locator('#stepChat .msg.user img')).toHaveCount(1);
  await expect(page.locator('#op')).toContainText('Reworking the story…');
});

test('nowa wersja story podmienia tekst i czyści niewysłane uwagi', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#storyText')).toContainText('The e-mail field');
  await page.fill('#feedback', 'Krócej');
  writeStory('## Description\nA new version.\n\n## Acceptance criteria\n1. The address must be valid.\n');
  await state({ step: 8, reviewSummary: { text: 'Po uwagach' } });
  await expect(page.locator('#storyText')).toContainText('The address must be valid.');
  await expect(page.locator('#feedback')).toHaveValue('');
});

test('refinement obejrzany w trakcie bramki story nie pokazuje planu do akceptacji', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#storyText');
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#panel h2')).not.toHaveText('Plan review');
  await expect(page.locator('#approve')).toHaveCount(0);
});

test('Stop zostawia bramkę story, a Approve po nim mówi, że przyszło po Stopie', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#storyText');
  await page.click('#stopStep');
  await page.click('#confirmOk');
  await expect(page.locator('#stoppedNote')).toBeVisible();
  await expect(page.locator('#panel h2')).toHaveText('Story review');
  await expect(page.locator('#storyText')).toContainText('The e-mail field');
  expect(await takeAnswer()).toEqual({ kind: 'stop', step: 8, taskId: 't1' });
  await page.click('#approve');
  await page.click('#confirmOk');
  expect(await takeAnswer()).toEqual({ kind: 'decision', decision: 'approve', taskId: 't1',
    afterStop: true });
});
