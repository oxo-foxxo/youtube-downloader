import type { ProviderErrorCode } from '../../shared/contracts.js';

export interface ProviderFailure {
  provider: string;
  message: string;
  exitCode?: number;
}

const PUBLIC_MESSAGES: Record<ProviderErrorCode, string> = {
  INVALID_URL: 'Проверьте ссылку на видео YouTube',
  VIDEO_UNAVAILABLE: 'Видео недоступно',
  LOGIN_REQUIRED: 'Видео недоступно без входа в аккаунт',
  AGE_RESTRICTED: 'Видео имеет возрастное ограничение и недоступно без входа',
  REGION_RESTRICTED: 'Видео недоступно в вашем регионе',
  LIVE_STREAM: 'Видео ещё транслируется',
  FORMAT_UNAVAILABLE: 'Выбранный формат больше недоступен — проверьте ссылку заново',
  DISK_FULL: 'Недостаточно места для подготовки файла',
  CANCELLED: 'Загрузка отменена',
  RATE_LIMITED: 'YouTube временно отклонил запрос. Попробуйте позже',
  FORBIDDEN: 'YouTube временно отклонил запрос. Попробуйте позже',
  EXPIRED_MEDIA_URL: 'Временная ссылка на видео истекла',
  PROVIDER_UNAVAILABLE: 'Механизм загрузки временно недоступен',
  PROVIDER_FAILURE: 'Не удалось подготовить файл',
};

export class AppError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
    readonly publicMessage = PUBLIC_MESSAGES[code],
    readonly provider?: string,
  ) {
    super(publicMessage);
    this.name = 'AppError';
  }
}

export function classifyProviderError(failure: ProviderFailure): AppError {
  const message = failure.message;
  const lower = message.toLowerCase();
  if (/age|confirm your age/.test(lower)) return new AppError('AGE_RESTRICTED', false, undefined, failure.provider);
  if (/login_required|sign in/.test(lower)) return new AppError('LOGIN_REQUIRED', false, undefined, failure.provider);
  if (/private|removed|unavailable/.test(lower)) return new AppError('VIDEO_UNAVAILABLE', false, undefined, failure.provider);
  if (/country|region|geo/.test(lower)) return new AppError('REGION_RESTRICTED', false, undefined, failure.provider);
  if (/live stream|is live|premiere/.test(lower)) return new AppError('LIVE_STREAM', false, undefined, failure.provider);
  if (/format.*not available|requested format/.test(lower)) return new AppError('FORMAT_UNAVAILABLE', false, undefined, failure.provider);
  if (/no space|disk full|enospc/.test(lower)) return new AppError('DISK_FULL', false, undefined, failure.provider);
  if (/cancel|abort/.test(lower)) return new AppError('CANCELLED', false, undefined, failure.provider);
  if (/429|too many requests|rate limit/.test(lower)) return new AppError('RATE_LIMITED', true, undefined, failure.provider);
  if (/403|forbidden/.test(lower)) return new AppError('FORBIDDEN', true, undefined, failure.provider);
  if (/expired/.test(lower)) return new AppError('EXPIRED_MEDIA_URL', true, undefined, failure.provider);
  if (/not found|econnrefused|unreachable/.test(lower)) return new AppError('PROVIDER_UNAVAILABLE', true, undefined, failure.provider);
  return new AppError('PROVIDER_FAILURE', true, undefined, failure.provider);
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

