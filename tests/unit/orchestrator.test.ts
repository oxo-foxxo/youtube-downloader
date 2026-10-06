import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AppError, classifyProviderError } from '../../src/server/domain/errors.js';
import { DownloadOrchestrator } from '../../src/server/orchestrator.js';
import type { DownloadRequest, SourceAdapter, VideoInfo } from '../../src/shared/contracts.js';

const request: DownloadRequest = {
  videoId: 'dQw4w9WgXcQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  height: 1080,
  container: 'mp4',
};

const info: VideoInfo = {
  videoId: request.videoId,
  canonicalUrl: request.canonicalUrl,
  title: 'Video',
  durationSeconds: 42,
  variants: [
    {
      height: 1080,
      hdr: false,
      videoCodec: 'h264',
      audioCodec: 'aac',
      containers: [{ container: 'mp4', available: true }],
    },
  ],
};

function adapter(name: string, overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    name,
    inspect: vi.fn().mockResolvedValue(info),
    download: vi.fn().mockRejectedValue(new AppError('PROVIDER_FAILURE', true, undefined, name)),
    health: vi.fn().mockResolvedValue({ healthy: true }),
    ...overrides,
  };
}

function orchestrator(
  inspectors: SourceAdapter[],
  downloaders: SourceAdapter[],
  probe = vi
    .fn()
    .mockResolvedValue({ video: { codec: 'h264', height: 1080 }, audio: { codec: 'aac' } }),
) {
  return new DownloadOrchestrator({
    inspectors,
    downloaders,
    media: { probeMedia: probe } as never,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

describe('DownloadOrchestrator', () => {
  it('continues inspection after the actual YouTube bot challenge', async () => {
    const first = adapter('yt-dlp', {
      inspect: vi.fn().mockRejectedValue(
        classifyProviderError({
          provider: 'yt-dlp',
          message: 'Sign in to confirm you’re not a bot',
        }),
      ),
    });
    const second = adapter('youtubejs');
    await expect(
      orchestrator([first, second], []).inspectVideo(
        request.canonicalUrl,
        new AbortController().signal,
      ),
    ).resolves.toEqual(info);
    expect(second.inspect).toHaveBeenCalledOnce();
  });
  it('inspects in yt-dlp then YouTube.js order and stops after success', async () => {
    const first = adapter('yt-dlp', {
      inspect: vi.fn().mockRejectedValue(new AppError('FORBIDDEN', true, undefined, 'yt-dlp')),
    });
    const second = adapter('youtubejs');
    const result = await orchestrator([first, second], []).inspectVideo(
      request.canonicalUrl,
      new AbortController().signal,
    );
    expect(result.title).toBe('Video');
    expect(first.inspect).toHaveBeenCalledBefore(second.inspect as never);
  });

  it('downloads in yt-dlp, Cobalt, YouTube.js order and stops after success', async () => {
    const calls: string[] = [];
    const first = adapter('yt-dlp', {
      download: vi.fn(async () => {
        calls.push('yt-dlp');
        throw new AppError('RATE_LIMITED', true);
      }),
    });
    const second = adapter('cobalt', {
      download: vi.fn(async (_request, destination) => {
        calls.push('cobalt');
        await writeFile(destination, 'ok');
        return { provider: 'cobalt', filePath: destination, sizeBytes: 2 };
      }),
    });
    const third = adapter('youtubejs', {
      download: vi.fn(async () => {
        calls.push('youtubejs');
        throw new Error('must not run');
      }),
    });
    const destination = join(tmpdir(), `orchestrator-${crypto.randomUUID()}.mp4`);

    const result = await orchestrator([], [first, second, third]).downloadVideo(
      request,
      destination,
      new AbortController().signal,
      vi.fn(),
    );

    expect(result.provider).toBe('cobalt');
    expect(calls).toEqual(['yt-dlp', 'cobalt']);
  });

  it.each([
    'LOGIN_REQUIRED',
    'VIDEO_UNAVAILABLE',
    'AGE_RESTRICTED',
    'REGION_RESTRICTED',
    'LIVE_STREAM',
    'CANCELLED',
    'DISK_FULL',
    'FORMAT_UNAVAILABLE',
  ] as const)('stops fallback for final error %s', async (code) => {
    const first = adapter('yt-dlp', {
      download: vi.fn().mockRejectedValue(new AppError(code, false)),
    });
    const second = adapter('cobalt');
    await expect(
      orchestrator([], [first, second]).downloadVideo(
        request,
        '/tmp/final.mp4',
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(second.download).not.toHaveBeenCalled();
  });

  it('continues after 403, 429, expired URLs, and technical failures', async () => {
    const failures = [
      'FORBIDDEN',
      'RATE_LIMITED',
      'EXPIRED_MEDIA_URL',
      'PROVIDER_FAILURE',
    ] as const;
    const downloaders = failures.map((code, index) =>
      adapter(`provider-${index}`, {
        download: vi.fn().mockRejectedValue(new AppError(code, true)),
      }),
    );
    const destination = join(tmpdir(), `orchestrator-${crypto.randomUUID()}.mp4`);
    downloaders.push(
      adapter('winner', {
        download: vi.fn(async (_request, path) => {
          await writeFile(path, 'ok');
          return { provider: 'winner', filePath: path, sizeBytes: 2 };
        }),
      }),
    );
    await expect(
      orchestrator([], downloaders).downloadVideo(
        request,
        destination,
        new AbortController().signal,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ provider: 'winner' });
    expect(downloaders.every((item) => vi.mocked(item.download).mock.calls.length === 1)).toBe(
      true,
    );
  });

  it('rejects a provider result with a substituted height and tries the next provider', async () => {
    const first = adapter('yt-dlp', {
      download: vi.fn(async (_request, path) => {
        await writeFile(path, 'wrong');
        return { provider: 'yt-dlp', filePath: path, sizeBytes: 5 };
      }),
    });
    const second = adapter('cobalt', {
      download: vi.fn(async (_request, path) => {
        await writeFile(path, 'right');
        return { provider: 'cobalt', filePath: path, sizeBytes: 5 };
      }),
    });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ video: { codec: 'h264', height: 720 }, audio: { codec: 'aac' } })
      .mockResolvedValueOnce({ video: { codec: 'h264', height: 1080 }, audio: { codec: 'aac' } });
    const destination = join(tmpdir(), `orchestrator-${crypto.randomUUID()}.mp4`);
    await expect(
      orchestrator([], [first, second], probe).downloadVideo(
        request,
        destination,
        new AbortController().signal,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ provider: 'cobalt' });
    expect(second.download).toHaveBeenCalledOnce();
  });

  it('removes failed provider partial files and reports a correlation ID', async () => {
    const directory = join(tmpdir(), `orchestrator-${crypto.randomUUID()}`);
    await mkdir(directory);
    const destination = join(directory, 'video.mp4');
    const failing = adapter('yt-dlp', {
      download: vi.fn(async (_request, path) => {
        await Promise.all([
          writeFile(path, 'bad'),
          writeFile(`${path}.part`, 'partial'),
          writeFile(`${path}.provider`, 'partial'),
        ]);
        throw new AppError('PROVIDER_FAILURE', true);
      }),
    });

    const failure = await orchestrator([], [failing])
      .downloadVideo(request, destination, new AbortController().signal, vi.fn())
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER_FAILURE', correlationId: expect.any(String) });
    await expect(access(destination)).rejects.toThrow();
    await expect(access(`${destination}.part`)).rejects.toThrow();
    await expect(access(`${destination}.provider`)).rejects.toThrow();
  });
});
