import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { expireReadyJobs, recoverWorkRoot } from '../../src/server/jobs/cleanup.js';
import { JobStore } from '../../src/server/jobs/store.js';
import type { DownloadRequest } from '../../src/shared/contracts.js';

const request: DownloadRequest = {
  videoId: 'dQw4w9WgXcQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  height: 1080,
  container: 'mp4',
};

describe('job cleanup', () => {
  it('expires ready jobs after 60 minutes and waits for an active lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleanup-'));
    const store = new JobStore();
    const job = store.create(request);
    const directory = join(root, job.id);
    const filePath = join(directory, 'video.mp4');
    await mkdir(directory);
    await writeFile(filePath, 'video');
    store.update(job.id, { state: 'downloading' });
    store.update(job.id, {
      state: 'ready',
      filePath,
      filename: 'video.mp4',
      expiresAt: new Date('2026-01-01T01:00:00Z').toISOString(),
    });
    const lease = store.acquireFileLease(job.id);

    expect(await expireReadyJobs(store, root, new Date('2026-01-01T01:00:01Z'))).toBe(1);
    expect(store.get(job.id)?.state).toBe('expired');
    await expect(access(filePath)).resolves.toBeUndefined();
    await lease.release();
    await expect(access(filePath)).rejects.toThrow();
    expect(store.get(job.id)).toBeUndefined();
  });

  it('recovers only entries below the work root despite malformed manifests and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recovery-'));
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    const sentinel = join(outside, 'keep.txt');
    await writeFile(sentinel, 'keep');
    const normal = join(root, 'normal-job');
    await mkdir(normal);
    await writeFile(
      join(normal, 'manifest.json'),
      JSON.stringify({ filePath: '../outside/keep.txt' }),
    );
    const malformed = join(root, 'malformed-job');
    await mkdir(malformed);
    await writeFile(join(malformed, 'manifest.json'), '{bad json');
    const escape = join(root, 'symlink-job');
    await symlink(outside, escape);

    await recoverWorkRoot(root);

    expect(await readFile(sentinel, 'utf8')).toBe('keep');
    await expect(access(normal)).rejects.toThrow();
    await expect(access(malformed)).rejects.toThrow();
    await expect(lstat(escape)).rejects.toThrow();
  });
});

it('restores unexpired ready jobs after a restart while discarding interrupted jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-ready-'));
  const oldStore = new JobStore();
  const ready = oldStore.create(request);
  const interrupted = oldStore.create(request);
  for (const job of [ready, interrupted]) {
    const directory = join(root, job.id);
    await mkdir(directory);
    oldStore.update(job.id, { state: 'downloading' });
    if (job.id === ready.id) {
      const filename = `${request.videoId}-${request.height}.${request.container}`;
      await writeFile(join(directory, filename), 'ready video');
      oldStore.update(job.id, {
        state: 'ready',
        filename,
        filePath: '/stale/path',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(oldStore.get(job.id)));
  }
  const newStore = new JobStore();
  await recoverWorkRoot(root, newStore);
  expect(newStore.get(ready.id)?.state).toBe('ready');
  expect(newStore.get(ready.id)?.progress).toEqual({ state: 'ready', message: 'Файл готов' });
  expect(newStore.get(ready.id)?.filePath).toBe(
    join(await realpath(root), ready.id, `${request.videoId}-1080.mp4`),
  );
  expect(newStore.get(interrupted.id)).toBeUndefined();
  await expect(access(join(root, interrupted.id))).rejects.toThrow();
});
