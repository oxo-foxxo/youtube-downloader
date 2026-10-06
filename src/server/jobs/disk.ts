import { statfs } from 'node:fs/promises';
import type { DownloadRequest } from '../../shared/contracts.js';
import { AppError } from '../domain/errors.js';

export class DiskGuard {
  constructor(
    readonly root: string,
    readonly reserveBytes = 1024 ** 3,
    private readonly freeSpace = async () => {
      const stat = await statfs(root);
      return stat.bavail * stat.bsize;
    },
  ) {}

  async status(): Promise<{ availableBytes: number; reserveBytes: number }> {
    return { availableBytes: await this.freeSpace(), reserveBytes: this.reserveBytes };
  }

  async check(request: DownloadRequest): Promise<void> {
    // Source tracks and the merged file coexist. MOV can require another remux copy.
    const estimate = request.estimatedSizeBytes ?? 512 * 1024 ** 2;
    const required =
      this.reserveBytes + Math.ceil(estimate * (request.container === 'mov' ? 3.2 : 2.2));
    if ((await this.freeSpace()) < required)
      throw new AppError(
        'DISK_FULL',
        false,
        `Для подготовки файла нужно около ${(required / 1024 ** 3).toFixed(1)} ГБ свободного места. Сохраните готовые видео или освободите диск`,
      );
  }

  watch(onLowSpace: (error: AppError) => void, intervalMs = 2000): () => void {
    let stopped = false;
    let checking = false;
    const timer = setInterval(async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        if ((await this.freeSpace()) < this.reserveBytes && !stopped) {
          onLowSpace(
            new AppError(
              'DISK_FULL',
              false,
              'Загрузка остановлена: на рабочем диске заканчивается место. Временные файлы удалены',
            ),
          );
        }
      } catch {
        if (!stopped)
          onLowSpace(
            new AppError(
              'DISK_FULL',
              false,
              'Не удалось проверить рабочий диск. Загрузка остановлена',
            ),
          );
      } finally {
        checking = false;
      }
    }, intervalMs);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}
