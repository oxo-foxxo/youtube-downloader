import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  workRoot: string;
  cobaltUrl: string;
  bgutilUrl: string;
  chromiumPath: string;
  ytDlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    workRoot: resolve(env.WORK_ROOT ?? '/tmp/youtube-downloader'),
    cobaltUrl: env.COBALT_URL ?? 'http://cobalt:9000',
    bgutilUrl: env.BGUTIL_URL ?? 'http://bgutil:4416',
    chromiumPath: env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    ytDlpPath: env.YT_DLP_PATH ?? 'yt-dlp',
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
  };
}
