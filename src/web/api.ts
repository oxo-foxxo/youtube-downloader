import type { Container, Job, VideoInfo } from '../shared/contracts.js';

export interface ApiClient {
  inspect(url: string): Promise<VideoInfo>;
  createJob(url: string, height: number, container: Container): Promise<Job>;
  subscribeJob(id: string, onJob: (job: Job) => void, onError?: (error: Error) => void): () => void;
  cancelJob(id: string): Promise<void>;
  startDownload(id: string): void;
}

interface ErrorPayload { error?: { message?: string } }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & ErrorPayload;
  if (!response.ok) throw new Error(payload.error?.message ?? 'Не удалось выполнить запрос');
  return payload;
}

export const apiClient: ApiClient = {
  inspect: (url) => requestJson<VideoInfo>('/api/inspect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
  }),
  createJob: (url, height, container) => requestJson<Job>('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, height, container }),
  }),
  subscribeJob: (id, onJob, onError) => {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    source.addEventListener('progress', (event) => onJob(JSON.parse((event as MessageEvent<string>).data) as Job));
    source.onerror = () => onError?.(new Error('Соединение с сервером прервано'));
    return () => source.close();
  },
  cancelJob: async (id) => {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error('Не удалось отменить загрузку');
  },
  startDownload: (id) => {
    const link = document.createElement('a');
    link.href = `/api/jobs/${encodeURIComponent(id)}/file`;
    link.download = '';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  },
};
