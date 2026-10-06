import { randomUUID } from 'node:crypto';

import type { DownloadRequest, Job, JobState, ProgressEvent, ProviderErrorCode } from '../../shared/contracts.js';

export interface StoredJob extends Job {
  filePath?: string;
}

export interface JobUpdate {
  state?: JobState;
  progress?: ProgressEvent;
  filename?: string;
  filePath?: string;
  expiresAt?: string;
  errorCode?: ProviderErrorCode;
  correlationId?: string;
}

export interface FileLease {
  filePath: string;
  release(): Promise<void>;
}

const TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
  queued: new Set(['downloading', 'cancelled']),
  downloading: new Set(['merging', 'ready', 'failed', 'cancelled']),
  merging: new Set(['ready', 'failed', 'cancelled']),
  ready: new Set(['expired']),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export class JobStore {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly listeners = new Map<string, Set<(job: StoredJob) => void>>();
  private readonly leases = new Map<string, number>();
  private expiredFileCleanup?: (job: StoredJob) => Promise<void>;

  create(request: DownloadRequest): StoredJob {
    const now = new Date().toISOString();
    const job: StoredJob = {
      id: randomUUID(),
      request,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      progress: { state: 'queued', message: 'В очереди', queuePosition: 1 },
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  get(id: string): StoredJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  list(): StoredJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  update(id: string, update: JobUpdate): StoredJob {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    const nextState = update.state ?? current.state;
    if (nextState !== current.state && !TRANSITIONS[current.state].has(nextState)) {
      throw new Error(`Invalid job state transition: ${current.state} -> ${nextState}`);
    }
    const next: StoredJob = {
      ...current,
      ...update,
      state: nextState,
      updatedAt: new Date().toISOString(),
      progress: update.progress ?? (nextState === current.state
        ? current.progress
        : { state: nextState, message: stateMessage(nextState) }),
    };
    this.jobs.set(id, next);
    this.publish(next);
    return structuredClone(next);
  }

  subscribe(id: string, listener: (job: StoredJob) => void): () => void {
    if (!this.jobs.has(id)) throw new Error(`Unknown job: ${id}`);
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  acquireFileLease(id: string): FileLease {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'ready' || !job.filePath) throw new Error('Job file is not ready');
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return {
      filePath: job.filePath,
      release: async () => {
        if (released) return;
        released = true;
        const remaining = Math.max(0, (this.leases.get(id) ?? 1) - 1);
        if (remaining === 0) this.leases.delete(id);
        else this.leases.set(id, remaining);
        const latest = this.jobs.get(id);
        if (remaining === 0 && latest?.state === 'expired' && this.expiredFileCleanup) {
          await this.expiredFileCleanup(structuredClone(latest));
        }
      },
    };
  }

  getLeaseCount(id: string): number {
    return this.leases.get(id) ?? 0;
  }

  setExpiredFileCleanup(cleanup: (job: StoredJob) => Promise<void>): void {
    this.expiredFileCleanup = cleanup;
  }

  private publish(job: StoredJob): void {
    for (const listener of this.listeners.get(job.id) ?? []) listener(structuredClone(job));
  }
}

function stateMessage(state: JobState): string {
  const messages: Record<JobState, string> = {
    queued: 'В очереди',
    downloading: 'Скачиваем видео',
    merging: 'Объединяем видео и звук',
    ready: 'Файл готов',
    failed: 'Не удалось подготовить файл',
    cancelled: 'Загрузка отменена',
    expired: 'Срок хранения файла истёк',
  };
  return messages[state];
}
