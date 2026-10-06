import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/server/domain/errors.js';
import { JobStore } from '../../src/server/jobs/store.js';
import { buildApp } from '../../src/server/app.js';
import type { DownloadRequest, SourceAdapter, VideoInfo } from '../../src/shared/contracts.js';

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const request: DownloadRequest = { videoId: 'dQw4w9WgXcQ', canonicalUrl: url, height: 1080, container: 'mp4' };
const info: VideoInfo = {
  videoId: request.videoId,
  canonicalUrl: url,
  title: 'Video / title',
  durationSeconds: 42,
  variants: [{ height: 1080, hdr: false, videoCodec: 'h264', audioCodec: 'aac', containers: [{ container: 'mp4', available: true }, { container: 'mov', available: false, reason: 'Нет совместимых дорожек' }] }],
};

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup(overrides: { inspect?: (canonicalUrl: string, signal: AbortSignal) => Promise<VideoInfo>; health?: SourceAdapter[] } = {}) {
  const store = new JobStore();
  const queue = {
    enqueue: vi.fn(async (jobRequest: DownloadRequest) => store.create(jobRequest)),
    cancel: vi.fn(async () => undefined),
  };
  const orchestrator = { inspectVideo: vi.fn(overrides.inspect ?? (async () => info)) };
  const app = buildApp({ store, queue, orchestrator, adapters: overrides.health ?? [], bodyLimit: 16 * 1024, rateLimitMax: 100 });
  apps.push(app);
  return { app, store, queue, orchestrator };
}

describe('HTTP API', () => {
  it('validates and inspects a canonical YouTube URL', async () => {
    const { app, orchestrator } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/inspect', payload: { url: `  ${url}&list=PL123  ` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ videoId: request.videoId, title: 'Video / title' });
    expect(orchestrator.inspectVideo).toHaveBeenCalledWith(url, expect.any(AbortSignal));
  });

  it('rejects invalid URLs and oversized JSON', async () => {
    const { app } = setup();
    const invalid = await app.inject({ method: 'POST', url: '/api/inspect', payload: { url: 'https://example.com/video' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_URL' } });
    const oversized = await app.inject({ method: 'POST', url: '/api/inspect', payload: { url: `https://youtube.com/watch?v=${'x'.repeat(20_000)}` } });
    expect(oversized.statusCode).toBe(413);
  });

  it('creates a job only for an inspected exact resolution and container', async () => {
    const { app, queue } = setup();
    const accepted = await app.inject({ method: 'POST', url: '/api/jobs', payload: { url, height: 1080, container: 'mp4' } });
    expect(accepted.statusCode).toBe(202);
    expect(queue.enqueue).toHaveBeenCalledWith(request);
    const rejected = await app.inject({ method: 'POST', url: '/api/jobs', payload: { url, height: 720, container: 'mp4' } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: 'FORMAT_UNAVAILABLE' } });
  });

  it('returns job status without exposing its filesystem path', async () => {
    const { app, store } = setup();
    const job = store.create(request);
    store.update(job.id, { state: 'downloading' });
    store.update(job.id, { state: 'ready', filePath: '/private/tmp/secret.mp4', filename: 'video.mp4' });
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: job.id, state: 'ready' });
    expect(response.body).not.toContain('/private/tmp');
  });

  it('emits a terminal SSE event and heartbeat-compatible headers', async () => {
    const { app, store } = setup();
    const job = store.create(request);
    store.update(job.id, { state: 'cancelled' });
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/events` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(response.body).toContain('event: progress');
    expect(response.body).toContain('"state":"cancelled"');
  });

  it('streams a ready file with a lease and expires it after successful transfer', async () => {
    const { app, store } = setup();
    const root = await mkdtemp(join(tmpdir(), 'api-file-'));
    const filePath = join(root, 'video.mp4');
    await writeFile(filePath, 'video-bytes');
    const job = store.create(request);
    store.update(job.id, { state: 'downloading' });
    store.update(job.id, { state: 'ready', filePath, filename: '../unsafe\nname.mp4' });
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/file` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('video-bytes');
    expect(response.headers['content-disposition']).not.toContain('..');
    expect(store.get(job.id)?.state).toBe('expired');
    expect(store.getLeaseCount(job.id)).toBe(0);
  });

  it('cancels a job and reports not-ready and missing files', async () => {
    const { app, store, queue } = setup();
    const job = store.create(request);
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/file` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/jobs/missing/file' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
    expect(queue.cancel).toHaveBeenCalledWith(job.id);
  });

  it('returns stable error codes, correlation IDs, and degraded health', async () => {
    const down = { name: 'cobalt', health: vi.fn().mockResolvedValue({ healthy: false, detail: 'down' }) } as unknown as SourceAdapter;
    const { app } = setup({
      inspect: async () => { throw new AppError('LOGIN_REQUIRED', false, undefined, 'yt-dlp', 'corr-123'); },
      health: [down],
    });
    const failure = await app.inject({ method: 'POST', url: '/api/inspect', payload: { url } });
    expect(failure.statusCode).toBe(422);
    expect(failure.json()).toEqual({ error: { code: 'LOGIN_REQUIRED', message: 'Видео недоступно без входа в аккаунт', correlationId: 'corr-123' } });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'degraded', providers: { cobalt: { healthy: false } } });
  });
});
