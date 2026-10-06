import type { Container, MediaVariant } from '../../shared/contracts.js';

export interface SourceStream {
  id: string;
  hasVideo: boolean;
  hasAudio: boolean;
  height?: number;
  width?: number;
  fps?: number;
  hdr?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  sizeBytes?: number;
  url?: string;
}

export interface SelectedStreams {
  video: SourceStream;
  audio: SourceStream | null;
  videoCodec: string;
  audioCodec: string;
  estimatedSizeBytes?: number;
}

const COMPATIBILITY: Record<Container, { video: Set<string>; audio: Set<string> }> = {
  mp4: {
    video: new Set(['h264', 'hevc', 'av1', 'vp9']),
    audio: new Set(['aac', 'opus']),
  },
  mov: {
    video: new Set(['h264', 'hevc']),
    audio: new Set(['aac', 'alac', 'pcm']),
  },
};

const UNAVAILABLE_REASON = 'Нет совместимых исходных дорожек без перекодирования';

export function isCodecCombinationCompatible(
  container: Container,
  videoCodec: string,
  audioCodec: string,
): boolean {
  const policy = COMPATIBILITY[container];
  return (
    policy.video.has(normalizeVideoCodec(videoCodec)) &&
    policy.audio.has(normalizeAudioCodec(audioCodec))
  );
}

export function normalizeVideoCodec(codec?: string): string {
  const value = codec?.toLowerCase() ?? '';
  if (value.startsWith('avc1') || value === 'h264') return 'h264';
  if (value.startsWith('hvc1') || value.startsWith('hev1') || value === 'hevc') return 'hevc';
  if (value.startsWith('av01') || value === 'av1') return 'av1';
  if (value.startsWith('vp09') || value === 'vp9') return 'vp9';
  return value;
}

export function normalizeAudioCodec(codec?: string): string {
  const value = codec?.toLowerCase() ?? '';
  if (value.startsWith('mp4a') || value === 'aac') return 'aac';
  if (value.startsWith('opus')) return 'opus';
  if (value.startsWith('alac')) return 'alac';
  if (value.startsWith('pcm')) return 'pcm';
  return value;
}

function byBitrateDescending(a: SourceStream, b: SourceStream): number {
  return (b.bitrate ?? 0) - (a.bitrate ?? 0);
}

export function selectStreams(
  streams: SourceStream[],
  height: number,
  container: Container,
): SelectedStreams {
  const policy = COMPATIBILITY[container];
  const videos = streams
    .filter(
      (stream) =>
        stream.hasVideo &&
        stream.height === height &&
        policy.video.has(normalizeVideoCodec(stream.videoCodec)),
    )
    .sort(byBitrateDescending);

  for (const video of videos) {
    const separateAudio = streams
      .filter(
        (stream) =>
          stream.hasAudio &&
          !stream.hasVideo &&
          policy.audio.has(normalizeAudioCodec(stream.audioCodec)),
      )
      .sort(byBitrateDescending)[0];

    const embeddedAudioCodec = normalizeAudioCodec(video.audioCodec);
    const audio = separateAudio ?? null;
    const audioCodec = audio
      ? normalizeAudioCodec(audio.audioCodec)
      : embeddedAudioCodec;

    if (!audio && (!video.hasAudio || !policy.audio.has(audioCodec))) {
      continue;
    }

    const sizes = [video.sizeBytes, audio?.sizeBytes].filter(
      (value): value is number => value !== undefined,
    );

    return {
      video,
      audio,
      videoCodec: normalizeVideoCodec(video.videoCodec),
      audioCodec,
      ...(sizes.length > 0
        ? { estimatedSizeBytes: sizes.reduce((total, size) => total + size, 0) }
        : {}),
    };
  }

  throw new Error('Requested format is unavailable');
}

export function buildDownloadOptions(streams: SourceStream[]): MediaVariant[] {
  const heights = [...new Set(
    streams
      .filter((stream) => stream.hasVideo && stream.height !== undefined)
      .map((stream) => stream.height as number),
  )].sort((a, b) => b - a);

  return heights.map((height) => {
    const selections = new Map<Container, SelectedStreams>();
    const containers = (['mp4', 'mov'] as const).map((container) => {
      try {
        const selected = selectStreams(streams, height, container);
        selections.set(container, selected);
        return { container, available: true };
      } catch {
        return { container, available: false, reason: UNAVAILABLE_REASON };
      }
    });

    const selected = selections.get('mp4') ?? selections.get('mov');
    const variant: MediaVariant = {
      height,
      ...(selected?.video.width !== undefined ? { width: selected.video.width } : {}),
      ...(selected?.video.fps !== undefined ? { fps: selected.video.fps } : {}),
      hdr: selected?.video.hdr ?? false,
      videoCodec: selected?.videoCodec ?? '',
      audioCodec: selected?.audioCodec ?? '',
      ...(selected?.estimatedSizeBytes !== undefined
        ? { estimatedSizeBytes: selected.estimatedSizeBytes }
        : {}),
      containers,
    };
    return variant;
  });
}
