// Testy UI steppera implementNewFeature — obrazki dołączane do opisu zadania w kroku 1:
// spinacz pod polem opisu, podgląd przed wysłaniem, wyłącznie obrazki, lista w odpowiedzi kroku 1.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

// 1x1 px PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const file = name => ({ name, mimeType: 'image/png', buffer: PNG });

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-images-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', step: 1, status: 'in_progress', activeStep: 1 })
  });
  await page.goto(base);
  await page.waitForSelector('#attachImages');
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

test('spinacz leży pod opisem zadania i otwiera wybór kilku obrazków', async ({ page }) => {
  const y = async sel => (await page.locator(sel).boundingBox()).y;
  expect(await y('#task')).toBeLessThan(await y('#attachImages'));
  expect(await y('#attachImages')).toBeLessThan(await y('#branch'));
  const chooser = page.waitForEvent('filechooser');
  await page.click('#attachImages');
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles([file('ekran.png')]);
  await expect(page.locator('#picked-images img')).toHaveCount(1);
});

test('opis przyjmuje tylko obrazki, kolejny wybór dokłada, a × usuwa', async ({ page }) => {
  await page.setInputFiles('#images', [file('a.png'),
    { name: 'notatki.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await expect(page.locator('#picked-images li')).toHaveCount(1);
  await page.setInputFiles('#images', [file('b.png')]);
  await expect(page.locator('#picked-images img')).toHaveCount(2);
  await page.click('#picked-images .rm[aria-label="Remove a.png"]');
  await expect(page.locator('#picked-images li')).toHaveCount(1);
  await submit(page);
  expect((await takeAnswer()).images).toEqual(['b.png']);
  expect(fs.readdirSync(path.join(dir, 'tasks', 't1', 'images'))).toEqual(['b.png']);
});

test('wysłany obrazek opisu ma podgląd w formularzu', async ({ page }) => {
  await page.setInputFiles('#images', [file('ekran.png')]);
  await submit(page);
  await takeAnswer();
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#files-images img')).toHaveCount(1);
  await expect.poll(() => page.locator('#files-images img')
    .evaluate(img => img.naturalWidth)).toBe(1);
  await expect(page.locator('#picked-images li')).toHaveCount(0);
});
