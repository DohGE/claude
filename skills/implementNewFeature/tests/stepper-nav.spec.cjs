// Testy UI steppera implementNewFeature — nawigacja po nagłówkach steppera: klikalne
// są tylko kroki już otwarte, przełączanie nie rusza pipeline'u, a pasek nad panelem
// mówi, gdzie pipeline naprawdę stoi, i oddaje mu widok z powrotem.
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

const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=1`)).json()).answer;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-nav-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'completed' });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('klikalne są tylko kroki, które pipeline już otworzył', async ({ page }) => {
  await state({ step: 2, status: 'completed' });
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 20 });
  await page.goto(base);
  await page.waitForSelector('.step');
  // Kroki 1, 2 i 4; makiety są wyłączone, a 5-7 pipeline jeszcze nie otworzył.
  await expect(page.locator('.step.clickable')).toHaveCount(3);
  await expect(page.locator('.step[data-step="5"]')).not.toHaveClass(/clickable/);
  await expect(page.locator('.step[data-step="4"]')).toHaveClass(/viewing/);
});

test('kafelek przełącza panel lokalnie — orkiestrator się o tym nie dowiaduje',
  async ({ page }) => {
    await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 20 });
    await page.goto(base);
    await page.waitForSelector('#barFill');
    await page.click('.step[data-step="1"]');
    await expect(page.locator('#branch')).toBeVisible();
    await expect(page.locator('.step[data-step="1"]')).toHaveClass(/viewing/);
    await expect(page.locator('#viewbar')).toContainText('Implementation');
    expect(await takeAnswer()).toBeNull();
  });

test('Go to current oddaje widok pipeline’owi', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 20 });
  await page.goto(base);
  await page.waitForSelector('#barFill');
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#viewbar')).toBeVisible();
  await page.click('#goCurrent');
  await expect(page.locator('#barFill')).toBeVisible();
  await expect(page.locator('#viewbar')).toBeHidden();
});

test('ruch pipeline’u nie zabiera ekranu, tylko o sobie melduje', async ({ page }) => {
  await state({ step: 2, status: 'in_progress', activeStep: 2, progress: 10 });
  await page.goto(base);
  await page.waitForSelector('#barFill');
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#branch')).toBeVisible();
  await state({ step: 2, question: { id: 'q1', text: 'Ile ról?' } });
  // Pytanie nie wyrywa formularza spod rąk — sygnalizuje się w pasku.
  await expect(page.locator('#viewbar')).toContainText('waiting for you');
  await expect(page.locator('#branch')).toBeVisible();
  await page.click('.step[data-step="2"]');
  await expect(page.locator('#panel')).toContainText('Ile ról?');
});

test('klawiatura otwiera krok tak samo jak myszka', async ({ page }) => {
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 20 });
  await page.goto(base);
  await page.waitForSelector('#barFill');
  await page.locator('.step[data-step="1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#branch')).toBeVisible();
});

test('po podsumowaniu kafelek pokazuje krok, a pasek wraca na podsumowanie',
  async ({ page }) => {
    await state({ step: 6, status: 'completed', activeStep: 6,
      summary: { finalStatus: 'Gotowe', changes: [], features: [] } });
    await page.goto(base);
    await page.waitForSelector('.summary');
    await page.click('.step[data-step="6"]');
    await expect(page.locator('#panel h2')).toHaveText('Code Review');
    await expect(page.locator('#viewbar')).toContainText('finished');
    await page.click('#goCurrent');
    await expect(page.locator('.summary')).toBeVisible();
  });

test('nieudany krok odwiedzony po fakcie nie oferuje już decyzji', async ({ page }) => {
  await state({ step: 5, status: 'failed', activeStep: 5, report: 'E2E nie przeszło' });
  await state({ step: 6, status: 'completed',
    summary: { finalStatus: 'Failed at step 5', changes: [], features: [] } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  await page.click('.step[data-step="5"]');
  await expect(page.locator('.report')).toHaveText('E2E nie przeszło');
  await expect(page.locator('#retry')).toHaveCount(0);
  await expect(page.locator('#finish')).toHaveCount(0);
});
