// Testy UI steppera implementNewFeature — commit message i końcowa recenzja w kroku 1, model
// każdego sub-agenta, akceptacja makiet w trakcie poprawek, "Create pull request" i "Shut down server" w pasku bocznym.
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
  // One review run by default: the final review's --since-last run re-checks its fixes.
  await expect(page.locator('#reviewRuns .run')).toHaveCount(1, { timeout: 2000 });
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

test('podsumowanie ma przycisk Create pull request, a zamknięcie serwera jest w pasku bocznym', async ({ page }) => {
  await postState({ summary: { finalStatus: 'Failed at Implementation', changes: [] } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  await expect(page.locator('#pr-section #createPr')).toHaveText('Create pull request');
  await expect(page.locator('#pr-section #createPr')).toBeEnabled();
  await expect(page.locator('#pr-section')).toContainText('did not finish its pipeline');
  await expect(page.locator('.summary #shutdown')).toHaveCount(0);
  await expect(page.locator('#sidebar #shutdown')).toHaveText('Shut down server');
  await expect(page.locator('h1')).toHaveCount(0);
});

test('Create pull request pyta orkiestratora zadania, a serwer zostaje', async ({ page }) => {
  await post('/api/answer', { taskId: 't1', kind: 'step1', taskDescription: 'Opis', branch: 'feature/hosts', commitMessage: 'feat: hosts' });
  await takeAnswer();
  await postState({ branch: 'feature/hosts', base: 'master', summary: { finalStatus: 'Completed', changes: ['src/a.ts'] } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  const listening = fetch(`${base}/api/answer?taskId=t1&wait=30`).then(r => r.json());
  await page.click('#createPr');
  await expect(page.locator('#confirmText')).toContainText('feature/hosts → master');
  await page.click('#confirmOk');
  expect((await listening).answer).toEqual({ kind: 'summary', decision: 'create_pr', taskId: 't1' });
  await expect(page.locator('#pr-section')).toContainText('Creating the pull request');
  await expect(page.locator('#createPr')).toBeDisabled();
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't1', 'pr-request.json'), 'utf8'));
  expect(request).toMatchObject({ branch: 'feature/hosts', base: 'master', commitMessage: 'feat: hosts' });
  expect(shutdowns).toBe(0);
  // The orchestrator reports the pull request back; the link shows up in place.
  await postState({ pr: { status: 'created', url: 'https://github.com/o/r/pull/7', commit: 'abc1234' } });
  await expect(page.locator('#pr-section a')).toHaveAttribute('href', 'https://github.com/o/r/pull/7');
  await expect(page.locator('#createPr')).toBeDisabled();
});

test('nieudany PR pokazuje powód i pozwala spróbować ponownie', async ({ page }) => {
  await postState({ branch: 'feature/hosts', summary: { finalStatus: 'Completed', changes: [] } });
  await post('/api/answer', { taskId: 't1', kind: 'summary', decision: 'create_pr' });
  await postState({ pr: { status: 'failed', reason: 'pre-commit hook refused the commit' } });
  await page.goto(base);
  await page.waitForSelector('.summary');
  await expect(page.locator('#pr-section .pr-status')).toContainText('pre-commit hook refused the commit');
  await expect(page.locator('#createPr')).toHaveText('Try again');
  await expect(page.locator('#createPr')).toBeEnabled();
});

test('Shut down server z paska bocznego pyta o potwierdzenie i zamyka serwer', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#sidebar #shutdown');
  await page.click('#shutdown');
  await expect(page.locator('#confirmTitle')).toHaveText('Shut down the server?');
  await page.click('#confirmCancel');
  expect(shutdowns).toBe(0);
  await page.click('#shutdown');
  await page.click('#confirmOk');
  await expect(page.locator('#shutdownHint')).toContainText('Server stopped', { timeout: 10000 });
  expect(shutdowns).toBe(1);
});
