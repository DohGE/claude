// Testy UI steppera implementNewFeature — powrót na krok 1: formularz wraca wypełniony,
// wgrane pliki da się usunąć, a Next zmienia się w ponowne wysłanie.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir;

const state = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});

const post = (urlPath, body) => fetch(`${base}${urlPath}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-revisit-'));
  app = createApp(dir);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  for (const n of ['a.png', 'b.png']) {
    await post('/api/upload', { taskId: 't1', category: 'hints', filename: n,
      dataBase64: Buffer.from('x').toString('base64') });
  }
  // Exactly what the browser sends on submit — the server stores it for the re-render.
  await post('/api/answer', { taskId: 't1', kind: 'step1',
    taskDescription: 'Zaproszenia', businessRequirements: 'Admin zaprasza',
    branch: 'feature/zaproszenia', contractsText: 'POST /invites',
    hintsNote: 'układ z ekranu 2', mockups: [], contracts: [], hints: ['a.png', 'b.png'],
    authProvided: false, generateMockups: true });
  await (await fetch(`${base}/api/answer?wait=1`)).json();   // drain it
  await state({ step: 1, status: 'in_progress', activeStep: 1 });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('formularz wraca wypełniony poprzednim zgłoszeniem', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  await expect(page.locator('#task')).toHaveValue('Zaproszenia');
  await expect(page.locator('#biz')).toHaveValue('Admin zaprasza');
  await expect(page.locator('#branch')).toHaveValue('feature/zaproszenia');
  await expect(page.locator('#contractsText')).toHaveValue('POST /invites');
  await expect(page.locator('#hintsNote')).toHaveValue('układ z ekranu 2');
  await expect(page.locator('#genMockups')).toBeChecked();
  // Nic się nie zmieniło, więc nie ma czego wysyłać — agenci zostają w spokoju.
  await expect(page.locator('#next')).toBeDisabled();
  await expect(page.locator('#changeHint')).toBeVisible();
  await expect(page.locator('#next')).toHaveText('Resubmit and re-run refinement');
  // Dopiero realna zmiana otwiera ponowne zgłoszenie.
  await page.fill('#biz', 'Admin i menedżer zapraszają');
  await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('#changeHint')).toBeHidden();
  // Opis materiałów jest widoczny, bo pliki już są — mimo pustego inputu plikowego.
  await expect(page.locator('#hintsNoteBox')).toBeVisible();
});

test('ponowne zgłoszenie zapowiada zawężony re-run', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#next');
  await page.fill('#biz', 'Admin i menedżer zapraszają');
  await page.click('#next');
  await expect(page.locator('#confirmTitle')).toHaveText('Resubmit the requirements?');
  await expect(page.locator('#confirmText')).toContainText('re-runs on what you changed');
});

test('wgrany plik da się usunąć i znika z kolejnego zgłoszenia', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#files-hints');
  await expect(page.locator('#files-hints li')).toHaveCount(2);
  await page.click('#files-hints .rm[data-name="a.png"]');
  await expect(page.locator('#files-hints li')).toHaveCount(1);
  expect(fs.existsSync(path.join(dir, 'tasks', 't1', 'hints', 'a.png'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'tasks', 't1', 'hints', 'b.png'))).toBe(true);
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.hints).toEqual(['b.png']);
});

test('edycja i ponowne wysłanie nadpisuje zapisane zgłoszenie', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#branch');
  await page.fill('#biz', 'Admin i menedżer zapraszają');
  await page.fill('#branch', 'feature/zaproszenia-v2');
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.businessRequirements).toBe('Admin i menedżer zapraszają');
  expect(answer.branch).toBe('feature/zaproszenia-v2');
  // Pliki, których nie ruszono, przechodzą do nowego zgłoszenia.
  expect(answer.hints).toEqual(['a.png', 'b.png']);
  const task = (await (await fetch(`${base}/api/state`)).json()).tasks[0];
  expect(task.branch).toBe('feature/zaproszenia-v2');
});

test('sam toggle makiet wystarcza za zmianę', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#genMockups');
  await expect(page.locator('#next')).toBeDisabled();
  await page.uncheck('#genMockups');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.generateMockups).toBe(false);
});

test('po starcie implementacji formularz jest tylko do odczytu', async ({ page }) => {
  await state({ step: 1, status: 'completed' });
  await state({ step: 4, status: 'in_progress', activeStep: 4 });
  await page.goto(base);
  await page.waitForSelector('.step[data-step="1"]');
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#task')).toBeDisabled();
  await expect(page.locator('#panel')).toContainText('requirements are frozen');
  await expect(page.locator('#next')).toHaveCount(0);
  // Nowe zadanie to jedyne wyjście i musi zostać dostępne.
  await expect(page.locator('#createTask')).toBeEnabled();
});

test('zapisane poświadczenia są sygnalizowane, a pola zostają puste', async ({ page }) => {
  await post('/api/auth', { taskId: 't1', login: 'qa@example.com', password: 'sekret' });
  await page.goto(base);
  await page.waitForSelector('#authLogin');
  await expect(page.locator('.panel')).toContainText('Credentials are stored for this task');
  await expect(page.locator('#authLogin')).toHaveValue('');
  await expect(page.locator('#authPassword')).toHaveValue('');
  // Bez ponownego wpisania poświadczeń odpowiedź nadal mówi, że są.
  await page.fill('#biz', 'Admin i menedżer zapraszają');
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.authProvided).toBe(true);
});
