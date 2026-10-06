import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Container, Job } from '../../shared/contracts.js';
import { AppError } from '../domain/errors.js';
import { parseYouTubeUrl } from '../domain/youtube-url.js';
import type { JobsRouteDependencies } from '../app.js';
import type { StoredJob } from '../jobs/store.js';

const JOB_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

export function registerJobsRoutes(app: FastifyInstance, dependencies: JobsRouteDependencies): void {
  app.post<{ Body: { url: string; height: number; container: Container } }>('/api/jobs', {
    config: { rateLimit: { max: dependencies.rateLimitMax, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'height', 'container'],
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 4096 },
          height: { type: 'integer', minimum: 1, maximum: 16_384 },
          container: { type: 'string', enum: ['mp4', 'mov'] },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = parseYouTubeUrl(request.body.url);
    const info = await dependencies.orchestrator.inspectVideo(parsed.canonicalUrl, new AbortController().signal);
    const variant = info.variants.find((item) => item.height === request.body.height);
    const container = variant?.containers.find((item) => item.container === request.body.container);
    if (info.videoId !== parsed.videoId || !container?.available) throw new AppError('FORMAT_UNAVAILABLE', false);
    const job = await dependencies.queue.enqueue({
      videoId: parsed.videoId,
      canonicalUrl: parsed.canonicalUrl,
      height: request.body.height,
      container: request.body.container,
    });
    return reply.code(202).send(publicJob(job));
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', { schema: { params: JOB_PARAMS } }, async (request, reply) => {
    const job = dependencies.store.get(request.params.id);
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Задача не найдена' } });
    return publicJob(job);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', { schema: { params: JOB_PARAMS } }, async (request, reply) => {
    const initial = dependencies.store.get(request.params.id);
    if (!initial) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Задача не найдена' } });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (job: StoredJob) => reply.raw.write(`event: progress\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    send(initial);
    if (isTerminal(initial.state)) {
      reply.raw.end();
      return;
    }
    const unsubscribe = dependencies.store.subscribe(initial.id, (job) => {
      send(job);
      if (isTerminal(job.state)) {
        cleanup();
        reply.raw.end();
      }
    });
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    request.raw.once('close', cleanup);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/file', { schema: { params: JOB_PARAMS } }, async (request, reply) => {
    const job = dependencies.store.get(request.params.id);
    if (!job) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Задача не найдена' } });
    if (job.state !== 'ready') return reply.code(job.state === 'expired' ? 410 : 409).send({ error: { code: 'FILE_NOT_READY', message: 'Файл ещё не готов' } });
    const lease = dependencies.store.acquireFileLease(job.id);
    const filename = safeFilename(job.filename ?? `video.${job.request.container}`);
    reply.header('content-type', job.request.container === 'mov' ? 'video/quicktime' : 'video/mp4');
    reply.header('content-disposition', contentDisposition(filename));
    let completed = false;
    reply.raw.once('finish', () => {
      completed = true;
      const latest = dependencies.store.get(job.id);
      if (latest?.state === 'ready') dependencies.store.update(job.id, { state: 'expired' });
      void lease.release();
    });
    reply.raw.once('close', () => { if (!completed) void lease.release(); });
    return reply.send(createReadStream(lease.filePath));
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', { schema: { params: JOB_PARAMS } }, async (request, reply) => {
    if (!dependencies.store.get(request.params.id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Задача не найдена' } });
    await dependencies.queue.cancel(request.params.id);
    return reply.code(204).send();
  });
}

function publicJob(job: StoredJob): Job {
  const { filePath: _filePath, ...publicValue } = job;
  return publicValue;
}

function isTerminal(state: string): boolean {
  return ['ready', 'failed', 'cancelled', 'expired'].includes(state);
}

function safeFilename(value: string): string {
  const cleaned = value.replace(/[\\/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'video.mp4';
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
