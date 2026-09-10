// Testy UI steppera implementNewFeature — równoległe taski: Create new task kopiuje
// formularz, zakładki pojawiają się od drugiego taska i przełączają widok.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const state = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test.beforeEach(async ({ page }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-tasks-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ taskId: 't1', step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#branch');
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('jeden task nie pokazuje zakładek', async ({ page }) => {
  await expect(page.locator('#tabs .tab')).toHaveCount(0);
  await expect(page.locator('#tabs')).toBeHidden();
});

test('Create new task kopiuje formularz, pokazuje zakładki i czyści branch', async ({ page }) => {
  await page.fill('#task', 'Zaproszenia');
  await page.fill('#biz', 'Admin zaprasza');
  await page.fill('#contractsText', 'POST /invites');
  await page.fill('#branch', 'feature/zaproszenia');
  await page.check('#genMockups');
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab')).toHaveCount(2);
  await expect(page.locator('#task')).toHaveValue('Zaproszenia');
  await expect(page.locator('#biz')).toHaveValue('Admin zaprasza');
  await expect(page.locator('#contractsText')).toHaveValue('POST /invites');
  await expect(page.locator('#genMockups')).toBeChecked();
  // Dwa taski nie mogą dzielić brancha, więc nowy startuje bez niego.
  await expect(page.locator('#branch')).toHaveValue('');
  await expect(page.locator('#next')).toBeDisabled();
  await expect(page.locator('#next')).toHaveText('Next');
  // Formularz drugiego taska jest od razu edytowalny, nie "Waiting for the pipeline".
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
});

test('wgrane pliki są kopiowane do nowego taska', async ({ page }) => {
  // Pliki wgrane wcześniej przez formularz, tak jak po powrocie na krok 1.
  await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', category: 'hints', filename: 'ekran.png',
      dataBase64: Buffer.from('png').toString('base64') })
  });
  await fetch(`${base}/api/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', kind: 'step1', taskDescription: 'Opis',
      businessRequirements: 'Wymagania', branch: 'feature/pierwszy', hints: ['ekran.png'] })
  });
  await page.reload();
  await page.waitForSelector('#files-hints');
  await page.click('#createTask');
  await expect(page.locator('#files-hints li')).toHaveCount(1);
  expect(fs.existsSync(path.join(dir, 'tasks', 't2', 'hints', 'ekran.png'))).toBe(true);
});

test('zakładki przełączają widok i pokazują znacznik oczekiwania', async ({ page }) => {
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab')).toHaveCount(2);
  await state({ taskId: 't1', step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Ile ról?' } });
  await expect(page.locator('#tabs .tab[data-task=t1] .pending')).toBeVisible();
  await page.click('#tabs .tab[data-task=t1]');
  await expect(page.locator('#panel')).toContainText('Ile ról?');
  // Otwarta zakładka nie potrzebuje znacznika — pytanie widać na ekranie.
  await expect(page.locator('#tabs .tab[data-task=t1] .pending')).toHaveCount(0);
  await expect(page.locator('#tabs .tab[data-task=t1] .dot.in_progress')).toBeVisible();
});

test('etykieta otwartej zakładki podąża za wpisywanym branchem', async ({ page }) => {
  await page.fill('#task', 'Opis');
  await page.fill('#biz', 'Wymagania');
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await page.fill('#branch', 'feature/drugi');
  await expect(page.locator('#tabs .tab[data-task=t2] .label')).toHaveText('feature/drugi');
  await page.click('#next');
  await page.click('#confirmOk');
  // Po wysłaniu etykieta pochodzi już ze stanu taska, nie z pola.
  await expect(page.locator('#tabs .tab[data-task=t2] .label')).toHaveText('feature/drugi');
});

test('zakładkę da się zamknąć tylko przed startem taska', async ({ page }) => {
  await page.click('#createTask');
  // Krok 1 in_progress to tylko otwarty formularz — nadal można zamknąć.
  await expect(page.locator('#tabs .tab[data-task=t2] .close')).toBeVisible();
  await state({ taskId: 't2', step: 2, status: 'in_progress', activeStep: 2 });
  await expect(page.locator('#tabs .tab[data-task=t2] .close')).toHaveCount(0);
  await state({ taskId: 't2', step: 2, status: 'waiting', activeStep: 1 });
  await page.click('#tabs .tab[data-task=t2] .close');
  await page.click('#confirmOk');
  // Ostatni task nie ma już z czym współistnieć, więc pasek znika.
  await expect(page.locator('#tabs .tab')).toHaveCount(0);
  await expect(page.locator('#branch')).toBeVisible();
});

test('branch zajęty przez inny task blokuje Next z własnym komunikatem', async ({ page }) => {
  await page.fill('#task', 'Opis');
  await page.fill('#biz', 'Wymagania');
  await page.fill('#branch', 'feature/zaproszenia');
  await page.click('#next');
  await page.click('#confirmOk');
  await (await fetch(`${base}/api/answer?wait=5`)).json();
  await state({ taskId: 't1', step: 1, status: 'completed', activeStep: 2 });
  await state({ taskId: 't1', step: 2, status: 'in_progress' });
  // Drugi task tworzony ręcznie, bo formularz pierwszego jest już zamknięty.
  await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { taskDescription: 'Opis 2', businessRequirements: 'Wym 2' } })
  });
  await state({ taskId: 't2', step: 1, status: 'in_progress', activeStep: 1 });
  await page.click('#tabs .tab[data-task=t2]');
  await page.fill('#branch', 'feature/zaproszenia');
  await expect(page.locator('#branchHint')).toHaveText('Another task is already using this branch.');
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('#branch', 'feature/inny');
  await expect(page.locator('#branchHint')).toBeHidden();
  await expect(page.locator('#next')).toBeEnabled();
});

test('zakładkę da się otworzyć z klawiatury', async ({ page }) => {
  await page.click('#createTask');
  await page.locator('#tabs .tab[data-task=t1]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tabs .tab[data-task=t1]')).toHaveAttribute('aria-selected', 'true');
});

test('przełączenie zakładki nie odblokowuje wysłanej już odpowiedzi', async ({ page }) => {
  await page.click('#createTask');
  await state({ taskId: 't1', step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.click('#tabs .tab[data-task=t1]');
  await page.click('#approve');
  await page.click('#confirmOk');
  await expect(page.locator('#panel .notice')).toBeVisible();
  const drained = await (await fetch(`${base}/api/answer?wait=5`)).json();
  expect(drained.answer.decision).toBe('approve');
  // Powrót na zakładkę przerysowuje panel — blokada musi przetrwać, inaczej
  // drugi klik dopisałby duplikat, który późniejsza brama wzięłaby za swój.
  await page.click('#tabs .tab[data-task=t2]');
  await page.click('#tabs .tab[data-task=t1]');
  await expect(page.locator('#approve')).toBeDisabled();
  await expect(page.locator('#panel .notice')).toBeVisible();
  // Dopiero ruch orkiestratora zdejmuje blokadę.
  await state({ taskId: 't1', step: 2, status: 'completed', activeStep: 4, reviewSummary: null });
  await expect(page.locator('#panel .notice')).toHaveCount(0);
});

test('zamknięcie otwartej zakładki wraca na pierwszy task', async ({ page }) => {
  await page.fill('#task', 'Pierwszy');
  await page.click('#createTask');
  await expect(page.locator('#tabs .tab.selected')).toContainText('Task 2');
  await page.click('#tabs .tab[data-task=t2] .close');
  await page.click('#confirmOk');
  await expect(page.locator('#task')).toHaveValue('Pierwszy');
});
