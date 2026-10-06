import { rename, rm } from 'node:fs/promises';

import type { Container, ProcessRunner, ProgressCallback } from '../../shared/contracts.js';
import { isCodecCombinationCompatible } from '../domain/formats.js';

export interface ProbeStream {
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface ProbeResult {
  video?: ProbeStream;
  audio?: ProbeStream;
  durationSeconds?: number;
  sizeBytes?: number;
}

interface FfprobeJson {
  format?: { duration?: string; size?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
  }>;
}

function parseRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numeratorText, denominatorText = '1'] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

export class MediaProcessor {
  constructor(
    private readonly run: ProcessRunner,
    private readonly ffmpegPath = 'ffmpeg',
    private readonly ffprobePath = 'ffprobe',
  ) {}

  async probeMedia(path: string, signal?: AbortSignal): Promise<ProbeResult> {
    const result = await this.run(
      this.ffprobePath,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
      signal ? { signal } : {},
    );
    if (result.exitCode !== 0) {
      throw new Error(`ffprobe failed: ${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout) as FfprobeJson;
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    const output: ProbeResult = {};
    if (video?.codec_name) {
      const fps = parseRate(video.r_frame_rate);
      output.video = {
        codec: video.codec_name,
        ...(video.width !== undefined ? { width: video.width } : {}),
        ...(video.height !== undefined ? { height: video.height } : {}),
        ...(fps !== undefined ? { fps } : {}),
      };
    }
    if (audio?.codec_name) output.audio = { codec: audio.codec_name };
    const duration = Number(parsed.format?.duration);
    if (Number.isFinite(duration)) output.durationSeconds = duration;
    const size = Number(parsed.format?.size);
    if (Number.isFinite(size)) output.sizeBytes = size;
    return output;
  }

  async muxCopy(
    videoPath: string,
    audioPath: string | null,
    outputPath: string,
    container: Container,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<void> {
    const videoProbe = await this.probeMedia(videoPath, signal);
    const audioProbe = audioPath ? await this.probeMedia(audioPath, signal) : videoProbe;
    this.assertCompatible(videoProbe, audioProbe, container);

    const partialPath = `${outputPath}.part`;
    const args = ['-y', '-i', videoPath];
    if (audioPath) args.push('-i', audioPath);
    args.push(
      '-map',
      '0:v:0',
      '-map',
      audioPath ? '1:a:0' : '0:a:0',
      '-c',
      'copy',
      '-f',
      container,
      partialPath,
    );
    onProgress({ state: 'merging', message: 'Объединяем видео и звук' });
    await this.runFfmpeg(args, partialPath, outputPath, signal);
  }

  async remuxCopy(
    inputPath: string,
    outputPath: string,
    container: Container,
    signal: AbortSignal,
  ): Promise<void> {
    const probe = await this.probeMedia(inputPath, signal);
    this.assertCompatible(probe, probe, container);
    const partialPath = `${outputPath}.part`;
    const args = [
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-f',
      container,
      partialPath,
    ];
    await this.runFfmpeg(args, partialPath, outputPath, signal);
  }

  private assertCompatible(
    videoProbe: ProbeResult,
    audioProbe: ProbeResult,
    container: Container,
  ): void {
    const videoCodec = videoProbe.video?.codec;
    const audioCodec = audioProbe.audio?.codec;
    if (
      !videoCodec ||
      !audioCodec ||
      !isCodecCombinationCompatible(container, videoCodec, audioCodec)
    ) {
      throw new Error('Requested format is unavailable');
    }
  }

  private async runFfmpeg(
    args: string[],
    partialPath: string,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.run(this.ffmpegPath, args, { signal });
      if (result.exitCode !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
      await this.probeMedia(partialPath, signal);
      await rename(partialPath, outputPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }
}
