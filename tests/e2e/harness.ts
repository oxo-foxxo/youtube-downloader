import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../../src/server/app.js';
import { AppError } from '../../src/server/domain/errors.js';
import { DownloadQueue } from '../../src/server/jobs/queue.js';
import { JobStore } from '../../src/server/jobs/store.js';
import type {
  DownloadRequest,
  DownloadResult,
  ProgressCallback,
  SourceAdapter,
  VideoInfo,
} from '../../src/shared/contracts.js';

const workRoot = await mkdtemp(join(tmpdir(), 'youtube-downloader-e2e-'));
const store = new JobStore();
const inspectionCounts = new Map<string, number>();

function fixtureInfo(canonicalUrl: string, staleMov = false): VideoInfo {
  const videoId = new URL(canonicalUrl).searchParams.get('v') as string;
  return {
    videoId,
    canonicalUrl,
    title: 'Детерминированное тестовое видео',
    durationSeconds: 42,
    variants: [
      {
        height: 1080,
        width: 1920,
        fps: 30,
        hdr: false,
        videoCodec: 'h264',
        audioCodec: 'aac',
        containers: [
          { container: 'mp4', available: true },
          {
            container: 'mov',
            available: !staleMov,
            ...(staleMov ? { reason: 'Формат исчез' } : {}),
          },
        ],
      },
      {
        height: 720,
        width: 1280,
        fps: 30,
        hdr: false,
        videoCodec: 'h264',
        audioCodec: 'aac',
        containers: [
          { container: 'mp4', available: true },
          { container: 'mov', available: true },
        ],
      },
    ],
  };
}

const executor = {
  async inspectVideo(canonicalUrl: string): Promise<VideoInfo> {
    const videoId = new URL(canonicalUrl).searchParams.get('v') as string;
    if (videoId === 'bbbbbbbbbbb')
      throw new AppError('PROVIDER_FAILURE', true, undefined, 'fake', 'e2e-correlation');
    const count = (inspectionCounts.get(videoId) ?? 0) + 1;
    inspectionCounts.set(videoId, count);
    return fixtureInfo(canonicalUrl, videoId === 'aaaaaaaaaaa' && count > 1);
  },
  async downloadVideo(
    _request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<DownloadResult> {
    await wait(120, signal);
    onProgress({ state: 'downloading', message: 'Скачиваем тестовое видео', percent: 35 });
    await wait(180, signal);
    onProgress({ state: 'merging', message: 'Объединяем тестовые дорожки', percent: 90 });
    await wait(180, signal);
    await writeFile(destination, 'fixture-video-content');
    return { provider: 'fake', filePath: destination, sizeBytes: 21 };
  },
};

const queue = new DownloadQueue({ store, executor, workRoot, retentionMs: 60_000 });
queue.start();
const healthAdapter = {
  name: 'fake',
  download: executor.downloadVideo,
  health: async () => ({ healthy: true }),
} as SourceAdapter;
const app = buildApp({
  store,
  queue,
  orchestrator: executor,
  adapters: [healthAdapter],
  rateLimitMax: 1_000,
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await queue.stop();
  await app.close();
  await rm(workRoot, { recursive: true, force: true });
}

process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
await app.listen({ host: '127.0.0.1', port: 4173 });

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AppError('CANCELLED', false));
      },
      { once: true },
    );
  });
}
