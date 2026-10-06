import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

const successUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const staleFormatUrl = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const providersFailUrl = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';

test('inspects, selects exact MOV quality, reports progress, and downloads the fixture', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Ссылка на YouTube').fill(successUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();

  await expect(
    page.getByRole('heading', { name: 'Детерминированное тестовое видео' }),
  ).toBeVisible();
  await page.getByLabel('Разрешение').selectOption('720');
  await page.getByLabel('MOV').check();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  await expect(page.getByText('Скачиваем тестовое видео')).toBeVisible();
  await expect(page.getByText('Объединяем тестовые дорожки')).toBeVisible();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('dQw4w9WgXcQ-720.mov');
  expect(await readFile((await download.path()) as string, 'utf8')).toBe('fixture-video-content');
  await expect(page.getByText('Файл готов')).toBeVisible();
  const repeatedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать ещё раз' }).click();
  expect((await repeatedDownload).suggestedFilename()).toBe('dQw4w9WgXcQ-720.mov');
});

test('shows a stale exact-format error returned when the job is created', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ссылка на YouTube').fill(staleFormatUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByLabel('MOV').check();
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Выбранный формат больше недоступен');
});

test('shows a safe error when every provider fails', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ссылка на YouTube').fill(providersFailUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();

  await expect(page.getByRole('alert')).toHaveText('Не удалось подготовить файл');
});

test('keeps multiple downloads in the list and delivers both files', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ссылка на YouTube').fill(successUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByLabel('Разрешение')).toBeVisible();
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', (download) => downloads.push(download));
  const existing = await page.locator('.job-item').count();
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Скачать', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  await expect(page.locator('.job-item')).toHaveCount(existing + 2);
  await expect.poll(() => downloads.length).toBe(2);
  for (const download of downloads)
    expect(await readFile((await download.path()) as string, 'utf8')).toBe('fixture-video-content');
  await page.getByRole('button', { name: 'Ваши загрузки' }).click();
  await expect(page.locator('.job-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ваши загрузки' }).click();
  await expect(page.locator('.job-item')).toHaveCount(existing + 2);
  await page.getByRole('button', { name: 'Очистить завершённые' }).click();
  await expect(page.getByRole('button', { name: 'Ваши загрузки' })).toHaveCount(0);
});

test('opens the login dialog, returns focus on Escape, and confirms the session', async ({
  page,
}) => {
  await page.route('**/api/session**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: path.endsWith('/open')
        ? { ready: true }
        : { state: path.endsWith('/confirm') ? 'connected' : 'disconnected' },
    });
  });
  await page.route('**/login/vnc.html?*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body>Тестовое окно входа</body></html>',
    }),
  );
  await page.goto('/');
  const login = page.getByRole('button', { name: 'Войти в YouTube' });
  await login.click();
  await expect(page.getByRole('dialog', { name: 'Вход в YouTube' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(login).toBeFocused();
  await login.click();
  await page.getByRole('button', { name: 'Я вошёл' }).click();
  await expect(page.getByText('YouTube подключён')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps the form and author signature usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByLabel('Ссылка на YouTube')).toBeVisible();
  await expect(page.getByText('Реализовано Шевелевым Александром Максимовичем')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel('Ссылка на YouTube').fill(successUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByLabel('Разрешение')).toBeVisible();
  await page.getByLabel('MOV').check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
