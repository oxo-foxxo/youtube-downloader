#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeWithDocker } from './lib/probe-media.mjs';

const args = parseArgs(process.argv.slice(2));
const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const tempRoot = await mkdtemp(join(tmpdir(), 'youtube-downloader-smoke-'));
let jobId;

try {
  const health = await getJson(`${baseUrl}/health`);
  if (health.status !== 'ok' && health.status !== 'degraded')
    throw new Error('Сервис не готов к smoke-проверке');

  const info = await postJson(`${baseUrl}/api/inspect`, { url: args.url });
  const variant = info.variants?.find((item) => item.height === args.height);
  const option = variant?.containers?.find((item) => item.container === args.container);
  if (!option?.available)
    throw new Error(
      `У видео нет доступного варианта ${args.height}p ${args.container.toUpperCase()}`,
    );

  const job = await postJson(`${baseUrl}/api/jobs`, {
    url: args.url,
    height: args.height,
    container: args.container,
  });
  jobId = job.id;
  const ready = await waitForJob(baseUrl, job.id, 15 * 60_000);
  if (ready.state !== 'ready') {
    throw new Error(
      `Задача завершилась со статусом ${ready.state}${ready.errorCode ? ` (${ready.errorCode})` : ''}`,
    );
  }

  const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(job.id)}/file`);
  if (!response.ok) throw new Error(`Не удалось получить файл: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('Сервис вернул пустой файл');
  const outputPath = join(tempRoot, `smoke.${args.container}`);
  await writeFile(outputPath, bytes);

  const probe = await probeWithDocker(bytes);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video || video.height !== args.height)
    throw new Error(`FFprobe не подтвердил видеодорожку ${args.height}p`);
  if (!audio) throw new Error('FFprobe не обнаружил аудиодорожку');

  console.log(
    `OK: ${info.title} — ${args.height}p ${args.container.toUpperCase()}, ${bytes.length} байт`,
  );
} finally {
  if (jobId) {
    await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  await rm(tempRoot, { recursive: true, force: true });
}

function parseArgs(values) {
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--height' || values[index] === '--container') {
      index += 1;
      continue;
    }
    positional.push(values[index]);
  }
  const [url] = positional;
  const height = Number(valueAfter(values, '--height'));
  const container = valueAfter(values, '--container');
  if (
    positional.length !== 1 ||
    !url ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !['mp4', 'mov'].includes(container)
  ) {
    throw new Error(
      'Использование: pnpm run smoke:youtube -- <public-url> --height <number> --container <mp4|mov>',
    );
  }
  return { url, height, container };
}

function valueAfter(values, flag) {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

async function getJson(url) {
  const response = await fetch(url);
  return readJson(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

async function waitForJob(base, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJson(`${base}/api/jobs/${encodeURIComponent(id)}`);
    if (['ready', 'failed', 'cancelled', 'expired'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Smoke-загрузка не завершилась за 15 минут');
}
