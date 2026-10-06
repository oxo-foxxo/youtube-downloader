import { AppError } from '../domain/errors.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isGoogleVideoUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
  );
}

export async function fetchAllowedMedia(
  fetcher: typeof fetch,
  rawUrl: string,
  signal: AbortSignal,
  allowed: (url: URL) => boolean,
  provider: string,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
  }

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!allowed(current)) throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
    const response = await fetcher(current, { signal, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
    try {
      current = new URL(location, current);
    } catch {
      throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
    }
  }
  throw new AppError('PROVIDER_FAILURE', true, undefined, provider);
}
