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
  sessionUrl?: string;
  sessionViewerUrl: string;
  sessionTokenPath: string;
  sessionSnapshots: string;
  reserveBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be a valid TCP port');
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    workRoot: resolve(env.WORK_ROOT ?? '.data/jobs'),
    cobaltUrl: env.COBALT_URL ?? 'http://cobalt:9000',
    bgutilUrl: env.BGUTIL_URL ?? 'http://bgutil:4416',
    chromiumPath: env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    ytDlpPath: env.YT_DLP_PATH ?? 'yt-dlp',
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    ...(env.SESSION_BROWSER_URL ? { sessionUrl: env.SESSION_BROWSER_URL } : {}),
    sessionViewerUrl: env.SESSION_VIEWER_URL ?? 'http://session-browser:6080',
    sessionTokenPath: env.SESSION_TOKEN_PATH ?? '/control/token',
    sessionSnapshots: resolve(env.SESSION_SNAPSHOTS ?? '.data/auth'),
    reserveBytes: 1024 ** 3,
  };
}
