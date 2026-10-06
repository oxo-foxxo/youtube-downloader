// Проект реализован Шевелевым Александром Максимовичем.
import { useState, type FormEvent } from 'react';
import type { Container, VideoInfo } from '../shared/contracts.js';
import { apiClient, type ApiClient } from './api.js';
import { SessionPanel } from './SessionPanel.js';
import { DownloadList } from './components/DownloadList.js';
import { Icon } from './components/Icon.js';
import { VideoOptions } from './components/VideoOptions.js';
import { useDownloads } from './hooks/useDownloads.js';
import { useStorage } from './hooks/useStorage.js';
import { formatBytes, messageOf } from './format.js';

interface AppProps {
  api?: ApiClient;
}

export function App({ api = apiClient }: AppProps) {
  const [url, setUrl] = useState('');
  const [video, setVideo] = useState<VideoInfo>();
  const [height, setHeight] = useState<number>();
  const [container, setContainer] = useState<Container>('mp4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { jobs, addJob, removeJobs } = useDownloads(api, setError);
  const freeBytes = useStorage(api);

  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.inspect(url);
      const first = result.variants.find((item) =>
        item.containers.some((option) => option.available),
      );
      if (!first) throw new Error('Для этого видео нет совместимых форматов');
      setVideo(result);
      setHeight(first.height);
      setContainer(first.containers.find((option) => option.available)?.container ?? 'mp4');
    } catch (reason) {
      setVideo(undefined);
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  function chooseHeight(nextHeight: number) {
    setHeight(nextHeight);
    const nextVariant = video?.variants.find((item) => item.height === nextHeight);
    if (
      !nextVariant?.containers.some((option) => option.container === container && option.available)
    ) {
      setContainer(nextVariant?.containers.find((option) => option.available)?.container ?? 'mp4');
    }
  }

  async function download() {
    if (!video || !height || busy) return;
    setBusy(true);
    setError('');
    try {
      addJob(await api.createJob(video.canonicalUrl, height, container));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api.cancelJob(id);
      const job = jobs.find((item) => item.id === id);
      if (job && !['queued', 'downloading', 'merging'].includes(job.state)) removeJobs([id]);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  async function clearCompleted() {
    const completed = jobs.filter(
      (job) => !['queued', 'downloading', 'merging'].includes(job.state),
    );
    const results = await Promise.allSettled(completed.map((job) => api.cancelJob(job.id)));
    const cleared = completed
      .filter((_job, index) => results[index]?.status === 'fulfilled')
      .map((job) => job.id);
    removeJobs(cleared);
    if (cleared.length !== completed.length) setError('Некоторые загрузки не удалось очистить');
  }

  function reset() {
    setUrl('');
    setVideo(undefined);
    setHeight(undefined);
    setError('');
    document.getElementById('youtube-url')?.focus();
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="Videorix">
          <span className="wordmark">videorix</span>
        </div>
      </header>
      <main className="workspace">
        <header className="hero">
          <h1 aria-label="Скачать видео">
            Скачать <span>видео</span>
            <span className="hero-period">.</span>
          </h1>
          <p>
            Из YouTube — прямо в ваш проект.
            <br />
            Выберите качество и сохраните MP4 или MOV.
          </p>
        </header>
        <section className="download-card" aria-label="Подготовка видео">
          <div className="card-heading">
            <span className="section-kicker">НАЧНИТЕ СО ССЫЛКИ</span>
            <span className="format-badge">MP4 / MOV</span>
          </div>
          <form className="url-form" onSubmit={inspect}>
            <label htmlFor="youtube-url">Ссылка на YouTube</label>
            <div className="url-row">
              <div className="url-input">
                <Icon name="link" />
                <input
                  id="youtube-url"
                  type="url"
                  value={url}
                  disabled={busy}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setVideo(undefined);
                  }}
                  placeholder="Вставьте ссылку на видео"
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <button className="primary" type="submit" disabled={busy}>
                {busy && !video ? 'Проверяем…' : 'Проверить'}
                <Icon name="arrow" />
              </button>
            </div>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {video && (
            <VideoOptions
              video={video}
              height={height}
              container={container}
              busy={busy}
              onHeight={chooseHeight}
              onContainer={setContainer}
              onDownload={() => void download()}
              onReset={reset}
            />
          )}
          {api.session && <SessionPanel api={api.session} />}
        </section>
        <div className="storage-note">
          <span>
            <Icon name="lock" />
            Файлы и вход остаются на вашем компьютере
          </span>
          {freeBytes !== undefined && (
            <span>
              <Icon name="drive" />
              Свободно {formatBytes(freeBytes)}
            </span>
          )}
        </div>
        <DownloadList
          jobs={jobs}
          onCancel={(id) => void cancel(id)}
          onSave={api.startDownload}
          onClear={() => void clearCompleted()}
        />
        <p className="retention-note">
          Видео готовятся по очереди. Готовый файл можно скачать повторно в течение часа или удалить
          кнопкой очистки.
        </p>
      </main>
      <footer className="site-footer">
        <span>Videorix</span>
        <small>Реализовано Шевелевым Александром Максимовичем</small>
      </footer>
    </div>
  );
}
