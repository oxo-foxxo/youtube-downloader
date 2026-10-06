import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { YouTubeJsAdapter } from '../../src/server/providers/youtubejs.js';

const info = {
  basicInfo: { id: 'dQw4w9WgXcQ', title: 'Video', duration: 42, thumbnailUrl: 'https://img', isLive: false },
  streams: [
    { id: 'v', hasVideo: true, hasAudio: false, height: 1080, width: 1920, fps: 30, hdr: false, videoCodec: 'h264', bitrate: 4_000_000, url: 'https://rr1.googlevideo.com/video' },
    { id: 'a', hasVideo: false, hasAudio: true, hdr: false, audioCodec: 'aac', bitrate: 128_000, url: 'https://rr1.googlevideo.com/audio' },
  ],
};

describe('YouTubeJsAdapter', () => {
  it('normalizes guest metadata', async () => {
    const client = { getInfo: vi.fn().mockResolvedValue(info) };
    const adapter = new YouTubeJsAdapter(async () => client as never, fetch, {} as never);
    const result = await adapter.inspect!('https://www.youtube.com/watch?v=dQw4w9WgXcQ', new AbortController().signal);
    expect(result).toMatchObject({ title: 'Video', durationSeconds: 42, variants: [expect.objectContaining({ height: 1080 })] });
  });

  it('rejects live and login-required responses as final errors', async () => {
    const live = new YouTubeJsAdapter(async () => ({ getInfo: async () => ({ ...info, basicInfo: { ...info.basicInfo, isLive: true } }) }) as never, fetch, {} as never);
    await expect(live.inspect!('https://www.youtube.com/watch?v=dQw4w9WgXcQ', new AbortController().signal)).rejects.toMatchObject({ code: 'LIVE_STREAM', retryable: false });

    const login = new YouTubeJsAdapter(async () => ({ getInfo: async () => { throw new Error('LOGIN_REQUIRED'); } }) as never, fetch, {} as never);
    await expect(login.inspect!('https://www.youtube.com/watch?v=dQw4w9WgXcQ', new AbortController().signal)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED', retryable: false });
  });

  it('downloads exact selected streams and muxes them', async () => {
    const client = { getInfo: vi.fn().mockResolvedValue(info) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('bytes'));
    const muxCopy = vi.fn(async (_video: string, _audio: string, output: string) => writeFile(output, 'muxed-bytes'));
    const media = {
      muxCopy,
    } as never;
    const adapter = new YouTubeJsAdapter(async () => client as never, fetcher, media);
    const output = join(tmpdir(), `youtubejs-${crypto.randomUUID()}.mp4`);
    await adapter.download({ videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', height: 1080, container: 'mp4' }, output, new AbortController().signal, vi.fn());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(muxCopy).toHaveBeenCalledWith(expect.any(String), expect.any(String), output, 'mp4', expect.any(AbortSignal), expect.any(Function));
  });

  it('does not follow a media redirect to an untrusted host', async () => {
    const client = { getInfo: vi.fn().mockResolvedValue(info) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.redirect === 'manual'
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
      : new Response('private-data'));
    const adapter = new YouTubeJsAdapter(async () => client as never, fetcher, {} as never);

    await expect(adapter.download(
      { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', height: 1080, container: 'mp4' },
      join(tmpdir(), `youtubejs-${crypto.randomUUID()}.mp4`),
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
