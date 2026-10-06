import { describe, expect, it } from 'vitest';

import {
  buildDownloadOptions,
  selectStreams,
  type SourceStream,
} from '../../src/server/domain/formats.js';

const streams: SourceStream[] = [
  {
    id: 'h264-low',
    hasVideo: true,
    hasAudio: false,
    height: 1080,
    width: 1920,
    fps: 30,
    hdr: false,
    videoCodec: 'avc1.640028',
    bitrate: 3_000_000,
    sizeBytes: 30_000_000,
  },
  {
    id: 'h264-high',
    hasVideo: true,
    hasAudio: false,
    height: 1080,
    width: 1920,
    fps: 60,
    hdr: false,
    videoCodec: 'h264',
    bitrate: 5_000_000,
    sizeBytes: 50_000_000,
  },
  {
    id: 'h264-720',
    hasVideo: true,
    hasAudio: false,
    height: 720,
    width: 1280,
    fps: 30,
    hdr: false,
    videoCodec: 'h264',
    bitrate: 2_000_000,
  },
  {
    id: 'aac-low',
    hasVideo: false,
    hasAudio: true,
    audioCodec: 'mp4a.40.2',
    bitrate: 128_000,
    sizeBytes: 2_000_000,
  },
  {
    id: 'aac-high',
    hasVideo: false,
    hasAudio: true,
    audioCodec: 'aac',
    bitrate: 192_000,
    sizeBytes: 3_000_000,
  },
];

describe('selectStreams', () => {
  it('selects the highest bitrate compatible video and audio at the exact height', () => {
    const selected = selectStreams(streams, 1080, 'mov');

    expect(selected.video.id).toBe('h264-high');
    expect(selected.audio?.id).toBe('aac-high');
    expect(selected.estimatedSizeBytes).toBe(53_000_000);
  });

  it('does not substitute a lower resolution', () => {
    expect(() => selectStreams(streams, 1440, 'mp4')).toThrow(
      'Requested format is unavailable',
    );
  });

  it('accepts VP9 and Opus for MP4 but not MOV', () => {
    const vp9: SourceStream[] = [
      {
        id: 'vp9',
        hasVideo: true,
        hasAudio: false,
        height: 2160,
        videoCodec: 'vp09.00.51.08',
        bitrate: 10_000_000,
        hdr: false,
      },
      {
        id: 'opus',
        hasVideo: false,
        hasAudio: true,
        audioCodec: 'opus',
        bitrate: 160_000,
        hdr: false,
      },
    ];

    expect(selectStreams(vp9, 2160, 'mp4').video.id).toBe('vp9');
    expect(() => selectStreams(vp9, 2160, 'mov')).toThrow(
      'Requested format is unavailable',
    );
  });
});

describe('buildDownloadOptions', () => {
  it('groups exact resolutions and reports compatible containers', () => {
    const options = buildDownloadOptions(streams);

    expect(options.map((option) => option.height)).toEqual([1080, 720]);
    expect(options[0]?.containers).toEqual([
      expect.objectContaining({ container: 'mp4', available: true }),
      expect.objectContaining({ container: 'mov', available: true }),
    ]);
    expect(options[0]?.fps).toBe(60);
    expect(options[0]?.estimatedSizeBytes).toBe(53_000_000);
  });

  it('marks incompatible containers unavailable', () => {
    const options = buildDownloadOptions([
      {
        id: 'av1',
        hasVideo: true,
        hasAudio: false,
        height: 1440,
        videoCodec: 'av01.0.08M.08',
        bitrate: 8_000_000,
        hdr: false,
      },
      {
        id: 'opus',
        hasVideo: false,
        hasAudio: true,
        audioCodec: 'opus',
        bitrate: 160_000,
        hdr: false,
      },
    ]);

    expect(options[0]?.containers).toEqual([
      expect.objectContaining({ container: 'mp4', available: true }),
      expect.objectContaining({
        container: 'mov',
        available: false,
        reason: 'Нет совместимых исходных дорожек без перекодирования',
      }),
    ]);
  });
});

