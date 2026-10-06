import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeSession } from '../../src/server/session.js';
import { localRequestAllowed } from '../../src/server/routes/session.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(connected = true) {
  const root = await mkdtemp(join(tmpdir(), 'session-test-'));
  roots.push(root);
  await writeFile(join(root, 'token'), 'test-token');
  const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    expect(options?.headers).toEqual({ authorization: 'Bearer test-token' });
    return Response.json({
      connected,
      cookies: '# fake cookie fixture',
      userAgent: 'test-browser',
    });
  });
  const session = new YouTubeSession('http://session-browser', join(root, 'token'), root, fetcher);
  await session.initialize();
  return { session, root, fetcher };
}

describe('local YouTube session', () => {
  it('gives only a private temporary snapshot to a job and deletes it after success or failure', async () => {
    const { session, root } = await fixture();
    for (const fail of [false, true]) {
      const use = session.use(undefined, async (credentials) => {
        expect(credentials?.userAgent).toBe('test-browser');
        expect(await readFile(credentials!.cookiePath, 'utf8')).toBe('# fake cookie fixture');
        expect((await stat(credentials!.cookiePath)).mode & 0o777).toBe(0o600);
        if (fail) throw new Error('download failed');
        return 'ok';
      });
      if (fail) await expect(use).rejects.toThrow('download failed');
      else await expect(use).resolves.toBe('ok');
      expect(await readdir(join(root, 'snapshots'))).toEqual([]);
    }
  });

  it('keeps guest mode available without fabricating an authenticated session', async () => {
    const { session } = await fixture(false);
    expect(await session.status()).toEqual({ state: 'disconnected' });
    await session.use(undefined, async (credentials) => expect(credentials).toBeUndefined());
  });

  it('requires confirmation after an expired login and sanitizes control failures', async () => {
    const { session, fetcher } = await fixture();
    session.markExpired();
    expect(await session.status()).toEqual({ state: 'expired' });
    await expect(session.use(undefined, async () => {})).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(await session.confirm()).toEqual({ state: 'connected' });
    fetcher.mockRejectedValue(new Error('secret-cookie-value'));
    expect(await session.status()).toEqual({ state: 'unavailable' });
    await expect(session.open()).rejects.not.toThrow('secret-cookie-value');
  });

  it('aborts active use before clearing the browser on logout and removes the snapshot', async () => {
    const { session, root, fetcher } = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job = session.use(undefined, async (_credentials, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return 'aborted';
    });
    await ready;
    await session.logout(async () => {
      expect(await job).toBe('aborted');
    });
    expect(fetcher).toHaveBeenLastCalledWith('http://session-browser/logout', expect.anything());
    expect(await readdir(join(root, 'snapshots'))).toEqual([]);
  });
});

describe('local browser access guard', () => {
  it.each([
    [{ host: 'localhost:8080' }, true],
    [{ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, true],
    [{ host: 'evil.example:8080' }, false],
    [{ host: 'localhost:8080', origin: 'https://evil.example' }, false],
    [{ host: 'localhost:8080', 'sec-fetch-site': 'cross-site' }, false],
    [{ host: 'localhost:8080', upgrade: 'websocket' }, false],
    [{ host: 'localhost:8080', upgrade: 'websocket', origin: 'http://localhost:8080' }, true],
  ])('validates host and origin: %j', (headers, allowed) => {
    expect(localRequestAllowed({ headers, method: 'GET' })).toBe(allowed);
  });
});

it('passes authenticated cookies to yt-dlp default clients and stops on rejected login', async () => {
  const { session, root } = await fixture();
  const { YtDlpAdapter } = await import('../../src/server/providers/yt-dlp.js');
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    expect(args).toContain('--cookies');
    expect(args.join(' ')).not.toContain('player_client=mweb');
    expect(args).toContain('test-browser');
    const path = args[args.indexOf('--cookies') + 1]!;
    expect(await readFile(path, 'utf8')).toBe('# fake cookie fixture');
    return { exitCode: 1, stdout: '', stderr: 'Sign in to confirm you are not a bot' };
  });
  const adapter = new YtDlpAdapter(run, { session });
  await expect(
    adapter.inspect('https://www.youtube.com/watch?v=aaaaaaaaaaa', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
  expect(run).toHaveBeenCalledOnce();
  expect(await session.status()).toEqual({ state: 'expired' });
  expect(await readdir(join(root, 'snapshots'))).toEqual([]);
});
