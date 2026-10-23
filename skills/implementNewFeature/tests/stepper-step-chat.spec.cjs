// Testy UI steppera implementNewFeature — czat z agentem na krokach, które nie mają
// własnej bramki: wiadomość leci do agenta kroku, jego odpowiedź dopisuje się bez
// przerysowania panelu, a krok, na którym nikt już nie pracuje, jest tylko do czytania.
// Własną wiadomość da się usunąć ×, póki krok żyje — agent dostaje o tym znać.
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

const nextAnswer = () => fetch(`${base}/api/answer?wait=5`).then(r => r.json());
const answer = body => fetch(`${base}/api/answer`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 't1', ...body })
});
// Linia użytkownika w rozmowie kroku, zdjęta z kolejki, jakby orkiestrator już ją przekazał.
const say = async (step, text) => {
  await answer({ kind: 'message', step, text });
  await nextAnswer();
};
const middle = async (page, sel) => {
  const box = await page.locator(sel).boundingBox();
  return box.y + box.height / 2;
};

test.beforeEach(async () => {
  app = createApp(fs.mkdtempSync(path.join(os.tmpdir(), 'inf-chat-')));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await state({ step: 1, status: 'completed' });
  await state({ step: 4, status: 'in_progress', activeStep: 4, progress: 40,
    currentOperation: 'Task 2/5' });
});

test.afterEach(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  await new Promise(r => app.server.close(r));
});

test('wiadomość z kroku bez bramki trafia do agenta tego kroku', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  const waiting = nextAnswer();
  await page.fill('#stepMessage', 'Pomiń cache, zrób to synchronicznie');
  await page.click('#sendStepMessage');
  const { answer } = await waiting;
  expect(answer.kind).toBe('message');
  expect(answer.step).toBe(4);
  expect(answer.taskId).toBe('t1');
  expect(answer.text).toBe('Pomiń cache, zrób to synchronicznie');
  // Wiadomość widać od razu, a pole jest puste na następną.
  await expect(page.locator('#stepChat .msg.user')).toHaveText(
    /Pomiń cache, zrób to synchronicznie/);
  await expect(page.locator('#stepMessage')).toHaveValue('');
});

test('Ctrl+Enter wysyła, pusta wiadomość nie', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  // pusto — nie ma czego wysyłać: przycisk stoi wyłączony, a Ctrl+Enter nic nie wysyła
  await expect(page.locator('#sendStepMessage')).toBeDisabled();
  await page.locator('#stepMessage').press('Control+Enter');
  expect((await (await fetch(`${base}/api/answer`)).json()).answer).toBe(null);
  const waiting = nextAnswer();
  await page.fill('#stepMessage', 'Użyj istniejącego repozytorium');
  await page.locator('#stepMessage').press('Control+Enter');
  expect((await waiting).answer.text).toBe('Użyj istniejącego repozytorium');
});

test('odpowiedź agenta dopisuje się, nie zjadając tego, co wpisane', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  await page.fill('#stepMessage', 'jeszcze niewysłane');
  await state({ step: 4, chat: { role: 'agent', text: 'Jasne — robię bez cache.' } });
  await expect(page.locator('#stepChat .msg.agent')).toHaveText(/Jasne — robię bez cache/);
  await expect(page.locator('#stepMessage')).toHaveValue('jeszcze niewysłane');
});

test('krok, na którym nikt już nie pracuje, pokazuje czat bez composera', async ({ page }) => {
  await state({ step: 2, status: 'completed',
    chat: { role: 'user', text: 'Trzymaj się istniejącego API' } });
  await page.goto(base);
  await page.waitForSelector('.stepper .step[data-step="2"]');
  await page.locator('.step[data-step="2"]').click();
  await expect(page.locator('#stepChat .msg.user')).toHaveText(/Trzymaj się istniejącego API/);
  await expect(page.locator('#stepMessage')).toHaveCount(0);
});

test('krok, który padł, wciąż przyjmuje wiadomość — pójdzie z ponowieniem', async ({ page }) => {
  await state({ step: 4, status: 'failed', report: 'npm test wywalił się na 3 testach' });
  await page.goto(base);
  await page.waitForSelector('#retry');
  const waiting = nextAnswer();
  await page.fill('#stepMessage', 'Zainstaluj zależności przed testami');
  await page.click('#sendStepMessage');
  const { answer } = await waiting;
  expect(answer.kind).toBe('message');
  expect(answer.step).toBe(4);
});

test('panel z własnym polem odpowiedzi nie dostaje drugiego', async ({ page }) => {
  await state({ step: 4, status: 'completed' });
  await state({ step: 2, status: 'in_progress', activeStep: 2,
    question: { id: 'q1', text: 'Czy zaproszenie wygasa?' } });
  await page.goto(base);
  await page.waitForSelector('#freeAnswer');
  await expect(page.locator('#stepMessage')).toHaveCount(0);
});

test('czat mockupów to ten sam czat kroku 3', async ({ page }) => {
  await state({ step: 3, enabled: true });
  await state({ step: 4, status: 'waiting' });
  await state({ step: 3, status: 'in_progress', activeStep: 3,
    mockupReview: { text: 'Dwa ekrany', screens: [] },
    mockupChat: { role: 'agent', text: 'Dwa ekrany' } });
  await page.goto(base);
  await page.waitForSelector('#mockupFeedback');
  await expect(page.locator('#stepChat .msg.agent')).toHaveText(/Dwa ekrany/);
  await page.fill('#mockupFeedback', 'Szerszy przycisk');
  await page.click('#sendMockup');
  await expect(page.locator('#stepChat .msg.user')).toHaveText(/Szerszy przycisk/);
});

test('× usuwa własną wiadomość z rozmowy, a agent dostaje o tym znać', async ({ page }) => {
  await say(4, 'Dodaj eksport do CSV');
  await state({ step: 4, chat: { role: 'agent', text: 'Robię eksport' } });
  await say(4, 'I import');
  await page.goto(base);
  await expect(page.locator('#stepChat .msg')).toHaveCount(3);
  // Linia agenta nie jest użytkownika do cofnięcia.
  await expect(page.locator('#stepChat .msg.agent .rm')).toHaveCount(0);
  await expect(page.locator('#stepChat .msg.user .rm')).toHaveCount(2);
  const first = page.locator('#stepChat .msg.user').first();
  await first.locator('.rm').click();
  await expect(page.locator('#confirmTitle')).toHaveText('Delete this message?');
  await page.click('#confirmCancel');
  expect((await (await fetch(`${base}/api/answer`)).json()).answer).toBe(null);
  await first.locator('.rm').click();
  await page.click('#confirmOk');
  expect((await nextAnswer()).answer).toEqual({ kind: 'delete', step: 4, id: 1,
    text: 'Dodaj eksport do CSV', taskId: 't1' });
  await expect(page.locator('#stepChat .msg')).toHaveText([/Robię eksport/, /I import/]);
  await expect(page.locator('#stepMessage')).toBeVisible();
});

test('na kroku, na którym nikt już nie pracuje, wiadomości nie da się usunąć', async ({ page }) => {
  await state({ step: 2, status: 'completed',
    chat: { role: 'user', text: 'Trzymaj się istniejącego API' } });
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  await page.locator('.step[data-step="2"]').click();
  await expect(page.locator('#stepChat .msg.user')).toHaveText(/Trzymaj się istniejącego API/);
  await expect(page.locator('#stepChat .rm')).toHaveCount(0);
});

test('usunięta linia i nowa w jednym odświeżeniu: czat pokazuje dokładnie to, co serwer', async ({ page }) => {
  await say(4, 'Dodaj eksport');
  await state({ step: 4, chat: { role: 'agent', text: 'Robię eksport' } });
  // Zegar strony stoi, więc obie zmiany trafiają do tego samego odświeżenia - liczba linii
  // się nie zmienia, zmieniają się same linie.
  await page.clock.install();
  await page.goto(base);
  await expect(page.locator('#stepChat .msg')).toHaveCount(2);
  await answer({ kind: 'delete', step: 4, id: 1 });
  await state({ step: 4, chat: { role: 'agent', text: 'Bez eksportu' } });
  await page.clock.runFor(1000);
  await expect(page.locator('#stepChat .msg')).toHaveText([/Robię eksport/, /Bez eksportu/]);
});

test('przyciski composera stoją na środku pola, także gdy pole urośnie', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#stepMessage');
  const level = async (field, button) =>
    expect(Math.abs(await middle(page, button) - await middle(page, field))).toBeLessThanOrEqual(1);
  await level('#stepMessage', '#sendStepMessage');
  await page.fill('#stepMessage', 'a\nb\nc\nd\ne');
  await level('#stepMessage', '#sendStepMessage');
  // Composer makiet ma jeszcze spinacz do obrazków.
  await state({ step: 3, enabled: true });
  await state({ step: 4, status: 'waiting' });
  await state({ step: 3, status: 'in_progress', activeStep: 3,
    mockupReview: { text: 'Dwa ekrany', screens: [] } });
  await page.waitForSelector('#mockupFeedback');
  await level('#mockupFeedback', '#sendMockup');
  await level('#mockupFeedback', '[data-attach="mockup"]');
});
