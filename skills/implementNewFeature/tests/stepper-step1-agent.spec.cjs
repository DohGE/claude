// Testy UI steppera implementNewFeature — wybór modelu i effortu sub-agentów
// w kroku 1: wartości globalne, nadpisania per krok, przetrwanie przerysowania
// panelu i wykrycie zmiany przy ponownym zgłoszeniu wymagań.
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

const post = (urlPath, body) => fetch(`${base}${urlPath}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

const task0 = async () => (await (await fetch(`${base}/api/state`)).json()).tasks[0];

test.beforeEach(async () => {
  app = createApp(fs.mkdtempSync(path.join(os.tmpdir(), 'inf-agent-')));
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
  await page.fill('#biz', 'Admin zaprasza użytkownika mailem');
  await page.fill('#branch', 'feature/zaproszenia');
};

test('formularz startuje z dziedziczeniem modelu i effortu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('');
  await expect(page.locator('#agentEffort')).toHaveValue('');
  // Nadpisania są schowane, dopóki ktoś ich nie potrzebuje.
  await expect(page.locator('#agentOverrides')).not.toHaveAttribute('open', '');
  for (const n of [2, 3, 4, 5, 6, 7]) {
    await expect(page.locator(`#agentModel-${n}`)).toHaveValue('');
    await expect(page.locator(`#agentEffort-${n}`)).toHaveValue('');
  }
});

test('ustawienia agenta jadą w zgłoszeniu kroku 1', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await fillRequired(page);
  await page.selectOption('#agentModel', 'opus');
  await page.selectOption('#agentEffort', 'high');
  await page.locator('#agentOverrides summary').click();
  await page.selectOption('#agentModel-6', 'haiku');
  await page.selectOption('#agentEffort-4', 'max');
  await page.click('#next');
  await page.click('#confirmOk');
  await expect.poll(async () => (await task0()).step1Submitted).toBe(true);
  const { agents } = (await task0()).step1;
  expect(agents.model).toBe('opus');
  expect(agents.effort).toBe('high');
  expect(agents.steps['6']).toEqual({ model: 'haiku', effort: '' });
  expect(agents.steps['4']).toEqual({ model: '', effort: 'max' });
  expect(agents.steps['2']).toEqual({ model: '', effort: '' });
});

test('wybór przeżywa przerysowanie panelu', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#agentModel');
  await fillRequired(page);
  await page.selectOption('#agentModel', 'sonnet');
  await page.locator('#agentOverrides summary').click();
  await page.selectOption('#agentEffort-5', 'low');
  // Kliknięcie kafelka zeruje sygnaturę panelu, czyli przerysowuje go od zera —
  // wpis do logu by tego nie zrobił, bo sygnatura się od niego nie zmienia.
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('sonnet');
  await page.locator('#agentOverrides summary').click();
  await expect(page.locator('#agentEffort-5')).toHaveValue('low');
});

test('sama zmiana modelu otwiera ponowne zgłoszenie wymagań', async ({ page }) => {
  await post('/api/answer', { taskId: 't1', kind: 'step1',
    taskDescription: 'Zaproszenia', businessRequirements: 'Admin zaprasza',
    branch: 'feature/zaproszenia', contractsText: '', hintsNote: '',
    mockups: [], contracts: [], hints: [], authProvided: false, generateMockups: false,
    agents: { model: '', effort: '', steps: {} } });
  await (await fetch(`${base}/api/answer?wait=1`)).json();   // opróżnij kolejkę
  await state({ step: 1, status: 'completed', activeStep: 2 });
  await state({ step: 2, status: 'in_progress' });
  await page.goto(base);
  // Formularz jest o jeden kafelek wstecz — pipeline stoi już na krok 2.
  await page.waitForSelector('.stepper .step[data-step="1"]');
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#agentModel');
  // Nic się nie zmieniło — nie ma po co budzić agentów.
  await expect(page.locator('#next')).toBeDisabled();
  await page.selectOption('#agentEffort', 'max');
  await expect(page.locator('#next')).toBeEnabled();
  // …i z powrotem na dziedziczenie: formularz znów zgadza się ze zgłoszonym.
  await page.selectOption('#agentEffort', '');
  await expect(page.locator('#next')).toBeDisabled();
});

test('po starcie implementacji ustawienia agenta są zamrożone', async ({ page }) => {
  await post('/api/answer', { taskId: 't1', kind: 'step1',
    taskDescription: 'Zaproszenia', businessRequirements: 'Admin zaprasza',
    branch: 'feature/zaproszenia', contractsText: '', hintsNote: '',
    mockups: [], contracts: [], hints: [], authProvided: false, generateMockups: false,
    agents: { model: 'opus', effort: 'high', steps: {} } });
  await (await fetch(`${base}/api/answer?wait=1`)).json();
  await state({ step: 1, status: 'completed' });
  await state({ step: 4, status: 'in_progress', activeStep: 4 });
  await page.goto(base);
  await page.waitForSelector('.stepper');
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('opus');
  await expect(page.locator('#agentModel')).toBeDisabled();
  await expect(page.locator('#agentEffort')).toBeDisabled();
});

// Zgłoszony formularz trzyma ustawienia zagnieżdżone (agents), a szkic — płasko.
// Oba miejsca poniżej czytają je z jednego zgłoszenia, bez otwartego formularza.
const submitted = extra => post('/api/answer', { taskId: 't1', kind: 'step1',
  taskDescription: 'Zaproszenia', businessRequirements: 'Admin zaprasza',
  branch: 'feature/zaproszenia', contractsText: '', hintsNote: '',
  mockups: [], contracts: [], hints: [], authProvided: false, generateMockups: false,
  agents: { model: 'opus', effort: 'high', steps: { 6: { model: 'haiku', effort: '' } } },
  ...extra });

test('powrót na formularz z ustawionym modelem nie udaje zmiany', async ({ page }) => {
  await submitted();
  await (await fetch(`${base}/api/answer?wait=1`)).json();
  await state({ step: 1, status: 'completed', activeStep: 2 });
  await state({ step: 2, status: 'in_progress' });
  await page.goto(base);
  await page.waitForSelector('.stepper .step[data-step="1"]');
  await page.locator('.step[data-step="1"]').click();
  await page.waitForSelector('#agentModel');
  await expect(page.locator('#agentModel')).toHaveValue('opus');
  await expect(page.locator('#agentEffort')).toHaveValue('high');
  // Nic nie ruszone — nie ma czego wysyłać ponownie.
  await expect(page.locator('#next')).toBeDisabled();
  await expect(page.locator('#changeHint')).toBeVisible();
});

test('kopia taska zabiera model i effort, także spoza formularza', async ({ page }) => {
  await submitted();
  await (await fetch(`${base}/api/answer?wait=1`)).json();
  await state({ step: 1, status: 'completed' });
  // Kopiowanie działa z dowolnego kroku, więc formularza nie ma na ekranie.
  await state({ step: 4, status: 'in_progress', activeStep: 4 });
  await page.goto(base);
  await page.waitForSelector('#createTask');
  await page.click('#createTask');
  await expect.poll(async () =>
    (await (await fetch(`${base}/api/state`)).json()).tasks.length).toBe(2);
  const copy = (await (await fetch(`${base}/api/state`)).json()).tasks[1];
  expect(copy.step1.agents.model).toBe('opus');
  expect(copy.step1.agents.effort).toBe('high');
  expect(copy.step1.agents.steps['6']).toEqual({ model: 'haiku', effort: '' });
});
