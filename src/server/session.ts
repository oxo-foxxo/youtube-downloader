import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './domain/errors.js';

import type { SessionStatus } from '../shared/contracts.js';
interface Snapshot {
  connected: boolean;
  cookies?: string;
  userAgent?: string;
  browserMode?: 'embedded' | 'external';
}
export interface SessionCredentials {
  cookiePath: string;
  userAgent: string;
}

export class YouTubeSession {
  private expired = false;
  private generation = 0;
  private disconnecting = false;
  private readonly active = new Set<AbortController>();
  constructor(
    private readonly url: string,
    private readonly tokenPath: string,
    private readonly directory: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Only disposable snapshots live here; the persistent browser profile is a different volume.
    await rm(join(this.directory, 'snapshots'), { recursive: true, force: true });
    await mkdir(join(this.directory, 'snapshots'), { mode: 0o700 });
  }

  async status(): Promise<SessionStatus> {
    try {
      const result = await this.control('/status', 'GET');
      return {
        state: this.expired ? 'expired' : result.connected ? 'connected' : 'disconnected',
        ...(result.browserMode ? { browserMode: result.browserMode } : {}),
      };
    } catch {
      return { state: 'unavailable' };
    }
  }

  async open(): Promise<void> {
    await this.control('/open', 'POST');
  }
  async confirm(): Promise<SessionStatus> {
    const result = await this.control('/status', 'GET');
    if (result.connected) this.expired = false;
    return this.status();
  }
  markExpired(): void {
    this.expired = true;
  }

  async logout(cancelJobs: () => Promise<void>): Promise<void> {
    this.disconnecting = true;
    this.generation += 1;
    for (const controller of this.active) controller.abort();
    try {
      await cancelJobs();
      await this.control('/logout', 'POST');
      this.expired = false;
    } finally {
      this.disconnecting = false;
    }
  }

  async use<T>(
    signal: AbortSignal | undefined,
    task: (credentials: SessionCredentials | undefined, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.expired || this.disconnecting) throw new AppError('AUTH_REQUIRED', false);
    const version = this.generation;
    const controller = new AbortController();
    this.active.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let directory: string | undefined;
    try {
      const snapshot = await this.control('/snapshot', 'POST');
      if (version !== this.generation || combined.aborted) throw new AppError('CANCELLED', false);
      if (!snapshot.connected) return await task(undefined, combined);
      if (!snapshot.cookies || !snapshot.userAgent) throw new AppError('PROVIDER_FAILURE', true);
      directory = await mkdtemp(join(this.directory, 'snapshots', 'session-'));
      const cookiePath = join(directory, 'youtube.txt');
      await writeFile(cookiePath, snapshot.cookies, { mode: 0o600 });
      return await task({ cookiePath, userAgent: snapshot.userAgent }, combined);
    } finally {
      this.active.delete(controller);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private async control(path: string, method: 'GET' | 'POST'): Promise<Snapshot> {
    try {
      const token = (await readFile(this.tokenPath, 'utf8')).trim();
      const response = await this.fetcher(this.url + path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error('Browser unavailable');
      return (await response.json()) as Snapshot;
    } catch {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        true,
        'Окно входа временно недоступно. Попробуйте ещё раз',
      );
    }
  }
}
