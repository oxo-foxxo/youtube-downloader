import type { FastifyInstance } from 'fastify';

import type { SourceAdapter } from '../../shared/contracts.js';

export function registerHealthRoute(app: FastifyInstance, adapters: SourceAdapter[]): void {
  app.get('/health', async () => {
    const results = await Promise.all(
      adapters.map(async (adapter) => [adapter.name, await adapter.health()] as const),
    );
    const providers = Object.fromEntries(results);
    return { status: results.every(([, health]) => health.healthy) ? 'ok' : 'degraded', providers };
  });
}
