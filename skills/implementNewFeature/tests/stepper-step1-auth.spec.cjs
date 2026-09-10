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
