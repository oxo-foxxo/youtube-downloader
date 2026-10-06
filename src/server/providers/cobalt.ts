import { rm, stat } from 'node:fs/promises';
import type { DownloadRequest, DownloadResult, HealthStatus, ProgressCallback, SourceAdapter } from '../../shared/contracts.js';
import { AppError, classifyProviderError } from '../domain/errors.js';
import type { MediaProcessor } from '../media/ffmpeg.js';
import { writeResponseToFile } from './http-download.js';
import { fetchAllowedMedia, isGoogleVideoUrl } from './media-fetch.js';

interface CobaltResponse { status: string; url?: string; filename?: string; error?: { code?: string } }

export class CobaltAdapter implements SourceAdapter {
  readonly name = 'cobalt';
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch, private readonly media: MediaProcessor) {}

  async download(request: DownloadRequest, destination: string, signal: AbortSignal, onProgress: ProgressCallback): Promise<DownloadResult> {
    const temporary = `${destination}.cobalt.mp4`;
    try {
      const response = await this.fetcher(`${this.baseUrl}/`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ url: request.canonicalUrl, videoQuality: String(request.height), youtubeVideoCodec: 'h264', youtubeVideoContainer: 'mp4', downloadMode: 'auto', localProcessing: 'disabled' }),
        signal,
      });
      if (!response.ok) throw classifyProviderError({ provider: this.name, message: `HTTP ${response.status}` });
      const payload = await response.json() as CobaltResponse;
      if (!['redirect', 'tunnel'].includes(payload.status) || !payload.url) {
        throw new AppError('PROVIDER_FAILURE', true, undefined, this.name);
      }
      onProgress({ state: 'downloading', message: 'Скачиваем видео' });
      const base = new URL(this.baseUrl);
      const mediaResponse = await fetchAllowedMedia(
        this.fetcher,
        payload.url,
        signal,
        (url) => (!url.username && !url.password && url.origin === base.origin) || isGoogleVideoUrl(url),
        this.name,
      );
      await writeResponseToFile(mediaResponse, temporary, signal);
      const probe = await this.media.probeMedia(temporary, signal);
      if (probe.video?.height !== request.height || probe.video.codec !== 'h264' || probe.audio?.codec !== 'aac') {
        throw new AppError('PROVIDER_FAILURE', true, undefined, this.name);
      }
      if (request.container === 'mov') await this.media.remuxCopy(temporary, destination, 'mov', signal);
      else await import('node:fs/promises').then(({ rename }) => rename(temporary, destination));
      if (request.container === 'mov') await rm(temporary, { force: true });
      const file = await stat(destination);
      return { provider: this.name, filePath: destination, sizeBytes: file.size };
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof AppError) throw error;
      throw classifyProviderError({ provider: this.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async health(): Promise<HealthStatus> {
    try { const response = await this.fetcher(`${this.baseUrl}/`); return { healthy: response.ok }; }
    catch { return { healthy: false, detail: 'Cobalt is unavailable' }; }
  }
}
