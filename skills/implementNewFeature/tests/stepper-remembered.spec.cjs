// Testy UI steppera implementNewFeature — co przeglądarka pamięta między runami:
// model i effort sub-agentów oraz dane logowania do testów E2E. Serwer stoi na stałym
// porcie, więc origin jest jeden i localStorage przeżywa restart — a dane logowania
// muszą być przypisane do projektu, bo origin mają wspólny ze wszystkimi.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base;

const state = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});

const getState = async () => (await (await fetch(`${base}/api/state`)).json());

test.beforeEach(async () => {
  app = createApp(fs.mkdtempSync(path.join(os.tmpdir(), 'inf-mem-')));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

const fillRequired = async page => {
  await page.fill('#task', 'Zaproszenia dla zespołu');
  await page.fill('#branch', 'feature/zaproszenia');
  await page.fill('#commitMessage', 'feat: test');
};

test('model i effort wracają na kolejnym pustym formularzu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await page.selectOption('#agentModel', 'opus');
  await page.selectOption('#agentEffort', 'high');
  await page.locator('#agentOverrides summary').click();
  await page.selectOption('#agentModel-6', 'haiku');
  // Nowy, pusty task to nowy formularz — i tu ma być to, co ostatnio wybrane.
  await page.click('#createEmptyTask');
  await expect.poll(async () => (await getState()).tasks.length).toBe(2);
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('opus');
  await expect(page.locator('#agentEffort')).toHaveValue('high');
  await page.locator('#agentOverrides summary').click();
  await expect(page.locator('#agentModel-6')).toHaveValue('haiku');
});

test('przeładowanie strony nie gubi zapamiętanego modelu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await page.selectOption('#agentModel', 'sonnet');
  await page.reload();
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('sonnet');
});

test('zgłoszony task pokazuje swoje ustawienia, nie zapamiętane', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  // Najpierw zapamiętaj coś innego niż to, co pójdzie w zgłoszeniu.
  await page.selectOption('#agentModel', 'opus');
  await page.selectOption('#agentModel', 'haiku');
  await fillRequired(page);
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await getState()).tasks[0].step1Submitted).toBe(true);
  // Zmiana pamięci po zgłoszeniu nie może ruszyć formularza tego taska.
  await page.evaluate(() => localStorage.setItem('inf.agents',
    JSON.stringify({ model: 'fable', effort: 'max', steps: {} })));
  await state({ step: 1, status: 'completed', activeStep: 2 });
  await state({ step: 2, status: 'in_progress' });
  // Strona odpytuje co sekundę: kliknięcie kafelka zanim zobaczy, że pipeline ruszył,
  // znaczy "zostaję na bieżącym kroku" i panel odjeżdża na krok 2 razem z nim.
  await expect(page.locator('.step[data-step="2"]')).toHaveClass(/in_progress/);
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('haiku');
  // …i nadal nie ma czego wysyłać ponownie.
  await expect(page.locator('#next')).toBeDisabled();
});

test('login i hasło wracają na kolejnym tasku', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#authLogin');
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'tajne123');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await getState()).tasks[0].authSaved).toBe(true);
  await page.click('#createEmptyTask');
  await expect.poll(async () => (await getState()).tasks.length).toBe(2);
  await page.waitForSelector('#authLogin');
  await expect(page.locator('#authLogin')).toHaveValue('qa@example.com');
  await expect(page.locator('#authPassword')).toHaveValue('tajne123');
});

test('dane logowania są przypisane do projektu, nie do przeglądarki', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#authLogin');
  await fillRequired(page);
  await page.selectOption('#agentModel', 'opus');
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'tajne123');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await getState()).tasks[0].authSaved).toBe(true);
  const { project } = await getState();
  expect(project).toBeTruthy();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  const authKeys = keys.filter(k => k.startsWith('inf.auth.'));
  expect(authKeys).toEqual([`inf.auth.${project}`]);
  // Model i effort to preferencja człowieka, nie projektu — ten klucz jest wspólny.
  expect(keys).toContain('inf.agents');
});

test('wyłączenie zapamiętywania kasuje zapisane hasło', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#authLogin');
  await fillRequired(page);
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'tajne123');
  await expect(page.locator('#rememberAuth')).toBeChecked();
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await getState()).tasks[0].authSaved).toBe(true);
  await page.click('#createEmptyTask');
  await page.waitForSelector('#rememberAuth');
  await expect(page.locator('#authPassword')).toHaveValue('tajne123');
  await page.uncheck('#rememberAuth');
  // Odznaczenie działa od razu, a nie dopiero przy następnym zgłoszeniu.
  expect(await page.evaluate(() => Object.keys(localStorage)
    .filter(k => k.startsWith('inf.auth.')))).toEqual([]);
  await expect(page.locator('#authLogin')).toHaveValue('');
  await expect(page.locator('#authPassword')).toHaveValue('');
});

test('odznaczone zapamiętywanie przeżywa przerysowanie panelu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#rememberAuth');
  await fillRequired(page);
  await page.uncheck('#rememberAuth');
  await page.fill('#authLogin', 'qa@example.com');
  await page.fill('#authPassword', 'tajne123');
  // Zwykły tick serwera przerysowuje panel — przełącznik nie może wrócić na "tak",
  // bo następne zgłoszenie zapisałoby hasło, którego użytkownik zapisać nie chciał.
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#rememberAuth');
  await expect(page.locator('#rememberAuth')).not.toBeChecked();
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await getState()).tasks[0].authSaved).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage)
    .filter(k => k.startsWith('inf.auth.')))).toEqual([]);
});

test('lista modeli jest z sesji, a zapamiętany model spoza niej to dziedziczenie', async ({ page }) => {
  // Sesja, której narzędzie Agent zna inne modele niż ta, w której wybór zapamiętano.
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-mem-'));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify([
    { value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5' }]));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.addInitScript(() => localStorage.setItem('inf.agents', JSON.stringify({
    model: 'haiku', effort: 'high', steps: { 6: { model: 'sonnet', effort: '' } } })));
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel option')).toHaveText(['Inherit', 'Opus 5.5', 'Sonnet 5']);
  await expect(page.locator('#agentModel')).toHaveValue('');
  await expect(page.locator('#agentEffort')).toHaveValue('high');
  await page.locator('#agentOverrides summary').click();
  await expect(page.locator('#agentModel-6')).toHaveValue('sonnet');
});

test('kroki, oba code review i ich runy wracają na kolejnym pustym formularzu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#refinement');
  await page.locator('label[for="refinement"]').click();
  await page.locator('label[for="genMockups"]').click();
  await page.locator('label[for="storyDesc"]').click();
  await page.click('#addRun');
  await page.locator('label[for="finalReview"]').click();
  const runs = await page.evaluate(() => document.querySelectorAll('#reviewRuns .run').length);
  await page.click('#createEmptyTask');
  await expect.poll(async () => (await getState()).tasks.length).toBe(2);
  await page.waitForSelector('#refinement');
  await expect(page.locator('#refinement')).not.toBeChecked();
  await expect(page.locator('#genMockups')).toBeChecked();
  await expect(page.locator('#storyDesc')).toBeChecked();
  await expect(page.locator('#finalReview')).not.toBeChecked();
  await expect(page.locator('#finalReviewBox')).toBeHidden();
  await expect(page.locator('#reviewRuns .run')).toHaveCount(runs);
});

test('opis podziału na części leży pod branchem i idzie w zgłoszeniu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#taskSplit');
  const below = await page.evaluate(() => {
    const y = sel => document.querySelector(sel).getBoundingClientRect().top;
    return y('#taskSplit') > y('#branch') && y('#taskSplit') > y('#commitMessage');
  });
  expect(below).toBe(true);
  await fillRequired(page);
  await page.fill('#taskSplit', '1. API\n2. UI');
  await expect(page.locator('#taskSplitHint')).toContainText('feature/zaproszenia-part-1');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => ((await getState()).tasks[0].step1 || {}).taskSplit).toBe('1. API\n2. UI');
});
