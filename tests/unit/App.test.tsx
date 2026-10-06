// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/web/App.js';
import type { ApiClient } from '../../src/web/api.js';
import type { Job, VideoInfo } from '../../src/shared/contracts.js';

const info: VideoInfo = {
  videoId: 'dQw4w9WgXcQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Рабочее видео',
  thumbnailUrl: 'https://img.example/thumb.jpg',
  durationSeconds: 125,
  variants: [
    {
      height: 1080,
      width: 1920,
      fps: 60,
      hdr: false,
      videoCodec: 'h264',
      audioCodec: 'aac',
      estimatedSizeBytes: 10_485_760,
      containers: [
        { container: 'mp4', available: true },
        { container: 'mov', available: false, reason: 'Нет совместимых дорожек' },
      ],
    },
    {
      height: 720,
      width: 1280,
      fps: 30,
      hdr: false,
      videoCodec: 'h264',
      audioCodec: 'aac',
      containers: [
        { container: 'mp4', available: true },
        { container: 'mov', available: true },
      ],
    },
  ],
};

afterEach(cleanup);

function createApi() {
  let listener: ((job: Job) => void) | undefined;
  const queued: Job = {
    id: 'job-1',
    request: {
      videoId: info.videoId,
      canonicalUrl: info.canonicalUrl,
      height: 1080,
      container: 'mp4',
    },
    state: 'queued',
    createdAt: '',
    updatedAt: '',
    progress: { state: 'queued', message: 'В очереди', queuePosition: 2 },
  };
  const api: ApiClient = {
    inspect: vi.fn().mockResolvedValue(info),
    createJob: vi.fn().mockResolvedValue(queued),
    subscribeJob: vi.fn((_id, onJob) => {
      listener = onJob;
      return () => undefined;
    }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    startDownload: vi.fn(),
  };
  return { api, emit: (job: Job) => listener?.(job), queued };
}

describe('App', () => {
  it('shows the focused URL-first workflow', () => {
    render(<App api={createApi().api} />);
    expect(screen.getByRole('heading', { name: 'Скачать видео' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ссылка на YouTube')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeEnabled();
  });

  it('inspects metadata and exposes exact resolution and container choices', async () => {
    const { api } = createApi();
    render(<App api={api} />);
    fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
      target: { value: info.canonicalUrl },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Проверить' }).closest('form') as HTMLFormElement,
    );

    expect(await screen.findByText('Рабочее видео')).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /1080p/ })).toBeInTheDocument();
    expect(screen.getByText(/10 МБ/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^MOV/ })).toBeDisabled();
    expect(screen.getByText('Нет совместимых дорожек')).toBeInTheDocument();
  });

  it('creates a job, reports real queue/progress, downloads when ready, and can reset', async () => {
    const { api, emit, queued } = createApi();
    render(<App api={api} />);
    fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
      target: { value: info.canonicalUrl },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Рабочее видео');
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    expect(await screen.findByText('Позиция в очереди: 2')).toBeInTheDocument();
    expect(api.createJob).toHaveBeenCalledWith(info.canonicalUrl, 1080, 'mp4');

    act(() =>
      emit({
        ...queued,
        state: 'downloading',
        progress: { state: 'downloading', message: 'Скачиваем видео', percent: 37 },
      }),
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '37');
    act(() =>
      emit({ ...queued, state: 'ready', progress: { state: 'ready', message: 'Файл готов' } }),
    );
    await waitFor(() => expect(api.startDownload).toHaveBeenCalledWith('job-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Другое видео' }));
    expect(screen.getByLabelText('Ссылка на YouTube')).toHaveValue('');
  });

  it('shows errors and cancels an active job', async () => {
    const { api, emit, queued } = createApi();
    vi.mocked(api.inspect).mockRejectedValueOnce(new Error('Проверьте ссылку на видео YouTube'));
    render(<App api={api} />);
    fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
      target: { value: 'https://bad.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Проверьте ссылку');
    fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
      target: { value: info.canonicalUrl },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Рабочее видео');
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    await screen.findByText('Позиция в очереди: 2');
    act(() =>
      emit({
        ...queued,
        state: 'downloading',
        progress: { state: 'downloading', message: 'Скачиваем видео' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith('job-1'));
  });
});

it('keeps fresh job progress when the initial history request arrives late', async () => {
  const { api, queued, emit } = createApi();
  let resolveHistory!: (jobs: Job[]) => void;
  api.listJobs = () =>
    new Promise((resolve) => {
      resolveHistory = resolve;
    });
  render(<App api={api} />);
  fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
    target: { value: info.canonicalUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
  await screen.findByText('Рабочее видео');
  fireEvent.click(screen.getByRole('button', { name: 'Скачать' }));
  await screen.findByText('Позиция в очереди: 2');
  act(() =>
    emit({
      ...queued,
      state: 'downloading',
      progress: { state: 'downloading', message: 'Скачиваем видео', percent: 64 },
    }),
  );
  await act(async () => resolveHistory([queued]));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '64');
  expect(screen.queryByText('Позиция в очереди: 2')).not.toBeInTheDocument();
});

it('restores ready files without redownloading and closes subscriptions on unmount', async () => {
  const { api, queued, emit } = createApi();
  const unsubscribe = vi.fn();
  api.listJobs = vi
    .fn()
    .mockResolvedValue([
      { ...queued, state: 'ready', progress: { state: 'ready', message: 'Файл готов' } },
    ]);
  vi.mocked(api.subscribeJob).mockReturnValue(unsubscribe);
  const { unmount } = render(<App api={api} />);
  await screen.findByText('Файл готов');
  expect(api.startDownload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Скачать ещё раз' }));
  expect(api.startDownload).toHaveBeenCalledWith(queued.id);
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
  act(() => emit(queued));
});

it('invalidates the selected video when the URL changes', async () => {
  const { api } = createApi();
  render(<App api={api} />);
  fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
    target: { value: info.canonicalUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
  await screen.findByText('Рабочее видео');
  fireEvent.change(screen.getByLabelText('Ссылка на YouTube'), {
    target: { value: 'https://youtu.be/aaaaaaaaaaa' },
  });
  expect(screen.queryByRole('button', { name: 'Скачать' })).not.toBeInTheDocument();
});
