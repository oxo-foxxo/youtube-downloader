import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  image?: string;
  build?: unknown;
  ports?: string[];
  volumes?: string[];
  networks?: string[];
  healthcheck?: unknown;
  environment?: Record<string, string>;
  depends_on?: Record<string, unknown>;
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<string, { driver?: string; external?: boolean }>;
  volumes?: Record<string, unknown>;
}

describe('Docker Compose configuration', () => {
  it('exposes only the app on loopback and isolates provider ingress', async () => {
    const compose = parse(await readFile('docker-compose.yml', 'utf8')) as Compose;
    expect(Object.keys(compose.services)).toEqual(['app', 'session-browser', 'cobalt', 'bgutil']);
    expect(compose.services.app?.ports).toEqual([
      '${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-8080}:8080',
    ]);
    expect(compose.services.cobalt?.ports).toBeUndefined();
    expect(compose.services.bgutil?.ports).toBeUndefined();
    expect(compose.networks.backend).toMatchObject({ driver: 'bridge' });
    expect(compose.networks.backend?.external).not.toBe(true);
    expect(compose.services.app?.networks).toEqual(['backend', 'auth']);
    expect(compose.services['session-browser']?.networks).toEqual(['auth']);
    expect(compose.services['session-browser']?.ports).toBeUndefined();
    for (const name of ['cobalt', 'bgutil'])
      expect(compose.services[name]?.networks).toEqual(['backend']);
  });

  it('pins images, has health checks, and mounts temporary storage only in app', async () => {
    const source = await readFile('docker-compose.yml', 'utf8');
    const compose = parse(source) as Compose;
    expect(compose.services.cobalt?.image).toBe('ghcr.io/imputnet/cobalt:11.7.1-a636575');
    expect(compose.services.bgutil?.image).toBe('brainicism/bgutil-ytdlp-pot-provider:2.0.1-node');
    for (const service of Object.values(compose.services)) {
      expect(service.healthcheck).toBeDefined();
      if (service.image) expect(service.image).not.toMatch(/:latest$/);
    }
    expect(compose.services.app?.volumes).toEqual([
      'work-data:/work',
      'session-control:/control:ro',
    ]);
    expect(compose.services.cobalt?.volumes).toBeUndefined();
    expect(compose.services.bgutil?.volumes).toBeUndefined();
    expect(compose.services['session-browser']?.volumes).toEqual([
      'youtube-session:/session',
      'session-control:/control',
    ]);
    expect(compose.services.cobalt?.environment?.API_URL).toBe('http://cobalt:9000/');
    expect(compose.services.app?.environment?.BGUTIL_URL).toBe('http://bgutil:4416');
  });
});
