// Testy UI steppera implementNewFeature — krok 7 Mockoon Mocks: stały kafelek,
// przycisk na ekranie podsumowania, panel z JSON-em, kopiowanie i powrót do podsumowania.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const postState = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=10`)).json()).answer;

const SUMMARY = {
  finalStatus: 'Zakończone', changes: ['src/app.ts'], features: ['Lista użytkowników'],
  tests: '12/12', mockupComparison: '—', uxReview: '—', codeReview: 'Brak uwag'
};
const ENV_JSON = JSON.stringify({
  uuid: '5f9c1b2a-0000-4000-8000-000000000001', lastMigration: 33, name: 'Mocki funkcji',
  port: 3000, hostname: 'localhost', routes: []
}, null, 2);

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-mockoon-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const writeEnv = () => {
  const taskDir = path.join(dir, 'tasks', 't1');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'mockoon.json'), ENV_JSON, 'utf8');
};

async function openSummary(page) {
  await postState({ step: 6, status: 'completed', activeStep: 6, summary: SUMMARY });
  await page.goto(base);
  await page.waitForSelector('#generateMockoon');
}

// Krok 7 zakończony: panel z JSON-em wygrywa z ekranem podsumowania.
async function openMockoonPanel(page) {
  writeEnv();
  await postState({ step: 6, status: 'completed', summary: SUMMARY });
  await postState({ step: 7, status: 'completed', progress: 100, activeStep: 7 });
  await page.goto(base);
  await page.waitForSelector('#copyMockoon');
}

test('kafelek Mockoon Mocks jest widoczny od startu i czeka na żądanie', async ({ page }) => {
  await page.goto(base);
  const tile = page.locator('.step').last();
  await expect(tile.locator('.name')).toHaveText('Mockoon Mocks');
  await expect(tile.locator('.badge')).toHaveText('Waiting');
});

test('przycisk na podsumowaniu zamawia mocki i blokuje panel', async ({ page }) => {
  await openSummary(page);
  await page.click('#generateMockoon');
  expect(await takeAnswer()).toMatchObject({ kind: 'summary', decision: 'mockoon' });
  await expect(page.locator('#generateMockoon')).toBeDisabled();
});

test('panel kroku 7 pokazuje JSON z serwera i kopiuje go do schowka', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await openMockoonPanel(page);
  await expect(page.locator('#mockoonJson')).toContainText('"port": 3000');
  await expect(page.locator('#mockoonJson')).toContainText('"hostname": "localhost"');
  await page.click('#copyMockoon');
  await expect(page.locator('#copyMockoon')).toHaveText('Copied');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  // Chromium normalizuje schowek na Windows do CRLF — dla JSON-a to bez znaczenia.
  expect(clipboard.replace(/\r\n/g, '\n')).toBe(ENV_JSON);
});

test('Back to summary wraca na podsumowanie, skąd JSON znów da się otworzyć', async ({ page }) => {
  await openMockoonPanel(page);
  await page.click('#backToSummary');
  await expect(page.locator('.summary')).toBeVisible();
  // po udanym kroku 7 podsumowanie oferuje podgląd bez ponownego uruchamiania agenta
  await page.click('#showMockoon');
  await expect(page.locator('#mockoonJson')).toContainText('"port": 3000');
});

test('nieudany krok 7 daje retry i powrót bez kończenia pipeline’u', async ({ page }) => {
  await postState({ step: 6, status: 'completed', summary: SUMMARY });
  await postState({ step: 7, status: 'failed', activeStep: 7, report: 'Brak kontraktów API' });
  await page.goto(base);
  await page.waitForSelector('#retry');
  await expect(page.locator('.report')).toHaveText('Brak kontraktów API');
  await page.click('#backToSummary');
  expect(await takeAnswer()).toMatchObject({ kind: 'decision', decision: 'finish' });
  await expect(page.locator('.summary')).toBeVisible();
});

test('Shut down server melduje orchestratorowi koniec czekania', async ({ page }) => {
  await openSummary(page);
  const request = page.waitForRequest(r =>
    r.url().endsWith('/api/answer') && r.method() === 'POST');
  await page.click('#shutdown');
  expect(JSON.parse((await request).postData()))
    .toMatchObject({ kind: 'summary', decision: 'shutdown' });
});
