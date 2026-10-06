import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { MediaProcessor } from '../../src/server/media/ffmpeg.js';
import type { ProcessRunner } from '../../src/shared/contracts.js';

const h264AacProbe = JSON.stringify({
  format: { duration: '10.0', size: '1000' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});

function fakeRunner(probeJson = h264AacProbe) {
  const runner = vi.fn<ProcessRunner>(async (command, args) => {
    if (command === 'ffprobe') {
      return { exitCode: 0, stdout: probeJson, stderr: '' };
    }
    const output = args.at(-1);
    if (output) await writeFile(output, 'muxed');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return runner;
}

describe('MediaProcessor', () => {
  it('probes media metadata', async () => {
    const media = new MediaProcessor(fakeRunner());

    const result = await media.probeMedia('/tmp/video.mp4');

    expect(result.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080, fps: 30 });
    expect(result.audio).toMatchObject({ codec: 'aac' });
  });

  it.each(['mp4', 'mov'] as const)(
    'muxes streams into %s using stream copy and atomic rename',
    async (container) => {
      const directory = await mkdtemp(join(tmpdir(), 'youtube-downloader-'));
      const output = join(directory, `output.${container}`);
      const runner = fakeRunner();
      const media = new MediaProcessor(runner);

      await media.muxCopy(
        '/tmp/video.mp4',
        '/tmp/audio.m4a',
        output,
        container,
        new AbortController().signal,
        vi.fn(),
      );

      expect(await readFile(output, 'utf8')).toBe('muxed');
      const ffmpegCall = runner.mock.calls.find(([command]) => command === 'ffmpeg');
      expect(ffmpegCall?.[1]).toContain('-c');
      expect(ffmpegCall?.[1]).toContain('copy');
      expect(ffmpegCall?.[1].at(-1)).toBe(`${output}.part`);
    },
  );

  it('rejects an incompatible MOV stream before invoking ffmpeg', async () => {
    const runner = fakeRunner(
      JSON.stringify({
        format: {},
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 3840, height: 2160 },
          { codec_type: 'audio', codec_name: 'opus' },
        ],
      }),
    );
    const media = new MediaProcessor(runner);

    await expect(
      media.remuxCopy('/tmp/source.webm', '/tmp/output.mov', 'mov', new AbortController().signal),
    ).rejects.toThrow('Requested format is unavailable');
    expect(runner.mock.calls.some(([command]) => command === 'ffmpeg')).toBe(false);
  });
});
