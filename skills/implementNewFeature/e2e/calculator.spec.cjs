const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const url = pathToFileURL(path.join(__dirname, '..', '..', '..', 'calculator.html')).href;

const btn = (page, name) => page.getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto(url);
});

test('stan początkowy: wyświetlacz pokazuje 0', async ({ page }) => {
  await expect(page.locator('#display')).toHaveText('0');
});

test('widoczne wszystkie 14 przycisków', async ({ page }) => {
  const labels = ['0','1','2','3','4','5','6','7','8','9','+','-','=','C'];
  for (const label of labels) {
    await expect(btn(page, label)).toBeVisible();
  }
});

test('kontener kalkulatora ma błękitne tło #90caf9', async ({ page }) => {
  await expect(page.locator('.calculator')).toHaveCSS(
    'background-color',
    'rgb(144, 202, 249)'
  );
});

test('cyfry doklejają się do liczby', async ({ page }) => {
  await btn(page, '1').click();
  await btn(page, '2').click();
  await btn(page, '3').click();
  await expect(page.locator('#display')).toHaveText('123');
});

test('pierwsza cyfra zastępuje zero wiodące', async ({ page }) => {
  await btn(page, '0').click();
  await btn(page, '0').click();
  await btn(page, '7').click();
  await expect(page.locator('#display')).toHaveText('7');
});

test('limit 12 cyfr — nadmiarowe naciśnięcia ignorowane', async ({ page }) => {
  for (let i = 0; i < 14; i++) {
    await btn(page, '9').click();
  }
  await expect(page.locator('#display')).toHaveText('9'.repeat(12));
});

test('C resetuje wyświetlacz do 0', async ({ page }) => {
  await btn(page, '5').click();
  await btn(page, '8').click();
  await btn(page, 'C').click();
  await expect(page.locator('#display')).toHaveText('0');
});

async function press(page, sequence) {
  for (const key of sequence) {
    await btn(page, key).click();
  }
}

test('dodawanie: 12 + 34 = 46', async ({ page }) => {
  await press(page, ['1', '2', '+', '3', '4', '=']);
  await expect(page.locator('#display')).toHaveText('46');
});

test('odejmowanie z wynikiem ujemnym: 12 - 30 = -18', async ({ page }) => {
  await press(page, ['1', '2', '-', '3', '0', '=']);
  await expect(page.locator('#display')).toHaveText('-18');
});

test('= bez operatora nie zmienia stanu', async ({ page }) => {
  await press(page, ['5', '=']);
  await expect(page.locator('#display')).toHaveText('5');
  await press(page, ['3']);
  await expect(page.locator('#display')).toHaveText('53');
});

test('= bez drugiej liczby to no-op', async ({ page }) => {
  await press(page, ['5', '+', '=']);
  await expect(page.locator('#display')).toHaveText('5');
  await press(page, ['3', '=']);
  await expect(page.locator('#display')).toHaveText('8');
});

test('drugi operator przed cyfrą zastępuje pierwszy', async ({ page }) => {
  await press(page, ['5', '+', '-', '3', '=']);
  await expect(page.locator('#display')).toHaveText('2');
});

test('operator w trakcie drugiej liczby jest ignorowany (brak łańcucha)', async ({ page }) => {
  await press(page, ['2', '+', '3', '-', '=']);
  await expect(page.locator('#display')).toHaveText('5');
});

test('cyfra po = zaczyna nowe działanie', async ({ page }) => {
  await press(page, ['2', '+', '3', '=', '7', '+', '1', '=']);
  await expect(page.locator('#display')).toHaveText('8');
});

test('operator po = używa wyniku jako pierwszego operandu', async ({ page }) => {
  await press(page, ['2', '+', '3', '=', '-', '1', '=']);
  await expect(page.locator('#display')).toHaveText('4');
});

test('C w trakcie działania kasuje operand i operator', async ({ page }) => {
  await press(page, ['9', '+', '1', 'C', '2', '+', '2', '=']);
  await expect(page.locator('#display')).toHaveText('4');
});
