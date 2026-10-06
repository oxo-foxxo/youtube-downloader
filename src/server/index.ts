// Проект реализован Шевелевым Александром Максимовичем.
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { expireReadyJobs, recoverWorkRoot } from './jobs/cleanup.js';
import { DownloadQueue } from './jobs/queue.js';
import { JobStore } from './jobs/store.js';
import { MediaProcessor } from './media/ffmpeg.js';
import { DownloadOrchestrator } from './orchestrator.js';
import { runProcess } from './process/run-process.js';
import { CobaltAdapter } from './providers/cobalt.js';
import { YouTubeJsAdapter, createDefaultYouTubeJsClient } from './providers/youtubejs.js';
import { YtDlpAdapter } from './providers/yt-dlp.js';
import { YouTubeSession } from './session.js';
import { DiskGuard } from './jobs/disk.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JobStore();
  await recoverWorkRoot(config.workRoot, store);
  await expireReadyJobs(store, config.workRoot);
  const media = new MediaProcessor(runProcess, config.ffmpegPath, config.ffprobePath);
  const session = config.sessionUrl
    ? new YouTubeSession(config.sessionUrl, config.sessionTokenPath, config.sessionSnapshots)
    : undefined;
  await session?.initialize();
  const disk = new DiskGuard(config.workRoot, config.reserveBytes);
  const ytDlp = new YtDlpAdapter(runProcess, {
    executable: config.ytDlpPath,
    bgutilBaseUrl: config.bgutilUrl,
    chromiumPath: config.chromiumPath,
    jsRuntime: config.ytDlpJsRuntime,
    plainMode: config.ytDlpPlainMode,
    media,
    ...(session ? { session } : {}),
  });
  const cobalt = new CobaltAdapter(config.cobaltUrl, fetch, media);
  const youtubejs = new YouTubeJsAdapter(createDefaultYouTubeJsClient, fetch, media);
  const adapters = [ytDlp, cobalt, youtubejs];
  const logger = {
    info: (fields: Record<string, unknown>, message?: string) =>
      console.info(JSON.stringify({ level: 'info', message, ...fields })),
    warn: (fields: Record<string, unknown>, message?: string) =>
      console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  };
  const orchestrator = new DownloadOrchestrator({
    inspectors: [ytDlp, youtubejs],
    downloaders: adapters,
    media,
    logger,
  });
  const queue = new DownloadQueue({
    store,
    executor: orchestrator,
    workRoot: config.workRoot,
    disk,
  });
  queue.start();
  const app = buildApp({
    store,
    queue,
    orchestrator,
    adapters,
    disk,
    ...(session
      ? {
          session,
          sessionViewerUrl: config.sessionViewerUrl,
          cancelAllJobs: async () => {
            await queue.stop();
            queue.start();
          },
        }
      : {}),
    ...(config.webRoot ? { webRoot: config.webRoot } : {}),
  });
  const expiryTimer = setInterval(() => {
    void expireReadyJobs(store, config.workRoot);
  }, 60_000);
  expiryTimer.unref();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(expiryTimer);
    await queue.stop();
    await app.close();
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  await app.listen({ host: config.host, port: config.port });
  console.info(`Videorix is listening on http://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
