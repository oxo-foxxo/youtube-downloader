import { rm, stat } from 'node:fs/promises';
import type { DownloadRequest, DownloadResult, HealthStatus, ProgressCallback, SourceAdapter, VideoInfo } from '../../shared/contracts.js';
import { buildDownloadOptions, selectStreams, type SourceStream } from '../domain/formats.js';
import { AppError, classifyProviderError } from '../domain/errors.js';
import type { MediaProcessor } from '../media/ffmpeg.js';
import { writeResponseToFile } from './http-download.js';

export interface YouTubeJsInfo { basicInfo: { id: string; title: string; duration: number; thumbnailUrl?: string; isLive: boolean }; streams: SourceStream[] }
export interface YouTubeJsClient { getInfo(url: string): Promise<YouTubeJsInfo> }
export type YouTubeJsClientFactory = () => Promise<YouTubeJsClient>;

export class YouTubeJsAdapter implements SourceAdapter {
  readonly name = 'youtubejs';
  private client: YouTubeJsClient | undefined;
  constructor(private readonly factory: YouTubeJsClientFactory, private readonly fetcher: typeof fetch, private readonly media: MediaProcessor) {}

  async inspect(canonicalUrl: string, _signal: AbortSignal): Promise<VideoInfo> {
    try {
      const info = await (await this.getClient()).getInfo(canonicalUrl);
      if (info.basicInfo.isLive) throw new AppError('LIVE_STREAM', false, undefined, this.name);
      return { videoId: info.basicInfo.id, canonicalUrl, title: info.basicInfo.title, ...(info.basicInfo.thumbnailUrl ? { thumbnailUrl: info.basicInfo.thumbnailUrl } : {}), durationSeconds: info.basicInfo.duration, variants: buildDownloadOptions(info.streams) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.client = undefined;
      throw classifyProviderError({ provider: this.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async download(request: DownloadRequest, destination: string, signal: AbortSignal, onProgress: ProgressCallback): Promise<DownloadResult> {
    const videoPath = `${destination}.youtubejs.video`;
    const audioPath = `${destination}.youtubejs.audio`;
    try {
      const info = await (await this.getClient()).getInfo(request.canonicalUrl);
      const selected = selectStreams(info.streams, request.height, request.container);
      if (!selected.video.url || (selected.audio && !selected.audio.url)) throw new AppError('PROVIDER_FAILURE', true, undefined, this.name);
      onProgress({ state: 'downloading', message: 'Скачиваем видео' });
      await writeResponseToFile(await this.fetcher(selected.video.url, { signal }), videoPath, signal);
      if (selected.audio?.url) await writeResponseToFile(await this.fetcher(selected.audio.url, { signal }), audioPath, signal);
      await this.media.muxCopy(videoPath, selected.audio ? audioPath : null, destination, request.container, signal, onProgress);
      const file = await stat(destination);
      return { provider: this.name, filePath: destination, sizeBytes: file.size };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw classifyProviderError({ provider: this.name, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await Promise.all([rm(videoPath, { force: true }), rm(audioPath, { force: true })]);
    }
  }

  async health(): Promise<HealthStatus> { try { await this.getClient(); return { healthy: true }; } catch { return { healthy: false, detail: 'YouTube.js is unavailable' }; } }
  async cancel(): Promise<void> {}
  private async getClient(): Promise<YouTubeJsClient> { this.client ??= await this.factory(); return this.client; }
}

export async function createDefaultYouTubeJsClient(): Promise<YouTubeJsClient> {
  const { Innertube } = await import('youtubei.js');
  const client = await Innertube.create();
  return {
    async getInfo(url: string): Promise<YouTubeJsInfo> {
      const raw = await client.getInfo(url) as unknown as { basic_info: Record<string, unknown>; streaming_data?: { formats?: unknown[]; adaptive_formats?: unknown[] } };
      const basic = raw.basic_info;
      const formats = [...(raw.streaming_data?.formats ?? []), ...(raw.streaming_data?.adaptive_formats ?? [])] as Array<Record<string, unknown>>;
      return {
        basicInfo: { id: String(basic.id ?? ''), title: String(basic.title ?? ''), duration: Number(basic.duration ?? 0), isLive: Boolean(basic.is_live), ...(basic.thumbnail ? { thumbnailUrl: String(basic.thumbnail) } : {}) },
        streams: formats.map((format, index) => ({ id: String(format.itag ?? index), hasVideo: Boolean(format.has_video ?? format.width), hasAudio: Boolean(format.has_audio ?? format.audio_codec), ...(format.height ? { height: Number(format.height) } : {}), ...(format.width ? { width: Number(format.width) } : {}), ...(format.fps ? { fps: Number(format.fps) } : {}), hdr: Boolean(format.is_hdr), ...(format.video_codec ? { videoCodec: String(format.video_codec) } : {}), ...(format.audio_codec ? { audioCodec: String(format.audio_codec) } : {}), ...(format.bitrate ? { bitrate: Number(format.bitrate) } : {}), ...(format.content_length ? { sizeBytes: Number(format.content_length) } : {}), ...(format.decipher ? { url: String((format.decipher as (player: unknown) => string)(client.session.player)) } : format.url ? { url: String(format.url) } : {}) })),
      };
    },
  };
}
