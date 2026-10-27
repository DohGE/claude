// Testy UI steppera implementNewFeature — commit message i końcowa recenzja w kroku 1, model
// każdego sub-agenta, akceptacja makiet w trakcie poprawek i "Shut down and create pull request".
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir, shutdowns;

const post = (urlPath, body) => fetch(`${base}${urlPath}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const postState = body => post('/api/state', { taskId: 't1', ...body });
const takeAnswer = async (taskId = 't1') =>
  (await (await fetch(`${base}/api/answer?taskId=${taskId}&wait=1`)).json()).answer;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-pr-'));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify([
    { value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5.5' }]));
  shutdowns = 0;
  // The page's shutdown must reach the server; the test server stays up to be asserted on.
  app = createApp(dir, { onShutdown: () => { shutdowns++; } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(() => r()));
});

async function openStep1(page) {
  await postState({ step: 1, status: 'in_progress', activeStep: 1 });
  await page.goto(base);
  await page.waitForSelector('#task');
  await page.fill('#task', 'Opis zadania');
  await page.fill('#branch', 'feature/hosts');
}

test('commit message obok brancha jest wymagany', async ({ page }) => {
  await openStep1(page);
  const row = page.locator('.field-row');
  await expect(row.locator('#branch')).toBeVisible();
  await expect(row.locator('#commitMessage')).toBeVisible();
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('#commitMessage', 'feat: hosts inventory');
  await expect(page.locator('#next')).toBeEnabled();
  await page.fill('#commitMessage', '   ');
  await expect(page.locator('#next')).toBeDisabled();
});

test('końcowa recenzja ma własny przełącznik i własne przebiegi, a formularz wysyła wszystko', async ({ page }) => {
  await openStep1(page);
  await page.fill('#commitMessage', 'feat: hosts inventory');
  await expect(page.locator('#finalReview')).toBeChecked();
  await expect(page.locator('#finalRuns .run')).toHaveCount(1);
  await page.click('#addFinalRun');
  await expect(page.locator('#finalRuns .run')).toHaveCount(2);
  await expect(page.locator('#reviewRuns .run')).toHaveCount(2, { timeout: 2000 });
  // Every helper a step's agent spawns has its own row under that step.
  await page.locator('#agentOverrides summary').click();
  await page.selectOption('#agentModel-reviewWalker', 'sonnet');
  await page.selectOption('#agentModel-validationRunner', 'sonnet');
  await page.selectOption('#agentEffort-finalFixer', 'high');
  await page.click('#next');
  await page.click('#confirmOk');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'step1', commitMessage: 'feat: hosts inventory', finalReview: true });
  expect(answer.finalCodeReview.length).toBe(2);
  expect(answer.agents.roles.reviewWalker.model).toBe('sonnet');
  expect(answer.agents.roles.validationRunner.model).toBe('sonnet');
  expect(answer.agents.roles.finalFixer.effort).toBe('high');
  expect(answer.agents.roles.reviewFixer).toEqual({ model: '', effort: '' });
});

test('wyłączona końcowa recenzja chowa swoje przebiegi i znika z kafelków po wysłaniu', async ({ page }) => {
  await openStep1(page);
  await page.fill('#commitMessage', 'feat: x');
  await page.locator('label[for="finalReview"]').click();
  await expect(page.locator('#finalReviewBox')).toBeHidden();
  await page.click('#next');
  await page.click('#confirmOk');
  expect((await takeAnswer()).finalReview).toBe(false);
  await expect(page.locator('.step .name')).not.toContainText(['Final Code Review']);
});

test('makiety w trakcie poprawek można zaakceptować w wersji, którą widział użytkownik', async ({ page }) => {
  await postState({ step: 1, status: 'completed' });
  await postState({ step: 3, enabled: true, status: 'in_progress', activeStep: 3, progress: 30,
    mockupReview: { text: 'runda 1', screens: [] } });
  await post('/api/answer', { taskId: 't1', kind: 'mockup', decision: 'feedback', text: 'dodaj dark mode' });
  await takeAnswer();
  await page.goto(base);
  await page.click('#approveRework');
  await page.click('#confirmOk');
  const answer = await takeAnswer();
  expect(answer).toMatchObject({ kind: 'mockup', decision: 'approve', duringRework: true });
});

test('przycisk PR stoi obok zamknięcia serwera, a bez ukończonego zadania jest wyłączony', async ({ page }) => {
  await postState({ summary: { finalStatus: 'Failed at Implementation', changes: [] } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  const section = page.locator('#shutdown-section');
  await expect(section.locator('button')).toHaveText(['Shut down and create pull request', 'Shut down server']);
  await expect(page.locator('#shutdownPr')).toBeDisabled();
});

test('Shut down and create pull request powiadamia orkiestratora i zamyka serwer', async ({ page }) => {
  await post('/api/answer', { taskId: 't1', kind: 'step1', taskDescription: 'Opis', branch: 'feature/hosts', commitMessage: 'feat: hosts' });
  await takeAnswer();
  await postState({ branch: 'feature/hosts', base: 'master', summary: { finalStatus: 'Completed', changes: ['src/a.ts'] } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  // The task's orchestrator is listening, as after its summary: its poll must hear the answer
  // before the server goes down.
  const listening = fetch(`${base}/api/answer?taskId=t1&wait=30`).then(r => r.json());
  await page.click('#shutdownPr');
  await expect(page.locator('#confirmText')).toContainText('feature/hosts → master');
  await page.click('#confirmOk');
  expect((await listening).answer).toEqual({ kind: 'summary', decision: 'shutdown_pr', taskId: 't1' });
  await expect(page.locator('#shutdown-section')).toContainText('Server stopped', { timeout: 10000 });
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't1', 'pr-request.json'), 'utf8'));
  expect(request).toMatchObject({ branch: 'feature/hosts', base: 'master', commitMessage: 'feat: hosts' });
  expect(shutdowns).toBe(1);
});
