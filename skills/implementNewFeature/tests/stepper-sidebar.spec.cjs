// Testy UI steppera implementNewFeature — lewy sidebar: chowanie oraz oba sposoby
// zakładania kolejnego taska, które z panelu kroku 1 przeniosły się właśnie tutaj.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const post = (route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-side-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await post('/api/state', { step: 1, status: 'in_progress', activeStep: 1 });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('oba przyciski zakładania taska są w sidebarze, nie w panelu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  await expect(page.locator('#sidebar #createEmptyTask')).toBeVisible();
  await expect(page.locator('#sidebar #createTask')).toBeVisible();
  await expect(page.locator('#panel #createTask')).toHaveCount(0);
  await expect(page.locator('#panel #createEmptyTask')).toHaveCount(0);
});

test('przycisk chowania zwija i rozwija sidebar', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  const toggle = page.locator('#sidebarToggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#sidebarBody')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Show sidebar');
  // Zwinięty sidebar to sam przycisk — treść znika, ale wyjście z niego zostaje.
  await expect(page.locator('#sidebarBody')).toBeHidden();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#sidebarBody')).toBeVisible();
});

test('zwinięcie sidebara przeżywa przeładowanie strony', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  await page.click('#sidebarToggle');
  await expect(page.locator('#sidebarBody')).toBeHidden();
  await page.reload();
  await page.waitForSelector('#branch');
  await expect(page.locator('#sidebarBody')).toBeHidden();
  await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded', 'false');
});

test('kopia bierze krok 1 otwartego taska, choć ten jest już przy implementacji',
  async ({ page }) => {
    await post('/api/answer', { kind: 'step1', taskDescription: 'Zaproszenia',
      businessRequirements: 'Admin zaprasza', branch: 'feature/zaproszenia',
      contractsText: 'POST /invites', hintsNote: 'Układ z ekranu A', generateMockups: true });
    await post('/api/state', { step: 1, status: 'completed', activeStep: 4 });
    await post('/api/state', { step: 4, status: 'in_progress', progress: 40 });
    await page.goto(base);
    // Na ekranie jest postęp implementacji, nie formularz — kopia i tak ma skąd czytać.
    await page.waitForSelector('#barFill');
    await expect(page.locator('#branch')).toHaveCount(0);
    await page.click('#createTask');
    await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
    await expect(page.locator('#task')).toHaveValue('Zaproszenia');
    await expect(page.locator('#biz')).toHaveValue('Admin zaprasza');
    await expect(page.locator('#contractsText')).toHaveValue('POST /invites');
    await expect(page.locator('#hintsNote')).toHaveValue('Układ z ekranu A');
    await expect(page.locator('#genMockups')).toBeChecked();
    // Dwa taski nie mogą dzielić brancha, więc nowy startuje bez niego.
    await expect(page.locator('#branch')).toHaveValue('');
  });

test('pusty task założony z innego kroku nie bierze nic', async ({ page }) => {
  await post('/api/answer', { kind: 'step1', taskDescription: 'Zaproszenia',
    businessRequirements: 'Admin zaprasza', branch: 'feature/zaproszenia' });
  await post('/api/state', { step: 1, status: 'completed', activeStep: 4 });
  await post('/api/state', { step: 4, status: 'in_progress', progress: 40 });
  await page.goto(base);
  await page.waitForSelector('#barFill');
  await page.click('#createEmptyTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await expect(page.locator('#task')).toHaveValue('');
  await expect(page.locator('#biz')).toHaveValue('');
});

test('kopia bierze krok 1 taska z otwartej zakładki, nie sąsiada', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  await page.fill('#task', 'Pierwszy task');
  await page.click('#createEmptyTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await page.fill('#task', 'Drugi task');
  // Kopia idzie z t2, bo to on jest otwarty — mimo że t1 ma własny, inny formularz.
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 3');
  await expect(page.locator('#task')).toHaveValue('Drugi task');
});
