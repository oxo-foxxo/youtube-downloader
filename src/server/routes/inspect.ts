import type { FastifyInstance } from 'fastify';

import { parseYouTubeUrl } from '../domain/youtube-url.js';
import type { InspectRouteDependencies } from '../app.js';

export function registerInspectRoute(
  app: FastifyInstance,
  dependencies: InspectRouteDependencies,
): void {
  app.post<{ Body: { url: string } }>(
    '/api/inspect',
    {
      config: { rateLimit: { max: dependencies.rateLimitMax, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['url'],
          properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (request) => {
      const parsed = parseYouTubeUrl(request.body.url);
      return dependencies.orchestrator.inspectVideo(
        parsed.canonicalUrl,
        requestAbortSignal(request),
      );
    },
  );
}

function requestAbortSignal(request: { raw: NodeJS.EventEmitter }): AbortSignal {
  const controller = new AbortController();
  request.raw.once('aborted', () => controller.abort());
  return controller.signal;
}
