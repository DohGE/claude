// Testy UI steppera implementNewFeature — opcjonalna sekcja Authorization w kroku 1.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-ui-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', step: 1, status: 'in_progress', activeStep: 1 })
  });
  await page.goto(base);
  await page.waitForSelector('#task');
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

async function fillRequired(page) {
  await page.fill('#task', 'Opis zadania');
  await page.fill('#biz', 'Wymagania biznesowe');
  await page.fill('#branch', 'feature/test');
}

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

// Submit w krokach 1-3 przechodzi przez własny dialog potwierdzenia (stepper-confirm.spec.cjs).
async function submit(page, sel) {
  await page.click(sel);
  await page.click('#confirmOk');
}

test('krok 1 zawiera sekcję Authorization z polami login i maskowanym hasłem', async ({ page }) => {
  await expect(page.getByText('Authorization (optional)')).toBeVisible();
  await expect(page.locator('#authLogin')).toBeVisible();
  await expect(page.locator('#authPassword')).toHaveAttribute('type', 'password');
});

test('pola autoryzacji dziedziczą styl istniejących pól formularza', async ({ page }) => {
  const style = sel => page.locator(sel).evaluate(el => {
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, border: c.borderColor, radius: c.borderRadius };
  });
  expect(await style('#authLogin')).toEqual(await style('#task'));
  expect(await style('#authPassword')).toEqual(await style('#task'));
});

test('przycisk podglądu odsłania i ponownie maskuje hasło', async ({ page }) => {
  const btn = page.locator('#togglePassword');
  const pw = page.locator('#authPassword');
  await pw.fill('S3kret!');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(pw).toHaveAttribute('type', 'text');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Hide password');
  await btn.click();
  await expect(pw).toHaveAttribute('type', 'password');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Show password');
  await expect(pw).toHaveValue('S3kret!');
});

test('Next jest zablokowany, gdy wypełniono tylko jedno z pól autoryzacji', async ({ page }) => {
  await fillRequired(page);
  await expect(page.locator('#next')).toBeEnabled();
  await page.fill('#authLogin', 'qa@example.com');
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('#authPassword', 'S3kret!');
  await expect(page.locator('#next')).toBeEnabled();
  await page.fill('#authLogin', '');
  await expect(page.locator('#next')).toBeDisabled();
});

test('submit z credentials zapisuje auth.json, a odpowiedź step1 nie zawiera hasła', async ({ page }) => {
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'S3kret!');
  await submit(page, '#next');
  const got = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(got.answer.kind).toBe('step1');
  expect(got.answer.authProvided).toBe(true);
  expect(JSON.stringify(got.answer)).not.toContain('S3kret!');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't1', 'auth.json'), 'utf8'));
  expect(saved).toEqual({ login: 'qa@example.com', password: 'S3kret!' });
});

test('submit bez credentials wysyła authProvided:false i nie tworzy auth.json', async ({ page }) => {
  await fillRequired(page);
  await submit(page, '#next');
  const got = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(got.answer.kind).toBe('step1');
  expect(got.answer.authProvided).toBe(false);
  expect(fs.existsSync(path.join(dir, 'tasks', 't1', 'auth.json'))).toBe(false);
});


test('wpisane credentials przeżywają utworzenie nowego taska i są do niego kopiowane', async ({ page }) => {
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'S3kret!');
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  // Credentials nie przechodzą przez dokument stanu, więc kopiuje je sama strona.
  await expect(page.locator('#authLogin')).toHaveValue('qa@example.com');
  await expect(page.locator('#authPassword')).toHaveValue('S3kret!');
  // Źródłowy formularz też ich nie zgubił — przerysowanie panelu to nie kasowanie.
  await page.click('#tabs .tab[data-task=t1]');
  await expect(page.locator('#authLogin')).toHaveValue('qa@example.com');
  await expect(page.locator('#authPassword')).toHaveValue('S3kret!');
});

test('skopiowane credentials zapisują się do auth.json nowego taska', async ({ page }) => {
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'S3kret!');
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await page.fill('#branch', 'feature/drugi');
  await submit(page, '#next');
  const got = await (await fetch(`${base}/api/answer?wait=10&taskId=t2`)).json();
  expect(got.answer.authProvided).toBe(true);
  expect(JSON.stringify(got.answer)).not.toContain('S3kret!');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't2', 'auth.json'), 'utf8'));
  expect(saved).toEqual({ login: 'qa@example.com', password: 'S3kret!' });
});

test('New empty task startuje bez credentials', async ({ page }) => {
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'S3kret!');
  await page.click('#createEmptyTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await expect(page.locator('#authLogin')).toHaveValue('');
  await expect(page.locator('#authPassword')).toHaveValue('');
});

test('usunięcie wgranego pliku nie czyści wpisanych pól', async ({ page }) => {
  await post('/api/upload', { taskId: 't1', category: 'hints', filename: 'ekran.png',
    dataBase64: Buffer.from('png').toString('base64') });
  await post('/api/answer', { taskId: 't1', kind: 'step1', taskDescription: 'Opis',
    businessRequirements: 'Wymagania', branch: 'feature/pierwszy', hints: ['ekran.png'] });
  await page.reload();
  await page.waitForSelector('#files-hints');
  await page.fill('#task', 'Opis po zmianie');
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'S3kret!');
  // Usunięcie pliku przerysowuje formularz ze stanu serwera — a ten o tych polach nie wie.
  await page.click('#files-hints .rm');
  await expect(page.locator('#files-hints')).toHaveCount(0);
  await expect(page.locator('#task')).toHaveValue('Opis po zmianie');
  await expect(page.locator('#authLogin')).toHaveValue('qa@example.com');
  await expect(page.locator('#authPassword')).toHaveValue('S3kret!');
});
