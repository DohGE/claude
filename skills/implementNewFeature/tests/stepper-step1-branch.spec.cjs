// Testy UI steppera implementNewFeature — wymagane pole nazwy brancha w kroku 1:
// bramkuje przycisk Next, odrzuca nazwy nielegalne w gicie i trafia do odpowiedzi.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-branch-'));
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

test('Next pozostaje zablokowany bez nazwy brancha', async ({ page }) => {
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('#branch', 'feature/zaproszenia');
  await expect(page.locator('#next')).toBeEnabled();
});

test('nazwy nielegalne w gicie blokują Next i pokazują podpowiedź', async ({ page }) => {
  for (const bad of ['moja gałąź', 'feature/x..y', 'feature/x^', 'feature/x:y', 'feature/x?',
    '/feature', 'feature/', 'x.lock', 'feature/x@{1}']) {
    await page.fill('#branch', bad);
    await expect(page.locator('#next')).toBeDisabled();
    await expect(page.locator('#branchHint')).toBeVisible();
  }
  await page.fill('#branch', 'feature/ok-123');
  await expect(page.locator('#branchHint')).toBeHidden();
  await expect(page.locator('#next')).toBeEnabled();
});

test('pusty branch nie pokazuje podpowiedzi — nic jeszcze nie jest błędem', async ({ page }) => {
  await expect(page.locator('#branchHint')).toBeHidden();
  await page.fill('#branch', 'zła nazwa');
  await expect(page.locator('#branchHint')).toBeVisible();
  await page.fill('#branch', '');
  await expect(page.locator('#branchHint')).toBeHidden();
});

test('branch trafia do odpowiedzi i do stanu taska', async ({ page }) => {
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.branch).toBe('feature/zaproszenia');
  const state = await (await fetch(`${base}/api/state`)).json();
  expect(state.tasks[0].branch).toBe('feature/zaproszenia');
  expect(state.tasks[0].step1Submitted).toBe(true);
  expect(state.tasks[0].step1.taskDescription).toBe('Opis zadania');
});

test('potwierdzenie pierwszego zgłoszenia mówi, że można wrócić', async ({ page }) => {
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('#next');
  await expect(page.locator('#confirmText'))
    .toContainText('come back and edit it until implementation starts');
});
