import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

const successUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const staleFormatUrl = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const providersFailUrl = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';

test('inspects, selects exact MOV quality, reports progress, and downloads the fixture', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ссылка на YouTube').fill(successUrl);
  await page.getByRole('button', { name: 'Проверить' }).click();

  await expect(page.getByRole('heading', { name: 'Детерминированное тестовое видео' })).toBeVisible();
  await page.getByLabel('Разрешение').selectOption('720');
  await page.getByLabel('MOV').check();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать', exact: true }).click();
  await expect(page.getByText('Скачиваем тестовое видео')).toBeVisible();
  await expect(page.getByText('Объединяем тестовые дорожки')).toBeVisible();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('dQw4w9WgXcQ-720.mov');
  expect(await readFile(await download.path() as string, 'utf8')).toBe('fixture-video-content');
  await expect(page.getByRole('button', { name: 'Скачать файл ещё раз' })).toBeVisible();
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
