import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CobaltAdapter } from '../../src/server/providers/cobalt.js';
import type { DownloadRequest } from '../../src/shared/contracts.js';

const request: DownloadRequest = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', height: 1080, container: 'mp4' };

describe('CobaltAdapter', () => {
  it('requests exact H264 quality and writes a verified MP4', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'tunnel', url: 'http://cobalt:9000/video', filename: 'video.mp4' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('video-bytes', { status: 200 }));
    const media = { probeMedia: vi.fn().mockResolvedValue({ video: { codec: 'h264', height: 1080 }, audio: { codec: 'aac' } }), remuxCopy: vi.fn() } as never;
    const output = join(tmpdir(), `cobalt-${crypto.randomUUID()}.mp4`);
    const adapter = new CobaltAdapter('http://cobalt:9000', fetcher, media);

    await adapter.download(request, output, new AbortController().signal, vi.fn());

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ videoQuality: '1080', youtubeVideoCodec: 'h264', youtubeVideoContainer: 'mp4' });
    expect(await readFile(output, 'utf8')).toBe('video-bytes');
  });

  it('remuxes a verified H264 result to MOV', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'redirect', url: 'http://cobalt:9000/video' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('bytes', { status: 200 }));
    const remuxCopy = vi.fn(async (_input: string, output: string) => writeFile(output, 'mov-bytes'));
    const media = {
      probeMedia: vi.fn().mockResolvedValue({ video: { codec: 'h264', height: 1080 }, audio: { codec: 'aac' } }),
      remuxCopy,
    } as never;
    const adapter = new CobaltAdapter('http://cobalt:9000', fetcher, media);
    const output = join(tmpdir(), `cobalt-${crypto.randomUUID()}.mov`);

    await adapter.download({ ...request, container: 'mov' }, output, new AbortController().signal, vi.fn());

    expect(remuxCopy).toHaveBeenCalledWith(expect.any(String), output, 'mov', expect.any(AbortSignal));
  });

  it.each(['error', 'local-processing'])('maps %s responses to a retryable failure', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status, error: { code: 'api.error' } }), { status: 200 }));
    const adapter = new CobaltAdapter('http://cobalt:9000', fetcher, {} as never);
    await expect(adapter.download(request, '/tmp/output.mp4', new AbortController().signal, vi.fn())).rejects.toMatchObject({ retryable: true });
  });

  it('does not follow a media redirect to an untrusted host', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'tunnel', url: 'http://cobalt:9000/video' }), { status: 200 }))
      .mockImplementationOnce(async (_url, init) => init?.redirect === 'manual'
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
        : new Response('private-data', { status: 200 }));
    const media = { probeMedia: vi.fn().mockResolvedValue({ video: { codec: 'h264', height: 1080 }, audio: { codec: 'aac' } }) } as never;
    const adapter = new CobaltAdapter('http://cobalt:9000', fetcher, media);

    await expect(adapter.download(request, join(tmpdir(), `cobalt-${crypto.randomUUID()}.mp4`), new AbortController().signal, vi.fn()))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILURE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
