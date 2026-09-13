// Testy UI steppera implementNewFeature - zapis, ktory nie dotarl do serwera, nie moze
// wygladac jak zapisany: orkiestrator wisi na dlugim pollu, wiec zgubiona odpowiedz
// zostawia przebieg zaparkowany bez sladu.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-senderr-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', step: 1, status: 'in_progress', activeStep: 1 })
  });
  await page.goto(base);
  await page.waitForSelector('#branch');
  await page.fill('#task', 'Opis zadania');
  await page.fill('#biz', 'Wymagania biznesowe');
});


test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('odrzucony zapis pokazuje pasek bledu zamiast udawac sukces', async ({ page }) => {
  await page.route('**/api/answer', route => route.fulfill({
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unknown task' })
  }));
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect(page.locator('#sendError')).toBeVisible();
  await expect(page.locator('#sendError')).toContainText('400');
});

test('nieosiagalny serwer tez daje pasek bledu', async ({ page }) => {
  await page.route('**/api/answer', route => route.abort());
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect(page.locator('#sendError')).toBeVisible();
});
