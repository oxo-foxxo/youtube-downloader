import { describe, expect, it, vi } from 'vitest';

import { AppError, classifyProviderError, isRetryable } from '../../src/server/domain/errors.js';
import { YtDlpAdapter } from '../../src/server/providers/yt-dlp.js';
import type { ProcessRunner } from '../../src/shared/contracts.js';

const metadata = {
  id: 'dQw4w9WgXcQ',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Test video',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  duration: 42,
  is_live: false,
  formats: [
    {
      format_id: '137',
      vcodec: 'avc1.640028',
      acodec: 'none',
      width: 1920,
      height: 1080,
      fps: 30,
      tbr: 4500,
      filesize: 50_000_000,
    },
    {
      format_id: '140',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 128,
      filesize: 2_000_000,
    },
  ],
};

describe('classifyProviderError', () => {
  it.each([
    ['HTTP Error 403: Forbidden', 'FORBIDDEN', true],
    ['HTTP Error 429: Too Many Requests', 'RATE_LIMITED', true],
    ['signed media URL expired', 'EXPIRED_MEDIA_URL', true],
    ['Sign in to confirm your age', 'AGE_RESTRICTED', false],
    ['This video is private', 'VIDEO_UNAVAILABLE', false],
    ['This video is not available in your country', 'REGION_RESTRICTED', false],
    ['LOGIN_REQUIRED', 'LOGIN_REQUIRED', false],
    ['Sign in to confirm you’re not a bot', 'BOT_DETECTED', true],
    ['LOGIN_REQUIRED: Sign in to confirm you are not a bot', 'BOT_DETECTED', true],
    ['Unable to download webpage: HTTP Error 403', 'FORBIDDEN', true],
    ['Provider unavailable', 'PROVIDER_FAILURE', true],
    ['This video is unavailable in your country', 'REGION_RESTRICTED', false],
  ] as const)('maps %s', (message, code, retryable) => {
    const error = classifyProviderError({ provider: 'yt-dlp', message });
    expect(error).toMatchObject({ code, retryable });
    expect(isRetryable(error)).toBe(retryable);
  });
});

describe('YtDlpAdapter', () => {
  it('normalizes public metadata and available containers', async () => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(metadata),
      stderr: '',
    });
    const adapter = new YtDlpAdapter(run);

    const info = await adapter.inspect!(metadata.webpage_url, new AbortController().signal);

    expect(info).toMatchObject({
      videoId: metadata.id,
      title: metadata.title,
      durationSeconds: 42,
      variants: [expect.objectContaining({ height: 1080 })],
    });
    const args = run.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--no-playlist');
    expect(args.join(' ')).not.toContain('cookie');
  });

  it('rejects live video as a final error', async () => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ ...metadata, is_live: true }),
      stderr: '',
    });

    await expect(
      new YtDlpAdapter(run).inspect!(metadata.webpage_url, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LIVE_STREAM', retryable: false } satisfies Partial<AppError>);
  });

  it('uses the bundled Node runtime without container token providers in desktop mode', async () => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(metadata),
      stderr: '',
    });
    const adapter = new YtDlpAdapter(run, {
      plainMode: true,
      jsRuntime: 'node:/Applications/Videorix.app/Contents/MacOS/Videorix',
    });

    await adapter.inspect!(metadata.webpage_url, new AbortController().signal);

    const args = run.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('node:/Applications/Videorix.app/Contents/MacOS/Videorix');
    expect(args.join(' ')).not.toMatch(/bgutil|wpc/);
  });

  it('classifies extractor failures without exposing signed URLs', async () => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP Error 403 https://rr.googlevideo.com/videoplayback?sig=secret',
    });

    await expect(
      new YtDlpAdapter(run).inspect!(metadata.webpage_url, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: true } satisfies Partial<AppError>);
  });

  it.each(['PO Token provider bgutil failed', 'Sign in to confirm you’re not a bot'])(
    'retries %s once with the WPC guest provider',
    async (stderr) => {
      const run = vi
        .fn<ProcessRunner>()
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr })
        .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(metadata), stderr: '' });
      const adapter = new YtDlpAdapter(run);

      await adapter.inspect!(metadata.webpage_url, new AbortController().signal);

      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0]?.[1].join(' ')).toContain('bgutil');
      expect(run.mock.calls[1]?.[1].join(' ')).toContain('wpc');
    },
  );
});
