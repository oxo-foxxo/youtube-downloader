export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  return `${Math.round(bytes / 1024 ** 2)} МБ`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}
