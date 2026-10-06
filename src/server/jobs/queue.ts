import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError } from '../domain/errors.js';
import type { DownloadRequest, DownloadResult, ProgressCallback } from '../../shared/contracts.js';
import type { JobStore, StoredJob } from './store.js';

export interface DownloadExecutor {
  downloadVideo(request: DownloadRequest, destination: string, signal: AbortSignal, onProgress: ProgressCallback): Promise<DownloadResult>;
}

export interface DownloadQueueOptions {
  store: JobStore;
  executor: DownloadExecutor;
  workRoot: string;
  retentionMs?: number;
}

export class DownloadQueue {
  private readonly pending: string[] = [];
  private active: { id: string; controller: AbortController } | undefined;
  private running = false;
  private pumping = false;
  private readonly retentionMs: number;

  constructor(private readonly options: DownloadQueueOptions) {
    this.retentionMs = options.retentionMs ?? 60 * 60 * 1000;
  }

  start(): void {
    this.running = true;
    void this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.active?.controller.abort();
    for (const id of this.pending.splice(0)) {
      this.options.store.update(id, { state: 'cancelled' });
      await rm(join(this.options.workRoot, id), { recursive: true, force: true });
    }
    this.updateQueuePositions();
  }

  async enqueue(request: DownloadRequest): Promise<StoredJob> {
    const job = this.options.store.create(request);
    const directory = join(this.options.workRoot, job.id);
    await mkdir(directory, { recursive: true });
    await this.writeManifest(job.id);
    this.pending.push(job.id);
    this.updateQueuePositions();
    void this.pump();
    return this.options.store.get(job.id) as StoredJob;
  }

  async cancel(id: string): Promise<void> {
    const queuedIndex = this.pending.indexOf(id);
    if (queuedIndex >= 0) {
      this.pending.splice(queuedIndex, 1);
      this.options.store.update(id, { state: 'cancelled' });
      await rm(join(this.options.workRoot, id), { recursive: true, force: true });
      this.updateQueuePositions();
      return;
    }
    if (this.active?.id === id) {
      this.active.controller.abort();
      return;
    }
    const job = this.options.store.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
  }

  private async pump(): Promise<void> {
    if (!this.running || this.pumping || this.active || this.pending.length === 0) return;
    this.pumping = true;
    const id = this.pending.shift() as string;
    const controller = new AbortController();
    this.active = { id, controller };
    this.updateQueuePositions();
    const job = this.options.store.get(id);
    if (!job) {
      this.active = undefined;
      this.pumping = false;
      void this.pump();
      return;
    }
    const directory = join(this.options.workRoot, id);
    const filename = `${job.request.videoId}-${job.request.height}.${job.request.container}`;
    const destination = join(directory, filename);
    try {
      this.options.store.update(id, { state: 'downloading' });
      await this.writeManifest(id);
      await this.options.executor.downloadVideo(job.request, destination, controller.signal, (progress) => {
        const state = progress.state === 'merging' ? 'merging' : 'downloading';
        this.options.store.update(id, { state, progress });
      });
      this.options.store.update(id, {
        state: 'ready',
        filePath: destination,
        filename,
        expiresAt: new Date(Date.now() + this.retentionMs).toISOString(),
      });
      await this.writeManifest(id);
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof AppError && error.code === 'CANCELLED');
      if (cancelled) this.options.store.update(id, { state: 'cancelled' });
      else {
        const appError = error instanceof AppError ? error : new AppError('PROVIDER_FAILURE', true);
        this.options.store.update(id, { state: 'failed', errorCode: appError.code, ...(appError.correlationId ? { correlationId: appError.correlationId } : {}) });
      }
      await rm(directory, { recursive: true, force: true });
    } finally {
      this.active = undefined;
      this.pumping = false;
      void this.pump();
    }
  }

  private updateQueuePositions(): void {
    this.pending.forEach((id, index) => {
      const job = this.options.store.get(id);
      if (job?.state === 'queued') this.options.store.update(id, { progress: { state: 'queued', message: 'В очереди', queuePosition: index + 1 } });
    });
  }

  private async writeManifest(id: string): Promise<void> {
    const job = this.options.store.get(id);
    if (!job) return;
    await writeFile(join(this.options.workRoot, id, 'manifest.json'), JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
  }
}
