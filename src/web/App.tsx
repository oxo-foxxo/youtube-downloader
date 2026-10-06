import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { Container, Job, MediaVariant, VideoInfo } from '../shared/contracts.js';
import { apiClient, type ApiClient } from './api.js';

interface AppProps { api?: ApiClient }

export function App({ api = apiClient }: AppProps) {
  const [url, setUrl] = useState('');
  const [video, setVideo] = useState<VideoInfo>();
  const [height, setHeight] = useState<number>();
  const [container, setContainer] = useState<Container>('mp4');
  const [job, setJob] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const downloadedJob = useRef<string | undefined>(undefined);

  useEffect(() => () => unsubscribe.current?.(), []);

  const variant = useMemo(() => video?.variants.find((item) => item.height === height), [video, height]);
  const containerOption = variant?.containers.find((item) => item.container === container);
  const active = Boolean(job && !['ready', 'failed', 'cancelled', 'expired'].includes(job.state));

  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    unsubscribe.current?.();
    setJob(undefined);
    try {
      const result = await api.inspect(url);
      const first = result.variants.find((item) => item.containers.some((option) => option.available));
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
    if (!nextVariant?.containers.some((option) => option.container === container && option.available)) {
      setContainer(nextVariant?.containers.find((option) => option.available)?.container ?? 'mp4');
    }
  }

  async function download() {
    if (!video || !height || !containerOption?.available) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createJob(video.canonicalUrl, height, container);
      setJob(created);
      unsubscribe.current?.();
      unsubscribe.current = api.subscribeJob(created.id, (next) => {
        setJob(next);
        if (next.state === 'ready' && downloadedJob.current !== next.id) {
          downloadedJob.current = next.id;
          api.startDownload(next.id);
        }
        if (['ready', 'failed', 'cancelled', 'expired'].includes(next.state)) unsubscribe.current?.();
      }, (reason) => setError(reason.message));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try { await api.cancelJob(job.id); }
    catch (reason) { setError(messageOf(reason)); }
  }

  function reset() {
    unsubscribe.current?.();
    downloadedJob.current = undefined;
    setUrl(''); setVideo(undefined); setHeight(undefined); setJob(undefined); setError(''); setBusy(false);
  }

  return <main className="shell">
    <section className="card" aria-labelledby="page-title">
      <header className="hero">
        <span className="eyebrow">Локальный загрузчик</span>
        <h1 id="page-title">Скачать видео</h1>
        <p>Вставьте ссылку YouTube, выберите точное качество и сохраните MP4 или MOV.</p>
      </header>

      <form className="url-form" onSubmit={inspect}>
        <label htmlFor="youtube-url">Ссылка на YouTube</label>
        <div className="url-row">
          <input id="youtube-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" required disabled={active} />
          <button className="primary" type="submit" disabled={busy || active}>{busy && !video ? 'Проверяем…' : 'Проверить'}</button>
        </div>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {video && <div className="result">
        <div className="metadata">
          {video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" />}
          <div><h2>{video.title}</h2><p>{formatDuration(video.durationSeconds)}</p></div>
        </div>

        <div className="choices">
          <label htmlFor="quality">Разрешение</label>
          <select id="quality" value={height} onChange={(event) => chooseHeight(Number(event.target.value))} disabled={active}>
            {video.variants.map((item) => <option key={item.height} value={item.height}>{qualityLabel(item)}</option>)}
          </select>

          {variant && <>
            <div className="format-meta"><span>{variant.videoCodec.toUpperCase()}</span>{variant.fps && <span>{variant.fps} FPS</span>}{variant.estimatedSizeBytes && <span>≈ {formatBytes(variant.estimatedSizeBytes)}</span>}</div>
            <fieldset disabled={active}>
              <legend>Формат файла</legend>
              <div className="container-grid">
                {variant.containers.map((option) => <label className={`container-option ${option.available ? '' : 'disabled'}`} key={option.container}>
                  <input type="radio" name="container" value={option.container} checked={container === option.container} disabled={!option.available} onChange={() => setContainer(option.container)} />
                  <strong>{option.container.toUpperCase()}</strong>
                  <small>{option.available ? 'Без перекодирования' : option.reason}</small>
                </label>)}
              </div>
            </fieldset>
          </>}
        </div>

        {job && <JobProgress job={job} />}

        <div className="actions">
          {!active && job?.state !== 'ready' && <button className="primary wide" type="button" onClick={download} disabled={busy || !containerOption?.available}>{busy ? 'Запускаем…' : 'Скачать'}</button>}
          {active && <button className="secondary wide" type="button" onClick={cancel}>Отменить</button>}
          {job?.state === 'ready' && <button className="primary wide" type="button" onClick={() => api.startDownload(job.id)}>Скачать файл ещё раз</button>}
          {job && <button className="text-button" type="button" onClick={reset}>Другое видео</button>}
        </div>
      </div>}

      <footer>Только публичные завершённые видео, доступные без аккаунта.</footer>
    </section>
  </main>;
}

function JobProgress({ job }: { job: Job }) {
  return <section className={`progress-panel state-${job.state}`} aria-live="polite">
    <div><strong>{job.progress.message}</strong>{job.progress.queuePosition && <span>Позиция в очереди: {job.progress.queuePosition}</span>}</div>
    {job.state === 'downloading' || job.state === 'merging'
      ? <progress max={100} {...(job.progress.percent !== undefined ? { value: job.progress.percent } : {})} />
      : null}
    {job.errorCode && <p>Код ошибки: {job.errorCode}{job.correlationId ? ` · ${job.correlationId}` : ''}</p>}
  </section>;
}

function qualityLabel(variant: MediaVariant): string {
  return `${variant.height}p${variant.fps ? ` · ${variant.fps} FPS` : ''}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  return `${Math.round(bytes / 1024 ** 2)} МБ`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}
