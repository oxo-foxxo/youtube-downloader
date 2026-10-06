import { rm, stat } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import type { Innertube } from 'youtubei.js';
import type {
  DownloadRequest,
  DownloadResult,
  HealthStatus,
  ProgressCallback,
  SourceAdapter,
  VideoInfo,
} from '../../shared/contracts.js';
import { buildDownloadOptions, selectStreams, type SourceStream } from '../domain/formats.js';
import { AppError, classifyProviderError } from '../domain/errors.js';
import type { MediaProcessor } from '../media/ffmpeg.js';
import { writeResponseToFile } from './http-download.js';
import { fetchAllowedMedia, isGoogleVideoUrl } from './media-fetch.js';
import { parseYouTubeUrl } from '../domain/youtube-url.js';

export interface YouTubeJsInfo {
  basicInfo: {
    id: string;
    title: string;
    duration: number;
    thumbnailUrl?: string;
    isLive: boolean;
  };
  streams: SourceStream[];
}
export interface YouTubeJsClient {
  getInfo(
    url: string,
    selection?: Pick<DownloadRequest, 'height' | 'container'>,
  ): Promise<YouTubeJsInfo>;
}
export type YouTubeJsClientFactory = () => Promise<YouTubeJsClient>;

export class YouTubeJsAdapter implements SourceAdapter {
  readonly name = 'youtubejs';
  private client: YouTubeJsClient | undefined;
  constructor(
    private readonly factory: YouTubeJsClientFactory,
    private readonly fetcher: typeof fetch,
    private readonly media: MediaProcessor,
  ) {}

  async inspect(canonicalUrl: string, _signal: AbortSignal): Promise<VideoInfo> {
    try {
      const info = await (await this.getClient()).getInfo(canonicalUrl);
      if (info.basicInfo.isLive) throw new AppError('LIVE_STREAM', false, undefined, this.name);
      return {
        videoId: info.basicInfo.id,
        canonicalUrl,
        title: info.basicInfo.title,
        ...(info.basicInfo.thumbnailUrl ? { thumbnailUrl: info.basicInfo.thumbnailUrl } : {}),
        durationSeconds: info.basicInfo.duration,
        variants: buildDownloadOptions(info.streams),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.client = undefined;
      throw classifyProviderError({
        provider: this.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async download(
    request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<DownloadResult> {
    const videoPath = `${destination}.youtubejs.video`;
    const audioPath = `${destination}.youtubejs.audio`;
    try {
      const info = await (await this.getClient()).getInfo(request.canonicalUrl, request);
      const selected = selectStreams(info.streams, request.height, request.container);
      if (!selected.video.url || (selected.audio && !selected.audio.url))
        throw new AppError('PROVIDER_FAILURE', true, undefined, this.name);
      onProgress({ state: 'downloading', message: 'Скачиваем видео' });
      await writeResponseToFile(
        await fetchAllowedMedia(
          this.fetcher,
          selected.video.url,
          signal,
          isGoogleVideoUrl,
          this.name,
        ),
        videoPath,
        signal,
      );
      if (selected.audio?.url) {
        await writeResponseToFile(
          await fetchAllowedMedia(
            this.fetcher,
            selected.audio.url,
            signal,
            isGoogleVideoUrl,
            this.name,
          ),
          audioPath,
          signal,
        );
      }
      await this.media.muxCopy(
        videoPath,
        selected.audio ? audioPath : null,
        destination,
        request.container,
        signal,
        onProgress,
      );
      const file = await stat(destination);
      return { provider: this.name, filePath: destination, sizeBytes: file.size };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw classifyProviderError({
        provider: this.name,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await Promise.all([rm(videoPath, { force: true }), rm(audioPath, { force: true })]);
    }
  }

  async health(): Promise<HealthStatus> {
    try {
      await this.getClient();
      return { healthy: true };
    } catch {
      return { healthy: false, detail: 'YouTube.js is unavailable' };
    }
  }
  async cancel(): Promise<void> {}
  private async getClient(): Promise<YouTubeJsClient> {
    this.client ??= await this.factory();
    return this.client;
  }
}

export async function createDefaultYouTubeJsClient(): Promise<YouTubeJsClient> {
  const { Innertube, Platform } = await import('youtubei.js');
  Platform.shim.eval = (data) =>
    runInNewContext(`(function () { ${data.output}\n})()`, Object.create(null), { timeout: 5_000 });
  const client = await Innertube.create();
  return wrapYouTubeJsClient(client);
}

export function wrapYouTubeJsClient(
  client: Pick<Innertube, 'getInfo' | 'session'>,
): YouTubeJsClient {
  return {
    async getInfo(url, selection): Promise<YouTubeJsInfo> {
      const raw = await client.getInfo(parseYouTubeUrl(url).videoId);
      const status = raw.playability_status;
      if (status && status.status !== 'OK') {
        throw classifyProviderError({
          provider: 'youtubejs',
          message: `${status.status}: ${status.reason ?? ''}`,
        });
      }
      const basic = raw.basic_info;
      const formats = [
        ...(raw.streaming_data?.formats ?? []),
        ...(raw.streaming_data?.adaptive_formats ?? []),
      ].filter((format) => !format.drm_families?.length && !format.fair_play_key_uri);
      const streams: SourceStream[] = formats.map((format) => {
        const codecs =
          format.mime_type
            .match(/codecs="([^"]+)"/)?.[1]
            ?.split(',')
            .map((codec) => codec.trim()) ?? [];
        const videoCodec = format.has_video ? codecs[0] : undefined;
        const audioCodec = format.has_audio ? codecs[format.has_video ? 1 : 0] : undefined;
        return {
          id: String(format.itag),
          hasVideo: format.has_video,
          hasAudio: format.has_audio,
          ...(format.height ? { height: format.height } : {}),
          ...(format.width ? { width: format.width } : {}),
          ...(format.fps ? { fps: format.fps } : {}),
          hdr: /2084|HLG/.test(format.color_info?.transfer_characteristics ?? ''),
          ...(videoCodec ? { videoCodec } : {}),
          ...(audioCodec ? { audioCodec } : {}),
          ...(format.bitrate ? { bitrate: format.bitrate } : {}),
          ...(format.content_length ? { sizeBytes: format.content_length } : {}),
        };
      });
      if (!streams.length && !basic.is_live)
        throw new AppError('PROVIDER_FAILURE', true, undefined, 'youtubejs');
      // Inspection only needs metadata; decipher only the two selected tracks when downloading.
      if (selection) {
        const selected = selectStreams(streams, selection.height, selection.container);
        for (const stream of [selected.video, selected.audio]) {
          if (!stream) continue;
          const format = formats.find((item) => String(item.itag) === stream.id)!;
          stream.url = await format.decipher(client.session.player);
        }
      }
      const thumbnailUrl = basic.thumbnail?.[0]?.url;
      return {
        basicInfo: {
          id: basic.id ?? '',
          title: basic.title ?? '',
          duration: basic.duration ?? 0,
          isLive: Boolean(basic.is_live),
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        },
        streams,
      };
    },
  };
}
