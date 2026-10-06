import proxy from '@fastify/http-proxy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { YouTubeSession } from '../session.js';

export function localRequestAllowed(request: Pick<FastifyRequest, 'headers' | 'method'>): boolean {
  const host = request.headers.host;
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (request.headers.upgrade?.toLowerCase() === 'websocket' && !origin) return false;
    return true;
  } catch {
    return false;
  }
}

export function registerSessionRoutes(
  app: FastifyInstance,
  session: YouTubeSession,
  viewerUrl: string,
  cancelJobs: () => Promise<void>,
): void {
  const guard = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!localRequestAllowed(request))
      return reply
        .code(403)
        .send({ error: { message: 'Вход доступен только через localhost на этом компьютере' } });
    reply.header('cache-control', 'no-store');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('content-security-policy', "frame-ancestors 'self'");
  };
  app.get('/api/session', { preHandler: guard }, () => session.status());
  app.post('/api/session/open', { preHandler: guard }, async () => {
    await session.open();
    return { ready: true };
  });
  app.post('/api/session/confirm', { preHandler: guard }, () => session.confirm());
  app.delete('/api/session', { preHandler: guard }, async () => {
    await session.logout(cancelJobs);
    return { state: 'disconnected' };
  });
  void app.register(proxy, {
    upstream: viewerUrl,
    prefix: '/login',
    websocket: true,
    preHandler: guard,
    // WebSocket upgrade validation is also performed by the app's onRequest hook.
  });
}
