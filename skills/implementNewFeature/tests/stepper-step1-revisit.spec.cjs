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
    taskDescription: 'Zaproszenia',
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
  await expect(page.locator('#branch')).toHaveValue('feature/zaproszenia');
  await expect(page.locator('#contractsText')).toHaveValue('POST /invites');
  await expect(page.locator('#hintsNote')).toHaveValue('układ z ekranu 2');
  await expect(page.locator('#genMockups')).toBeChecked();
  await expect(page.locator('#refinement')).toBeChecked();
  await expect(page.locator('#storyDesc')).not.toBeChecked();
  await expect(page.locator('#reviewRuns .run')).toHaveCount(2);
  // Nic się nie zmieniło, więc nie ma czego wysyłać — agenci zostają w spokoju.
  await expect(page.locator('#next')).toBeDisabled();
  await expect(page.locator('#changeHint')).toBeVisible();
  await expect(page.locator('#next')).toHaveText('Resubmit');
  // Dopiero realna zmiana otwiera ponowne zgłoszenie.
  await page.fill('#task', 'Zaproszenia od admina i menedżera');
  await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('#changeHint')).toBeHidden();
  // Opis materiałów jest widoczny, bo pliki już są — mimo pustego inputu plikowego.
  await expect(page.locator('#hintsNoteBox')).toBeVisible();
});

test('ponowne zgłoszenie zapowiada zawężony re-run', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#next');
  await page.fill('#task', 'Zaproszenia od admina i menedżera');
  await page.click('#next');
  await expect(page.locator('#confirmTitle')).toHaveText('Resubmit the requirements?');
  await expect(page.locator('#confirmText')).toContainText('Only what the change touches is repeated');
});

test('ponowne zgłoszenie od razu przenosi na krok, który się powtarza, a dalsze są zablokowane',
  async ({ page }) => {
    await state({ step: 1, status: 'completed' });
    await state({ step: 2, status: 'completed' });
    await state({ step: 3, status: 'in_progress', activeStep: 3 });
    await page.goto(base);
    await page.waitForSelector('.step[data-step="1"]');
    await page.click('.step[data-step="1"]');
    await page.fill('#task', 'Zaproszenia od admina i menedżera');
    await page.click('#next');
    await page.click('#confirmOk');
    // Bez czekania na orkiestratora: serwer już cofnął przebieg do refinementu.
    await expect(page.locator('#panel h2')).toContainText('Feature Refinement');
    await expect(page.locator('.step[data-step="2"]')).toHaveClass(/in_progress/);
    await expect(page.locator('.step[data-step="3"]')).toHaveClass(/waiting/);
    await expect(page.locator('.step[data-step="3"]')).not.toHaveClass(/clickable/);
    const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
    expect(answer.revision).toMatchObject({ changed: ['description'], restartAt: 2 });
  });

test('zmiana samej gałęzi niczego nie powtarza', async ({ page }) => {
  await state({ step: 1, status: 'completed' });
  await state({ step: 2, status: 'in_progress', activeStep: 2 });
  await page.goto(base);
  await page.waitForSelector('.step[data-step="1"]');
  await page.click('.step[data-step="1"]');
  await page.fill('#branch', 'feature/zaproszenia-v2');
  await page.click('#next');
  await page.click('#confirmOk');
  // Nic się nie powtarza, więc strona wraca na krok, który właśnie pracuje.
  await expect(page.locator('#panel h2')).toContainText('Feature Refinement');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.revision).toMatchObject({ changed: ['branch'], restartAt: null });
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
  await page.fill('#task', 'Zaproszenia od admina i menedżera');
  await page.fill('#branch', 'feature/zaproszenia-v2');
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.taskDescription).toBe('Zaproszenia od admina i menedżera');
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

test('przełączniki refinementu i story też są zmianą i włączają kroki', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#storyDesc');
  await page.uncheck('#refinement');
  await page.check('#storyDesc');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.refinement).toBe(false);
  expect(answer.storyDescription).toBe(true);
  const steps = (await (await fetch(`${base}/api/state`)).json()).tasks[0].steps;
  expect(steps.filter(s => [2, 3, 8].includes(s.id)).map(s => s.enabled)).toEqual([false, true, true]);
});

test('przebiegi review: dodanie, flagi z listy skilla, limit trzech i usunięcie', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#reviewRuns .run');
  // Domyślnie dwa przebiegi: pierwszy bez flag, drugi --since-last.
  const run = n => page.locator(`#reviewRuns .run[data-run="${n}"]`);
  await expect(run(0).locator('input:checked')).toHaveCount(0);
  await expect(run(1).locator('input[data-flag="--since-last"]')).toBeChecked();
  // Lista flag przychodzi z SKILL.md codeReview — z opisem w podpowiedzi.
  await expect(run(0).locator('input[data-flag="--only-md"]')).toHaveCount(1);
  await expect(run(0).locator('input[data-flag="--project"]')).toHaveCount(0);
  await expect(run(0).locator('label:has(input[data-flag="--light"])')).toHaveAttribute('title', /\S/);
  await expect(page.locator('#next')).toBeDisabled();
  await page.click('#addRun');
  await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('#reviewRuns .run')).toHaveCount(3);
  await expect(page.locator('#addRun')).toBeDisabled();
  await run(2).locator('input[data-flag="--light"]').check();
  await run(0).locator('.run-rm').click();
  await expect(page.locator('#reviewRuns .run')).toHaveCount(2);
  await expect(page.locator('#addRun')).toBeEnabled();
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.codeReview).toEqual([{ flags: ['--since-last'] }, { flags: ['--light', '--since-last'] }]);
});

test('po starcie implementacji przebieg jest zamrożony, a ustawienia nadal się zapisują',
  async ({ page }) => {
    await state({ step: 1, status: 'completed' });
    await state({ step: 4, status: 'in_progress', activeStep: 4 });
    await page.goto(base);
    await page.waitForSelector('.step[data-step="1"]');
    await page.click('.step[data-step="1"]');
    await expect(page.locator('#task')).toBeDisabled();
    await expect(page.locator('#branch')).toBeDisabled();
    await expect(page.locator('#refinement')).toBeDisabled();
    await expect(page.locator('#files-hints .rm').first()).toBeDisabled();
    await expect(page.locator('#frozenHint')).toBeVisible();
    // Review, agenci i logowanie są czytane dopiero przez późniejsze kroki — zostają żywe.
    await expect(page.locator('#authLogin')).toBeEnabled();
    await expect(page.locator('#next')).toHaveText('Save settings');
    await expect(page.locator('#next')).toBeDisabled();
    await page.click('#addRun');
    await expect(page.locator('#next')).toBeEnabled();
    await page.click('#next');
    await expect(page.locator('#confirmTitle')).toHaveText('Save the new settings?');
    await page.click('#confirmOk');
    const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
    expect(answer.codeReview).toHaveLength(3);
    expect(answer.revision).toMatchObject({ changed: ['codeReview'], restartAt: null });
    // Nic się nie powtarza: implementacja pracuje dalej i strona na nią wraca.
    await expect(page.locator('#panel h2')).toContainText('Implementation');
    const task = (await (await fetch(`${base}/api/state`)).json()).tasks[0];
    expect(task.steps.find(s => s.id === 4).status).toBe('in_progress');
    // Inny kierunek funkcji to nowe zadanie, więc to wyjście musi zostać dostępne.
    await expect(page.locator('#createTask')).toBeEnabled();
  });

test('po podsumowaniu formularz jest tylko do odczytu', async ({ page }) => {
  await state({ step: 1, status: 'completed' });
  await state({ step: 4, status: 'completed' });
  await state({ step: 6, status: 'completed', activeStep: 6,
    summary: { finalStatus: 'Gotowe', changes: [], features: [] } });
  await page.goto(base);
  await page.waitForSelector('.step[data-step="1"]');
  await page.click('.step[data-step="1"]');
  await expect(page.locator('#task')).toBeDisabled();
  await expect(page.locator('#addRun')).toBeDisabled();
  await expect(page.locator('#authLogin')).toBeDisabled();
  await expect(page.locator('#panel')).toContainText('The pipeline has finished');
  await expect(page.locator('#next')).toHaveCount(0);
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
  await page.fill('#task', 'Zaproszenia od admina i menedżera');
  await page.click('#next');
  await page.click('#confirmOk');
  const { answer } = await (await fetch(`${base}/api/answer?wait=10`)).json();
  expect(answer.authProvided).toBe(true);
});
