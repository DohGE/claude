// Testy UI steppera implementNewFeature - podglad makiety musi naprawde blokowac
// zewnetrzne zasoby, bo instrukcja makiet obiecuje, ze zewnetrzne odwolanie "renderuje
// sie jako luka". Sam sandbox tego nie robi - izoluje origin, ale zadanie wypuszcza.
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
// Submit w krokach 1-3 przechodzi przez własny dialog potwierdzenia (stepper-confirm.spec.cjs).
const submit = async (page, sel) => { await page.click(sel); await page.click('#confirmOk'); };

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
  await page.fill('#branch', 'feature/test');
}

const SCREENS = [
  { id: 'login', title: 'Logowanie', file: 'login.html' },
  { id: 'list', title: 'Lista', file: 'list.html' }
];

async function openMockupPanel(page) {
  const d = path.join(dir, 'tasks', 't1', 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'login.html'), '<!doctype html><h1 id="mk">Logowanie</h1>');
  fs.writeFileSync(path.join(d, 'list.html'), '<!doctype html><h1 id="mk">Lista</h1>');
  await postState({ step: 3, enabled: true, status: 'in_progress', activeStep: 3,
    mockupReview: { rev: 1, text: 'Dwa ekrany', screens: SCREENS,
      chat: [{ role: 'agent', text: 'Pierwsza wersja' }] } });
  await page.goto(base);
  await page.waitForSelector('#mockupFrame');
}


test('podglad makiety wpuszcza wlasne zasoby, a blokuje zewnetrzne', async ({ page }) => {
  await openMockupPanel(page);
  const res = await page.request.get(`${base}/generated-mockups/t1/login.html`);
  const csp = res.headers()['content-security-policy'] || "";
  expect(csp).toContain("default-src 'self' data:");
  expect(csp).toContain("img-src 'self' data:");
  expect(csp).toContain("connect-src 'none'");
  // to, czego instrukcja wymaga od agenta, musi przechodzic:
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
});
