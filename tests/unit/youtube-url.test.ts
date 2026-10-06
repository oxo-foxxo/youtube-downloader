import { describe, expect, it } from 'vitest';

import { parseYouTubeUrl } from '../../src/server/domain/youtube-url.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

describe('parseYouTubeUrl', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${VIDEO_ID}`, CANONICAL_URL],
    [`https://youtube.com/watch?v=${VIDEO_ID}`, CANONICAL_URL],
    [`https://m.youtube.com/watch?v=${VIDEO_ID}`, CANONICAL_URL],
    [`https://youtu.be/${VIDEO_ID}`, CANONICAL_URL],
    [`https://www.youtube.com/shorts/${VIDEO_ID}`, CANONICAL_URL],
    [`  https://youtu.be/${VIDEO_ID}  `, CANONICAL_URL],
  ])('canonicalizes %s', (raw, canonicalUrl) => {
    expect(parseYouTubeUrl(raw)).toEqual({
      videoId: VIDEO_ID,
      canonicalUrl,
    });
  });

  it('discards playlist and tracking parameters from a video URL', () => {
    expect(
      parseYouTubeUrl(
        `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PL123&index=4&utm_source=test`,
      ),
    ).toEqual({ videoId: VIDEO_ID, canonicalUrl: CANONICAL_URL });
  });

  it.each([
    `http://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:password@www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com.evil.example/watch?v=${VIDEO_ID}`,
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://youtu.be/dQw4w9WgXcQextra',
    'https://example.com/video',
    'not a URL',
    '',
  ])('rejects unsupported input %s', (raw) => {
    expect(() => parseYouTubeUrl(raw)).toThrow('Unsupported YouTube URL');
  });
});

