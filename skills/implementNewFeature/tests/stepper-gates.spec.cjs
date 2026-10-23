// Testy UI steppera implementNewFeature — bramy kroków na jednym ekranie z postępem:
// pytanie obok logu, przyciski Send czynne dopiero z treścią, "Critical information" nad planem
// i róg z zużyciem sesji orkiestratora.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../scripts/server.cjs');

let app, base, dir, usage;

const postState = body => fetch(`${base}/api/state`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});
const takeAnswer = async () => (await (await fetch(`${base}/api/answer?wait=5`)).json()).answer;
// 1x1 px PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// Zużycie podstawione zamiast pliku status line'u, a sesja t1 nazwana wprost, żeby róg nie
// zależał od sesji, w której biegną testy.
async function startApp(opts = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inf-gates-'));
  app = createApp(dir, { readUsage: () => usage, starterSession: 's1', ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await postState({ step: 1, status: 'completed' });
}

async function stopApp() {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
}

test.beforeEach(async () => {
  usage = null;
  await startApp();
});

test.afterEach(stopApp);

const chipOf = (page, label) => page.locator('#usage .chip', { has: page.locator('.k', { hasText: label }) });

// Waiter sesji s1 parkuje poll i znika w trakcie - tak wygląda zamknięty terminal.
async function closeOrchestrator() {
  const ctrl = new AbortController();
  const poll = fetch(`${base}/api/answer?taskId=t1&session=s1&wait=30`, { signal: ctrl.signal }).catch(() => {});
  await new Promise(r => setTimeout(r, 200));
  ctrl.abort();
  await poll;
  await new Promise(r => setTimeout(r, 100));
}

async function openQuestion(page) {
  await postState({ step: 2, status: 'in_progress', activeStep: 2, progress: 20,
    currentOperation: 'Exploring the project', logEntry: 'Project explored' });
  await postState({ step: 2, question: { id: 'q1', text: 'Ile ról?', options: ['Dwie', 'Trzy'] } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
}

test('pytanie agenta stoi nad logiem kroku, nie zamiast niego', async ({ page }) => {
  await openQuestion(page);
  await expect(page.locator('#gate .gate-question')).toHaveText('Ile ról?');
  await expect(page.locator('#log')).toContainText('Project explored');
  await expect(page.locator('#op')).toContainText('Waiting for your answer');
});

test('kliknięta opcja od razu zdejmuje pytanie, log zostaje', async ({ page }) => {
  await openQuestion(page);
  await page.click('[data-opt="1"]');
  await page.click('#confirmOk');
  await expect(page.locator('#gate')).toHaveCount(0);
  await expect(page.locator('#log')).toContainText('Project explored');
  await expect(page.locator('#log')).toContainText('q1: Trzy');
  await expect(page.locator('#op')).toContainText('Processing answer…');
  expect(await takeAnswer()).toMatchObject({ kind: 'answer', questionId: 'q1', value: 'Trzy' });
});

test('Send odpowiedzi czeka na tekst albo obrazek', async ({ page }) => {
  await openQuestion(page);
  const send = page.locator('#send');
  await expect(send).toBeDisabled();
  await page.fill('#freeAnswer', '   ');
  await expect(send).toBeDisabled();
  await page.fill('#freeAnswer', 'Cztery');
  await expect(send).toBeEnabled();
  await page.fill('#freeAnswer', '');
  await expect(send).toBeDisabled();
  await page.setInputFiles('[data-attach-input="answer"]',
    [{ name: 'role.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(send).toBeEnabled();
});

test('Send uwag do planu czeka na tekst, Approve nie', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan na trzy zadania' } });
  await page.goto(base);
  await page.waitForSelector('#feedback');
  await expect(page.locator('#approve')).toBeEnabled();
  await expect(page.locator('#sendFeedback')).toBeDisabled();
  await page.fill('#feedback', 'Rozbij zadanie 2');
  await expect(page.locator('#sendFeedback')).toBeEnabled();
});

test('ryzyka planu stoją w "Critical information" nad podsumowaniem', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2, reviewSummary: {
    text: 'Plan na jedenaście zadań',
    critical: ['Zgodność Angular 20 i jest-preset-angular 15 w zoneless',
      'Zadanie 11: implementujący używa wyłącznie pętli @for'] } });
  await page.goto(base);
  const critical = page.locator('#gate .critical');
  await expect(critical.locator('h3')).toHaveText('Critical information');
  await expect(critical.locator('li')).toHaveText([
    'Zgodność Angular 20 i jest-preset-angular 15 w zoneless',
    'Zadanie 11: implementujący używa wyłącznie pętli @for']);
  // Pierwsza rzecz na bramie: Approve nie da się kliknąć, nie mijając jej.
  await expect(page.locator('#gate > :first-child')).toHaveClass('critical');
  await expect(page.locator('.summary-text')).toHaveText('Plan na jedenaście zadań');
});

test('ryzyko podane jednym tekstem też trafia do "Critical information"', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan', critical: 'Możliwy brak crypto.randomUUID w jsdom' } });
  await page.goto(base);
  await expect(page.locator('#gate .critical li')).toHaveText(['Możliwy brak crypto.randomUUID w jsdom']);
});

test('plan bez ryzyk nie pokazuje pustej sekcji', async ({ page }) => {
  await postState({ step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan', critical: ['', '  '] } });
  await page.goto(base);
  await expect(page.locator('.summary-text')).toHaveText('Plan');
  await expect(page.locator('.critical')).toHaveCount(0);
  await postState({ step: 2, reviewSummary: { text: 'Plan bez pola critical' } });
  await expect(page.locator('.summary-text')).toHaveText('Plan bez pola critical');
  await expect(page.locator('.critical')).toHaveCount(0);
});

test('róg strony pokazuje zużycie, limity, model, effort i kontekst orkiestratora', async ({ page }) => {
  usage = { relay: true, asOf: new Date().toISOString(), model: 'Opus 5.5', effort: 'max',
    tokens: { input: 1200000, output: 34000 }, costUsd: 12.5,
    context: { usedPct: 41, used: 82000, size: 200000 },
    fiveHour: { usedPct: 73, resetsAt: null }, weekly: { usedPct: 12, resetsAt: null } };
  await page.goto(base);
  const chip = label => chipOf(page, label);
  await expect(chip('Tokens').locator('b')).toHaveText('1.23M');
  await expect(chip('5h').locator('b')).toHaveText('73%');
  await expect(chip('5h').locator('.meter > span')).toHaveClass('warm');
  await expect(chip('Week').locator('b')).toHaveText('12%');
  await expect(chip('Model').locator('b')).toHaveText('Opus 5.5');
  await expect(chip('Effort').locator('b')).toHaveText('max');
  await expect(chip('Context').locator('b')).toHaveText('41%');
  await expect(chip('Tokens')).toHaveAttribute('title', /1,200,000 input · 34,000 output · \$12\.50/);
});

test('bez status line\'u róg mówi, jak go podłączyć', async ({ page }) => {
  usage = { relay: false, effort: 'max', relayScript: 'D:/skill/scripts/statusline-relay.cjs' };
  await page.goto(base);
  await expect(page.locator('#usage .chip.off')).toHaveText('Usage: connect the status line');
  await expect(page.locator('#usage .chip.off'))
    .toHaveAttribute('title', /node "D:\/skill\/scripts\/statusline-relay\.cjs" <your status line command>/);
  await expect(chipOf(page, 'Effort').locator('b')).toHaveText('max');
});

test('bez zużycia i bez orkiestratora róg znika', async ({ page }) => {
  await stopApp();
  await startApp({ starterSession: null });
  await page.goto(base);
  await page.waitForSelector('.step');
  await expect(page.locator('#usage')).toBeHidden();
});

test('róg zaczyna się od orkiestratora aktywnego taska; działający nie ma "Open session"', async ({ page }) => {
  await page.goto(base);
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('working');
  await expect(chipOf(page, 'Orchestrator').locator('.dot')).toHaveClass('dot working');
  await expect(page.locator('#openSession')).toHaveCount(0);
  const poll = fetch(`${base}/api/answer?taskId=t1&session=s1&wait=3`).then(r => r.json());
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('listening');
  await poll;
});

test('zamknięty orkiestrator: "Open session" bez terminala daje komendę do skopiowania', async ({ page }) => {
  await closeOrchestrator();
  await page.goto(base);
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('closed');
  await page.click('#openSession');
  const dlg = page.locator('#sessionDialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('#sessionWhy')).toContainText('this server opens no terminals');
  await expect(dlg.locator('#sessionCommand'))
    .toHaveText(`claude "/doh:implementNewFeature --attach t1 --port ${app.server.address().port}"`);
  await expect(dlg.locator('#sessionCwd')).toContainText(process.cwd());
  await dlg.getByRole('button', { name: 'Copy command' }).click();
  await expect(dlg.locator('#sessionCopy')).toHaveText('Copied');
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(dlg).toBeHidden();
  // Przycisk wraca: nic się nie otworzyło.
  await expect(page.locator('#openSession')).toBeEnabled();
});

test('"Open session" otwiera terminal przez serwer, a róg czeka na nową sesję', async ({ page }) => {
  const launched = [];
  await stopApp();
  await startApp({ launchOrchestrator: async args => {
    launched.push(args);
    return { launched: true, command: 'claude', cwd: args.project };
  } });
  await closeOrchestrator();
  await page.goto(base);
  await page.click('#openSession');
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('starting…');
  await expect(page.locator('#openSession')).toHaveCount(0);
  await expect(page.locator('#sessionDialog')).toBeHidden();
  expect(launched.map(a => a.taskId)).toEqual(['t1']);
  // Sesja nowego terminala zgłasza się pollem i przejmuje task.
  const poll = fetch(`${base}/api/answer?taskId=t1&session=s2&wait=3`).then(r => r.json());
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('listening');
  await poll;
  await expect(chipOf(page, 'Orchestrator').locator('b')).toHaveText('working');
});
