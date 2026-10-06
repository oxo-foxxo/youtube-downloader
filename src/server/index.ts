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

async function main(): Promise<void> {
  const config = loadConfig();
  await recoverWorkRoot(config.workRoot);
  const store = new JobStore();
  await expireReadyJobs(store, config.workRoot);
  const media = new MediaProcessor(runProcess, config.ffmpegPath, config.ffprobePath);
  const ytDlp = new YtDlpAdapter(runProcess, {
    executable: config.ytDlpPath,
    bgutilBaseUrl: config.bgutilUrl,
    chromiumPath: config.chromiumPath,
    media,
  });
  const cobalt = new CobaltAdapter(config.cobaltUrl, fetch, media);
  const youtubejs = new YouTubeJsAdapter(createDefaultYouTubeJsClient, fetch, media);
  const adapters = [ytDlp, cobalt, youtubejs];
  const logger = {
    info: (fields: Record<string, unknown>, message?: string) => console.info(JSON.stringify({ level: 'info', message, ...fields })),
    warn: (fields: Record<string, unknown>, message?: string) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  };
  const orchestrator = new DownloadOrchestrator({ inspectors: [ytDlp, youtubejs], downloaders: adapters, media, logger });
  const queue = new DownloadQueue({ store, executor: orchestrator, workRoot: config.workRoot });
  queue.start();
  const app = buildApp({ store, queue, orchestrator, adapters });
  const expiryTimer = setInterval(() => { void expireReadyJobs(store, config.workRoot); }, 60_000);
  expiryTimer.unref();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(expiryTimer);
    await app.close();
    await queue.stop();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await app.listen({ host: config.host, port: config.port });
  console.info(`YouTube downloader is listening on http://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
