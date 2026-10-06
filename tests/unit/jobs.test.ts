import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { DownloadQueue } from '../../src/server/jobs/queue.js';
import { JobStore } from '../../src/server/jobs/store.js';
import type { DownloadRequest } from '../../src/shared/contracts.js';

const request: DownloadRequest = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', height: 1080, container: 'mp4' };

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
  }
  assertion();
}

describe('JobStore', () => {
  it('enforces valid state transitions and publishes progress', () => {
    const store = new JobStore();
    const job = store.create(request);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(job.id, listener);

    store.update(job.id, { state: 'downloading', progress: { state: 'downloading', message: 'Загрузка', downloadedBytes: 10 } });

    expect(store.get(job.id)).toMatchObject({ state: 'downloading', progress: { downloadedBytes: 10 } });
    expect(store.get(job.id)?.progress).not.toHaveProperty('percent');
    expect(listener).toHaveBeenCalled();
    expect(() => store.update(job.id, { state: 'queued' })).toThrow(/transition/i);
    unsubscribe();
  });

  it('retains a ready file until the final lease is released', async () => {
    const store = new JobStore();
    const job = store.create(request);
    store.update(job.id, { state: 'downloading' });
    store.update(job.id, { state: 'ready', filePath: '/tmp/video.mp4', filename: 'video.mp4' });
    const first = store.acquireFileLease(job.id);
    const second = store.acquireFileLease(job.id);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    store.setExpiredFileCleanup(cleanup);

    store.update(job.id, { state: 'expired' });
    await first.release();
    expect(cleanup).not.toHaveBeenCalled();
    await second.release();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('DownloadQueue', () => {
  it('runs one download at a time in FIFO order and reports queue positions', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'queue-'));
    const store = new JobStore();
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const executor = { downloadVideo: vi.fn(async (jobRequest: DownloadRequest, destination: string) => {
      calls.push(jobRequest.videoId);
      await new Promise<void>((resolve) => releases.push(resolve));
      await writeFile(destination, 'file');
      return { provider: 'test', filePath: destination, sizeBytes: 4 };
    }) };
    const queue = new DownloadQueue({ store, executor, workRoot });
    queue.start();

    const first = await queue.enqueue(request);
    const second = await queue.enqueue({ ...request, videoId: 'aaaaaaaaaaa' });
    const third = await queue.enqueue({ ...request, videoId: 'bbbbbbbbbbb' });
    await eventually(() => expect(store.get(first.id)?.state).toBe('downloading'));
    expect(store.get(second.id)?.progress.queuePosition).toBe(1);
    expect(store.get(third.id)?.progress.queuePosition).toBe(2);
    expect(calls).toEqual([request.videoId]);

    releases.shift()?.();
    await eventually(() => expect(store.get(second.id)?.state).toBe('downloading'));
    expect(calls).toEqual([request.videoId, 'aaaaaaaaaaa']);
    releases.shift()?.();
    await eventually(() => expect(store.get(third.id)?.state).toBe('downloading'));
    releases.shift()?.();
    await eventually(() => expect(store.get(third.id)?.state).toBe('ready'));
  });

  it('cancels queued and active jobs', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'queue-cancel-'));
    const store = new JobStore();
    const executor = { downloadVideo: vi.fn(async (_request: DownloadRequest, _destination: string, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    }) };
    const queue = new DownloadQueue({ store, executor, workRoot });
    queue.start();
    const active = await queue.enqueue(request);
    const queued = await queue.enqueue({ ...request, videoId: 'aaaaaaaaaaa' });
    await eventually(() => expect(store.get(active.id)?.state).toBe('downloading'));

    await queue.cancel(queued.id);
    await queue.cancel(active.id);

    await eventually(() => expect(store.get(active.id)?.state).toBe('cancelled'));
    expect(store.get(queued.id)?.state).toBe('cancelled');
  });
});
