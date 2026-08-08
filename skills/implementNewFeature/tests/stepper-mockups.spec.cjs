// Testy UI steppera implementNewFeature — opcjonalny krok Mockups: toggle w kroku 1,
// widoczność kafelka w stepperze i panel przeglądu makiet z czatem.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const postState = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=10`)).json()).answer;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-mock-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

async function openStep1(page) {
  await postState({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#genMockups');
  await page.fill('#task', 'Opis zadania');
  await page.fill('#biz', 'Wymagania biznesowe');
}

const SCREENS = [
  { id: 'login', title: 'Logowanie', file: 'login.html' },
  { id: 'list', title: 'Lista', file: 'list.html' }
];

async function openMockupPanel(page) {
  const d = path.join(dir, 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'login.html'), '<!doctype html><h1 id="mk">Logowanie</h1>');
  fs.writeFileSync(path.join(d, 'list.html'), '<!doctype html><h1 id="mk">Lista</h1>');
  await postState({ step: 3, enabled: true, status: 'in_progress', activeStep: 3,
    mockupReview: { rev: 1, text: 'Dwa ekrany', screens: SCREENS,
      chat: [{ role: 'agent', text: 'Pierwsza wersja' }] } });
  await page.goto(base);
  await page.waitForSelector('#mockupFrame');
}

test('stepper ukrywa krok Mockups, dopóki toggle go nie włączy', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('.step')).toHaveCount(5);
  await expect(page.locator('.step .name')).toHaveText(
    ['Requirements', 'Feature Refinement', 'Implementation', 'Validation & E2E', 'Code Review']);
  await postState({ step: 3, enabled: true });
  await expect(page.locator('.step')).toHaveCount(6);
  await expect(page.locator('.step').nth(2).locator('.name')).toHaveText('Mockups');
  // numeracja kafelków zostaje ciągła mimo stałych id kroków
  await expect(page.locator('.step .num')).toHaveText(['1', '2', '3', '4', '5', '6']);
  // sześć kafelków musi zmieścić się w jednym rzędzie — inaczej ostatni ląduje sam pod spodem
  const rows = await page.locator('.step').evaluateAll(els =>
    [...new Set(els.map(el => Math.round(el.getBoundingClientRect().top)))]);
  expect(rows).toHaveLength(1);
});

test('toggle Generate mockups jest domyślnie wyłączony', async ({ page }) => {
  await openStep1(page);
  await expect(page.locator('#genMockups')).not.toBeChecked();
  await page.click('#next');
  expect((await takeAnswer()).generateMockups).toBe(false);
});

test('zaznaczony toggle trafia do odpowiedzi kroku 1', async ({ page }) => {
  await openStep1(page);
  await page.check('#genMockups');
  await page.click('#next');
  expect((await takeAnswer()).generateMockups).toBe(true);
});

test('panel makiet renderuje podgląd, czat i przełącza ekrany', async ({ page }) => {
  await openMockupPanel(page);
  await expect(page.frameLocator('#mockupFrame').locator('#mk')).toHaveText('Logowanie');
  await expect(page.locator('.msg .who')).toHaveText(['Agent']);
  await page.click('[data-screen="1"]');
  await expect(page.frameLocator('#mockupFrame').locator('#mk')).toHaveText('Lista');
});

test('przełącznik Desktop/Mobile zmienia szerokość podglądu', async ({ page }) => {
  await openMockupPanel(page);
  const width = () => page.locator('#mockupFrame').evaluate(el => el.style.width);
  expect(await width()).toBe('1280px');
  await page.click('[data-viewport="Mobile"]');
  expect(await width()).toBe('390px');
});

test('Send wysyła feedback i blokuje panel do kolejnej rundy agenta', async ({ page }) => {
  await openMockupPanel(page);
  await page.fill('#mockupFeedback', 'Przycisk na pełną szerokość');
  await page.click('#sendMockup');
  expect(await takeAnswer()).toMatchObject(
    { kind: 'mockup', decision: 'feedback', text: 'Przycisk na pełną szerokość' });
  await expect(page.locator('#sendMockup')).toBeDisabled();
  // dopiero nowy rev odblokowuje panel — inaczej user klikałby w nieaktualną makietę
  await postState({ step: 3, mockupReview: { rev: 2, text: 'Poprawione',
    screens: SCREENS, chat: [{ role: 'user', text: 'Przycisk na pełną szerokość' }] } });
  await expect(page.locator('#sendMockup')).toBeEnabled();
  await expect(page.locator('.msg.user .who')).toHaveText(['You']);
});

test('Approve zatwierdza makiety', async ({ page }) => {
  await openMockupPanel(page);
  await page.click('#approveMockup');
  expect(await takeAnswer()).toMatchObject({ kind: 'mockup', decision: 'approve' });
});
