// Testy UI steppera implementNewFeature — auto-resize pól textarea.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base;

const lines = n => Array.from({ length: n }, (_, i) => `linia ${i + 1}`).join('\n');

test.beforeEach(async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-ta-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 1, status: 'in_progress', activeStep: 1 })
  });
  await page.goto(base);
  await page.waitForSelector('#task');
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const height = (page, sel) =>
  page.locator(sel).evaluate(el => el.getBoundingClientRect().height);

test('textarea rośnie wraz z wpisywaną treścią', async ({ page }) => {
  const before = await height(page, '#task');
  await page.fill('#task', lines(10));
  const after = await height(page, '#task');
  expect(after).toBeGreaterThan(before);
});

test('textarea zatrzymuje wzrost na 45vh i wtedy scrolluje', async ({ page }) => {
  await page.fill('#task', lines(300));
  const box = await page.locator('#task').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    overflowY: getComputedStyle(el).overflowY,
    max: window.innerHeight * 0.45
  }));
  expect(box.height).toBeLessThanOrEqual(box.max + 1);
  expect(box.overflowY).toBe('auto');
});

test('skrócenie treści zmniejsza pole z powrotem do minimum', async ({ page }) => {
  const min = await height(page, '#task');
  await page.fill('#task', lines(10));
  await page.fill('#task', 'krótko');
  expect(await height(page, '#task')).toBeCloseTo(min, 0);
});

test('auto-resize działa też w polach spoza kroku 1', async ({ page }) => {
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 2, status: 'in_progress', activeStep: 2,
      question: { id: 'q1', text: 'Jakie pole?', options: [] } })
  });
  await page.waitForSelector('#freeAnswer');
  const before = await height(page, '#freeAnswer');
  await page.fill('#freeAnswer', lines(10));
  expect(await height(page, '#freeAnswer')).toBeGreaterThan(before);
});
