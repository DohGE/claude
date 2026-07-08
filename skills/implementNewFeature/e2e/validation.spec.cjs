// Testy walidacyjne (pipeline implementNewFeature) — R3 i R4: tło strony i układ siatki.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const url = pathToFileURL(path.join(__dirname, '..', '..', '..', 'calculator.html')).href;

test.beforeEach(async ({ page }) => {
  await page.goto(url);
});

test('R3: strona ma jasnoniewieskie tło #e3f2fd', async ({ page }) => {
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(227, 242, 253)');
});

test('R4: wyświetlacz jest nad siatką przycisków', async ({ page }) => {
  const display = await page.locator('#display').boundingBox();
  const keys = await page.locator('.keys').boundingBox();
  expect(display.y + display.height).toBeLessThanOrEqual(keys.y);
});

test('R4: siatka 4 kolumn, kolejność 7 8 9 C / 4 5 6 + / 1 2 3 - / 0 =', async ({ page }) => {
  await expect(page.locator('.keys')).toHaveCSS('display', 'grid');
  const cols = await page
    .locator('.keys')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(4);
  const labels = await page.locator('.keys button').allTextContents();
  expect(labels).toEqual(['7', '8', '9', 'C', '4', '5', '6', '+', '1', '2', '3', '-', '0', '=']);
});

test('R4: przycisk 0 zajmuje szerokość 3 kolumn', async ({ page }) => {
  const zero = await page.getByRole('button', { name: '0', exact: true }).boundingBox();
  const seven = await page.getByRole('button', { name: '7', exact: true }).boundingBox();
  expect(zero.width).toBeGreaterThan(seven.width * 2.5);
});

test('Weryfikacja kompletna schematu kolorystycznego - wszystkie kolory zmienione na niebieski', async ({ page }) => {
  // Body background
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(227, 242, 253)');
  // Calculator background
  await expect(page.locator('.calculator')).toHaveCSS('background-color', 'rgb(144, 202, 249)');
  // Display background
  await expect(page.locator('#display')).toHaveCSS('background-color', 'rgb(243, 246, 253)');
  // Display border
  await expect(page.locator('#display')).toHaveCSS('border-color', 'rgb(100, 181, 246)');
  // Regular button background
  const regularBtn = page.getByRole('button', { name: '1', exact: true });
  await expect(regularBtn).toHaveCSS('background-color', 'rgb(243, 246, 253)');
  // Operator button background
  const opBtn = page.getByRole('button', { name: '+', exact: true });
  await expect(opBtn).toHaveCSS('background-color', 'rgb(66, 165, 245)');
});

test('Stany button:hover dla przycisków zwykłych mają kolor #bbdefb', async ({ page }) => {
  const btn = page.getByRole('button', { name: '5', exact: true });
  await btn.hover();
  // Hover state: #bbdefb = rgb(187, 222, 251)
  await expect(btn).toHaveCSS('background-color', 'rgb(187, 222, 251)');
});

test('Stany button:hover dla przycisków operatora mają kolor #2196f3', async ({ page }) => {
  const btn = page.getByRole('button', { name: '+', exact: true });
  await btn.hover();
  // Operator hover state: #2196f3 = rgb(33, 150, 243)
  await expect(btn).toHaveCSS('background-color', 'rgb(33, 150, 243)');
});

test('Funkcjonalność pozostaje nienaruszona - brak błędów konsoli', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  // Wykonaj przykładowe działanie
  await page.getByRole('button', { name: '5', exact: true }).click();
  await page.getByRole('button', { name: '+', exact: true }).click();
  await page.getByRole('button', { name: '3', exact: true }).click();
  await page.getByRole('button', { name: '=', exact: true }).click();
  // Sprawdź brak błędów
  expect(errors).toHaveLength(0);
});
