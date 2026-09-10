// Testy UI steppera implementNewFeature — ekran podsumowania, w tym sekcja "API mocks"
// (endpointy zamockowane w kroku 5 i usunięte przed jego końcem).
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

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-summary-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const summary = extra => ({
  summary: {
    finalStatus: 'Zakończono',
    changes: ['src/list.ts'],
    features: ['Lista użytkowników'],
    tests: '12 passed / 12 total',
    mockupComparison: 'zgodne',
    uxReview: 'brak uwag',
    codeReview: '0 findings',
    ...extra
  }
});

test('podsumowanie pokazuje zamockowane endpointy między testami a porównaniem makiet',
  async ({ page }) => {
    await postState(summary({ apiMocks: 'GET /api/users, POST /api/users — backend nie odpowiadał' }));
    await page.goto(base);
    await page.waitForSelector('.summary');
    // sekcja musi stać przy wynikach testów: to ona mówi, czego nie sprawdzono na prawdziwym API
    expect(await page.locator('.summary section h3').allTextContents()).toEqual([
      'Final status', 'Changes', 'Implemented features', 'Test results', 'API mocks',
      'Mockup comparison', 'UX review', 'Code review', 'Mockoon mocks'
    ]);
    await expect(page.locator('.summary section', { has: page.getByRole('heading', { name: 'API mocks' }) }))
      .toContainText('GET /api/users, POST /api/users — backend nie odpowiadał');
  });

test('brak mocków renderuje myślnik, nie "undefined"', async ({ page }) => {
  await postState(summary({}));
  await page.goto(base);
  await page.waitForSelector('.summary');
  await expect(page.locator('.summary section', { has: page.getByRole('heading', { name: 'API mocks' }) }))
    .toContainText('—');
});
