import { rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { YouTubeSession } from '../session.js';

import type {
  DownloadRequest,
  DownloadResult,
  HealthStatus,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  ProgressCallback,
  SourceAdapter,
  VideoInfo,
} from '../../shared/contracts.js';
import { buildDownloadOptions, type SourceStream } from '../domain/formats.js';
import { AppError, classifyProviderError } from '../domain/errors.js';
import type { MediaProcessor } from '../media/ffmpeg.js';

interface YtDlpFormat {
  format_id?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  dynamic_range?: string;
  tbr?: number;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
  url?: string;
}

interface YtDlpMetadata {
  id?: string;
  webpage_url?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  formats?: YtDlpFormat[];
}

export interface YtDlpOptions {
  executable?: string;
  bgutilBaseUrl?: string;
  chromiumPath?: string;
  media?: MediaProcessor;
  session?: YouTubeSession;
  jsRuntime?: string;
  plainMode?: boolean;
}

export class YtDlpAdapter implements SourceAdapter {
  readonly name = 'yt-dlp';
  private readonly executable: string;
  private readonly bgutilBaseUrl: string;
  private readonly chromiumPath: string;
  private readonly media: MediaProcessor | undefined;
  private readonly session: YouTubeSession | undefined;
  private readonly jsRuntime: string;
  private readonly plainMode: boolean;

  constructor(
    private readonly run: ProcessRunner,
    options: YtDlpOptions = {},
  ) {
    this.executable = options.executable ?? 'yt-dlp';
    this.bgutilBaseUrl = options.bgutilBaseUrl ?? 'http://bgutil:4416';
    this.chromiumPath = options.chromiumPath ?? '/usr/bin/chromium';
    this.media = options.media;
    this.session = options.session;
    this.jsRuntime = options.jsRuntime ?? 'node';
    this.plainMode = options.plainMode ?? false;
  }

  async inspect(canonicalUrl: string, signal: AbortSignal): Promise<VideoInfo> {
    const result = await this.executeWithTokenFallback(
      ['--dump-single-json', '--no-playlist', '--no-warnings', canonicalUrl],
      { signal, timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024 },
    );
    const metadata = JSON.parse(result.stdout) as YtDlpMetadata;
    if (metadata.is_live || metadata.live_status === 'is_live') {
      throw new AppError('LIVE_STREAM', false, undefined, this.name);
    }
    if (!metadata.id || !metadata.title || !metadata.duration) {
      throw new AppError('VIDEO_UNAVAILABLE', false, undefined, this.name);
    }
    const streams = (metadata.formats ?? []).map(toSourceStream);
    return {
      videoId: metadata.id,
      canonicalUrl: metadata.webpage_url ?? canonicalUrl,
      title: metadata.title,
      ...(metadata.thumbnail ? { thumbnailUrl: metadata.thumbnail } : {}),
      durationSeconds: metadata.duration,
      variants: buildDownloadOptions(streams),
    };
  }

  async download(
    request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<DownloadResult> {
    const temporary = `${destination}.yt-dlp.mp4`;
    const selector =
      request.container === 'mov'
        ? `bestvideo[height=${request.height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height=${request.height}][vcodec^=avc1]`
        : `bestvideo[height=${request.height}][ext=mp4]+bestaudio[ext=m4a]/best[height=${request.height}][ext=mp4]`;
    const progress = (line: string) => {
      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match?.[1]) {
        onProgress({ state: 'downloading', message: 'Скачиваем видео', percent: Number(match[1]) });
      }
    };

    try {
      await this.executeWithTokenFallback(
        [
          '-f',
          selector,
          '--no-playlist',
          '--paths',
          `temp:${dirname(destination)}`,
          '--merge-output-format',
          'mp4',
          '-o',
          temporary,
          request.canonicalUrl,
        ],
        { signal, onStdoutLine: progress, onStderrLine: progress, maxOutputBytes: 1024 * 1024 },
      );
      if (request.container === 'mov') {
        if (!this.media) throw new AppError('PROVIDER_FAILURE', true, undefined, this.name);
        await this.media.remuxCopy(temporary, destination, 'mov', signal);
        await rm(temporary, { force: true });
      } else {
        await rename(temporary, destination);
      }
      const details = await stat(destination);
      return { provider: this.name, filePath: destination, sizeBytes: details.size };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async health(): Promise<HealthStatus> {
    try {
      const result = await this.run(this.executable, ['--version'], { timeoutMs: 5_000 });
      return result.exitCode === 0
        ? { healthy: true }
        : { healthy: false, detail: 'yt-dlp exited with an error' };
    } catch {
      return { healthy: false, detail: 'yt-dlp is unavailable' };
    }
  }

  private async executeWithTokenFallback(
    args: string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    if (this.session) {
      return this.session.use(options.signal, async (credentials, signal) => {
        if (!credentials) return this.executeGuest(args, { ...options, signal });
        // Let yt-dlp choose clients supporting account cookies. Do not force guest mweb clients.
        const result = await this.run(
          this.executable,
          [
            '--no-config',
            '--no-js-runtimes',
            '--js-runtimes',
            this.jsRuntime,
            '--socket-timeout',
            '15',
            '--retries',
            '1',
            '--cookies',
            credentials.cookiePath,
            '--user-agent',
            credentials.userAgent,
            '--extractor-args',
            `youtubepot-bgutilhttp:base_url=${this.bgutilBaseUrl}`,
            ...args,
          ],
          { ...options, signal },
        );
        if (result.exitCode === 0) return result;
        const failure = classifyProviderError({ provider: this.name, message: result.stderr });
        if (
          ['LOGIN_REQUIRED', 'BOT_DETECTED'].includes(failure.code) ||
          /cookies.*(?:expired|invalid|rotated)/i.test(result.stderr)
        ) {
          this.session?.markExpired();
          throw new AppError('AUTH_REQUIRED', false, undefined, this.name);
        }
        throw failure;
      });
    }
    return this.executeGuest(args, options);
  }

  private async executeGuest(args: string[], options: ProcessOptions): Promise<ProcessResult> {
    const primary = await this.run(this.executable, [...this.baseArgs('bgutil'), ...args], options);
    if (primary.exitCode === 0) return primary;
    const failure = classifyProviderError({
      provider: this.name,
      message: primary.stderr,
      exitCode: primary.exitCode,
    });
    if (this.plainMode) throw failure;
    if (failure.retryable) {
      const fallback = await this.run(this.executable, [...this.baseArgs('wpc'), ...args], options);
      if (fallback.exitCode === 0) return fallback;
      throw classifyProviderError({
        provider: this.name,
        message: fallback.stderr,
        exitCode: fallback.exitCode,
      });
    }
    throw failure;
  }

  private baseArgs(provider: 'bgutil' | 'wpc'): string[] {
    if (this.plainMode) {
      return [
        '--no-config',
        '--no-js-runtimes',
        '--js-runtimes',
        this.jsRuntime,
        '--socket-timeout',
        '15',
        '--retries',
        '1',
      ];
    }
    const extractorArgs =
      provider === 'bgutil'
        ? `youtubepot-bgutilhttp:base_url=${this.bgutilBaseUrl}`
        : `youtubepot-wpc:browser_path=${this.chromiumPath}`;
    return [
      '--no-config',
      '--js-runtimes',
      'node',
      '--socket-timeout',
      '15',
      '--retries',
      '1',
      '--extractor-args',
      'youtube:player_client=mweb;fetch_pot=always',
      '--extractor-args',
      extractorArgs,
    ];
  }
}

function toSourceStream(format: YtDlpFormat): SourceStream {
  const vcodec = format.vcodec && format.vcodec !== 'none' ? format.vcodec : undefined;
  const acodec = format.acodec && format.acodec !== 'none' ? format.acodec : undefined;
  return {
    id: format.format_id ?? 'unknown',
    hasVideo: Boolean(vcodec),
    hasAudio: Boolean(acodec),
    ...(format.height !== undefined ? { height: format.height } : {}),
    ...(format.width !== undefined ? { width: format.width } : {}),
    ...(format.fps !== undefined ? { fps: format.fps } : {}),
    hdr: Boolean(format.dynamic_range && format.dynamic_range !== 'SDR'),
    ...(vcodec ? { videoCodec: vcodec } : {}),
    ...(acodec ? { audioCodec: acodec } : {}),
    ...((format.tbr ?? format.abr) !== undefined
      ? { bitrate: (format.tbr ?? format.abr ?? 0) * 1000 }
      : {}),
    ...((format.filesize ?? format.filesize_approx) !== undefined
      ? { sizeBytes: format.filesize ?? format.filesize_approx }
      : {}),
    ...(format.url ? { url: format.url } : {}),
  };
}
