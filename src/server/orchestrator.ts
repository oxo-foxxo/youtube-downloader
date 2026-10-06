import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type {
  DownloadRequest,
  DownloadResult,
  ProgressCallback,
  SourceAdapter,
  VideoInfo,
} from '../shared/contracts.js';
import { AppError, classifyProviderError } from './domain/errors.js';
import { isCodecCombinationCompatible } from './domain/formats.js';
import type { MediaProcessor } from './media/ffmpeg.js';

export interface OrchestratorLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

export interface DownloadOrchestratorOptions {
  inspectors: SourceAdapter[];
  downloaders: SourceAdapter[];
  media: Pick<MediaProcessor, 'probeMedia'>;
  logger: OrchestratorLogger;
}

export class DownloadOrchestrator {
  constructor(private readonly options: DownloadOrchestratorOptions) {}

  async inspectVideo(canonicalUrl: string, signal: AbortSignal): Promise<VideoInfo> {
    const correlationId = randomUUID();
    let lastError: AppError | undefined;

    for (const adapter of this.options.inspectors) {
      if (!adapter.inspect) continue;
      this.throwIfCancelled(signal, correlationId);
      try {
        const result = await adapter.inspect(canonicalUrl, signal);
        this.options.logger.info({ correlationId, provider: adapter.name, operation: 'inspect' }, 'Provider succeeded');
        return result;
      } catch (error) {
        const failure = this.normalizeError(error, adapter.name, correlationId);
        lastError = failure;
        this.logFailure(failure, correlationId, 'inspect');
        if (!failure.retryable) throw failure;
      }
    }

    throw lastError ?? new AppError('PROVIDER_UNAVAILABLE', true, undefined, undefined, correlationId);
  }

  async downloadVideo(
    request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<DownloadResult> {
    const correlationId = randomUUID();
    let lastError: AppError | undefined;

    for (const adapter of this.options.downloaders) {
      this.throwIfCancelled(signal, correlationId);
      await cleanupAttemptFiles(destination);
      try {
        const result = await adapter.download(request, destination, signal, onProgress);
        if (resolve(result.filePath) !== resolve(destination)) {
          throw new AppError('PROVIDER_FAILURE', true, undefined, adapter.name);
        }
        await this.verifyExactOutput(request, destination, signal, adapter.name);
        this.options.logger.info({ correlationId, provider: adapter.name, operation: 'download' }, 'Provider succeeded');
        return result;
      } catch (error) {
        await cleanupAttemptFiles(destination);
        const failure = this.normalizeError(error, adapter.name, correlationId);
        lastError = failure;
        this.logFailure(failure, correlationId, 'download');
        if (!failure.retryable) throw failure;
      }
    }

    throw lastError ?? new AppError('PROVIDER_UNAVAILABLE', true, undefined, undefined, correlationId);
  }

  private async verifyExactOutput(
    request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    provider: string,
  ): Promise<void> {
    const probe = await this.options.media.probeMedia(destination, signal);
    const videoCodec = probe.video?.codec;
    const audioCodec = probe.audio?.codec;
    if (
      probe.video?.height !== request.height ||
      !videoCodec ||
      !audioCodec ||
      !isCodecCombinationCompatible(request.container, videoCodec, audioCodec)
    ) {
      throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
    }
  }

  private normalizeError(error: unknown, provider: string, correlationId: string): AppError {
    const failure = error instanceof AppError
      ? error
      : classifyProviderError({ provider, message: error instanceof Error ? error.message : String(error) });
    return new AppError(failure.code, failure.retryable, failure.publicMessage, failure.provider ?? provider, correlationId);
  }

  private throwIfCancelled(signal: AbortSignal, correlationId: string): void {
    if (signal.aborted) throw new AppError('CANCELLED', false, undefined, undefined, correlationId);
  }

  private logFailure(error: AppError, correlationId: string, operation: string): void {
    this.options.logger.warn({
      correlationId,
      provider: error.provider,
      operation,
      errorCode: error.code,
      retryable: error.retryable,
    }, 'Provider failed');
  }
}

async function cleanupAttemptFiles(destination: string): Promise<void> {
  const directory = dirname(destination);
  const prefix = basename(destination);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}.`))
    .map((entry) => rm(resolve(directory, entry), { recursive: true, force: true })));
}
