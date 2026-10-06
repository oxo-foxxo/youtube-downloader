import type { ParsedYouTubeUrl } from '../../shared/contracts.js';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

function unsupportedUrl(): TypeError {
  return new TypeError('Unsupported YouTube URL');
}

export function parseYouTubeUrl(raw: string): ParsedYouTubeUrl {
  let url: URL;

  try {
    url = new URL(raw.trim());
  } catch {
    throw unsupportedUrl();
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw unsupportedUrl();
  }

  let videoId: string | null = null;

  if (url.hostname === 'youtu.be') {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 1) {
      videoId = segments[0] ?? null;
    }
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length === 2 && segments[0] === 'shorts') {
        videoId = segments[1] ?? null;
      }
    }
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    throw unsupportedUrl();
  }

  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

