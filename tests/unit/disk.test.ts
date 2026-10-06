import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DiskGuard } from '../../src/server/jobs/disk.js';
import { DownloadQueue } from '../../src/server/jobs/queue.js';
import { JobStore } from '../../src/server/jobs/store.js';
import type { DownloadRequest } from '../../src/shared/contracts.js';

const request: DownloadRequest = {
  videoId: 'aaaaaaaaaaa',
  canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  height: 1080,
  container: 'mp4',
  estimatedSizeBytes: 1000,
};
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('reserves space for source tracks plus output, with a larger allowance for MOV', async () => {
  const disk = new DiskGuard('/unused', 100, async () => 2500);
  await expect(disk.check(request)).resolves.toBeUndefined();
  await expect(disk.check({ ...request, container: 'mov' })).rejects.toMatchObject({
    code: 'DISK_FULL',
  });
});

it('monitors space during download and stops checking after cleanup', async () => {
  vi.useFakeTimers();
  let free = 200;
  const callback = vi.fn();
  const disk = new DiskGuard('/unused', 100, async () => free);
  const stop = disk.watch(callback);
  await vi.advanceTimersByTimeAsync(2000);
  expect(callback).not.toHaveBeenCalled();
  free = 99;
  await vi.advanceTimersByTimeAsync(2000);
  expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISK_FULL' }));
  stop();
  await vi.advanceTimersByTimeAsync(4000);
  expect(callback).toHaveBeenCalledOnce();
});

it('fails a job before downloading when space is low, cleans files, and continues the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'disk-queue-'));
  roots.push(root);
  let free = 0;
  const disk = new DiskGuard(root, 100, async () => free);
  const store = new JobStore();
  const executor = {
    downloadVideo: vi.fn(async (_request: DownloadRequest, destination: string) => {
      await writeFile(destination, 'video');
      return { provider: 'test', filePath: destination, sizeBytes: 5 };
    }),
  };
  const queue = new DownloadQueue({ store, executor, workRoot: root, disk });
  queue.start();
  const first = await queue.enqueue(request);
  await vi.waitFor(() =>
    expect(store.get(first.id)).toMatchObject({ state: 'failed', errorCode: 'DISK_FULL' }),
  );
  expect(executor.downloadVideo).not.toHaveBeenCalled();
  await vi.waitFor(async () => await expect(access(join(root, first.id))).rejects.toThrow());
  free = 10_000;
  const second = await queue.enqueue(request);
  await vi.waitFor(() => expect(store.get(second.id)?.state).toBe('ready'));
  await queue.stop();
});

it('aborts the running process on low space, reports DISK_FULL rather than cancellation, and deletes partial files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'disk-monitor-'));
  roots.push(root);
  const store = new JobStore();
  let lowSpace!: Parameters<DiskGuard['watch']>[0];
  const disk = new DiskGuard(root, 100, async () => 10_000);
  const stopped = vi.fn();
  vi.spyOn(disk, 'watch').mockImplementation((callback) => {
    lowSpace = callback;
    return stopped;
  });
  const executor = {
    downloadVideo: vi.fn(
      async (_request: DownloadRequest, destination: string, signal: AbortSignal) => {
        await writeFile(destination + '.part', 'partial');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { provider: 'test', filePath: destination, sizeBytes: 0 };
      },
    ),
  };
  const queue = new DownloadQueue({ store, executor, workRoot: root, disk });
  queue.start();
  const job = await queue.enqueue(request);
  await vi.waitFor(async () =>
    expect(await access(join(root, job.id, 'aaaaaaaaaaa-1080.mp4.part'))).toBeUndefined(),
  );
  const { AppError } = await import('../../src/server/domain/errors.js');
  lowSpace(new AppError('DISK_FULL', false));
  await vi.waitFor(() =>
    expect(store.get(job.id)).toMatchObject({ state: 'failed', errorCode: 'DISK_FULL' }),
  );
  await vi.waitFor(async () => await expect(access(join(root, job.id))).rejects.toThrow());
  expect(stopped).toHaveBeenCalledOnce();
  await queue.stop();
});
