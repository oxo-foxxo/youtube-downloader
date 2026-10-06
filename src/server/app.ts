import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { SourceAdapter, VideoInfo } from '../shared/contracts.js';
import { AppError } from './domain/errors.js';
import type { DownloadQueue } from './jobs/queue.js';
import type { JobStore, StoredJob } from './jobs/store.js';
import { registerHealthRoute } from './routes/health.js';
import { registerInspectRoute } from './routes/inspect.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { localRequestAllowed, registerSessionRoutes } from './routes/session.js';
import type { YouTubeSession } from './session.js';
import type { DiskGuard } from './jobs/disk.js';

export interface InspectService {
  inspectVideo(canonicalUrl: string, signal: AbortSignal): Promise<VideoInfo>;
}

export interface QueueService {
  enqueue(request: Parameters<DownloadQueue['enqueue']>[0]): Promise<StoredJob>;
  cancel(id: string): Promise<void>;
}

export interface AppDependencies {
  store: JobStore;
  queue: QueueService;
  orchestrator: InspectService;
  adapters: SourceAdapter[];
  bodyLimit?: number;
  rateLimitMax?: number;
  session?: YouTubeSession;
  sessionViewerUrl?: string;
  cancelAllJobs?: () => Promise<void>;
  disk?: DiskGuard;
}

export interface InspectRouteDependencies {
  orchestrator: InspectService;
  rateLimitMax: number;
}

export interface JobsRouteDependencies extends InspectRouteDependencies {
  store: JobStore;
  queue: QueueService;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: dependencies.bodyLimit ?? 16 * 1024 });
  const rateLimitMax = dependencies.rateLimitMax ?? 30;
  if (dependencies.session) {
    // Host validation blocks DNS rebinding; Origin validation protects account and download actions.
    app.addHook('onRequest', async (request, reply) => {
      if (!localRequestAllowed(request))
        return reply
          .code(403)
          .send({ error: { message: 'Откройте сервис через localhost на этом компьютере' } });
    });
    registerSessionRoutes(
      app,
      dependencies.session,
      dependencies.sessionViewerUrl ?? 'http://session-browser:6080',
      dependencies.cancelAllJobs ?? (async () => {}),
    );
  }
  if (dependencies.disk) app.get('/api/storage', () => dependencies.disk!.status());
  void app.register(rateLimit, { global: false });
  const webRoot = resolve(process.cwd(), 'dist/web');
  if (existsSync(webRoot)) void app.register(staticFiles, { root: webRoot, wildcard: false });
  registerInspectRoute(app, { orchestrator: dependencies.orchestrator, rateLimitMax });
  registerJobsRoutes(app, {
    store: dependencies.store,
    queue: dependencies.queue,
    orchestrator: dependencies.orchestrator,
    rateLimitMax,
  });
  registerHealthRoute(app, dependencies.adapters);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      const status =
        error.code === 'INVALID_URL'
          ? 400
          : error.code === 'FORMAT_UNAVAILABLE'
            ? 409
            : error.retryable
              ? 503
              : 422;
      return reply.code(status).send({
        error: {
          code: error.code,
          message: error.publicMessage,
          correlationId: error.correlationId ?? randomUUID(),
        },
      });
    }
    if (error instanceof TypeError && error.message === 'Unsupported YouTube URL') {
      const invalid = new AppError('INVALID_URL', false);
      return reply.code(400).send({
        error: {
          code: invalid.code,
          message: invalid.publicMessage,
          correlationId: randomUUID(),
        },
      });
    }
    const statusCode =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: statusCode === 413 ? 'Запрос слишком большой' : 'Некорректный запрос',
        correlationId: randomUUID(),
      },
    });
  });

  return app;
}
