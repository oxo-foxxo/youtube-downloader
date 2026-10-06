import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { JobStore, StoredJob } from './store.js';

export async function recoverWorkRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true });
  const root = await realpath(workRoot);
  const entries = await readdir(root);
  for (const entry of entries) {
    const candidate = resolve(root, entry);
    if (dirname(candidate) !== root) continue;
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) await rm(candidate, { force: true });
    else await rm(candidate, { recursive: true, force: true });
  }
}

export async function expireReadyJobs(store: JobStore, workRoot: string, now = new Date()): Promise<number> {
  const cleanup = async (job: StoredJob): Promise<void> => safeRemoveJobDirectory(workRoot, job.id);
  store.setExpiredFileCleanup(cleanup);
  let expired = 0;
  for (const job of store.list()) {
    if (job.state !== 'ready' || !job.expiresAt || Date.parse(job.expiresAt) > now.getTime()) continue;
    store.update(job.id, { state: 'expired' });
    expired += 1;
    if (store.getLeaseCount(job.id) === 0) await cleanup(job);
  }
  return expired;
}

async function safeRemoveJobDirectory(workRoot: string, id: string): Promise<void> {
  await mkdir(workRoot, { recursive: true });
  const root = await realpath(workRoot);
  const directory = resolve(root, id);
  if (dirname(directory) !== root) return;
  await rm(directory, { recursive: true, force: true });
}
