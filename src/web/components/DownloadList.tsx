import { useState } from 'react';
import type { Job } from '../../shared/contracts.js';
import { isActiveJob, MAX_QUEUED_JOBS } from '../../shared/job-state.js';
import { Icon } from './Icon.js';

interface DownloadListProps {
  jobs: Job[];
  onCancel: (id: string) => void;
  onSave: (id: string) => void;
  onClear: () => void;
}

export function DownloadList({ jobs, onCancel, onSave, onClear }: DownloadListProps) {
  const [expanded, setExpanded] = useState(true);
  const visibleJobs = jobs.filter((job) => job.state !== 'expired');
  if (visibleJobs.length === 0) return null;
  const activeCount = visibleJobs.filter((job) => isActiveJob(job.state)).length;
  const completedCount = visibleJobs.length - activeCount;
  return (
    <section className="job-list" aria-label="Загрузки">
      <div className="section-heading">
        <button
          type="button"
          className="job-list-toggle"
          aria-expanded={expanded}
          aria-controls="download-items"
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={`toggle-arrow ${expanded ? 'expanded' : ''}`}>
            <Icon name="arrow" />
          </span>
          <span>
            <strong>Ваши загрузки</strong>
            <small>
              {activeCount
                ? `${activeCount} в работе`
                : `${visibleJobs.length} ${jobWord(visibleJobs.length)}`}
            </small>
          </span>
        </button>
        {completedCount > 0 && (
          <button type="button" className="clear-button" onClick={onClear}>
            Очистить завершённые
          </button>
        )}
      </div>
      {expanded && (
        <div id="download-items" className="download-items">
          {visibleJobs
            .slice(-MAX_QUEUED_JOBS)
            .reverse()
            .map((job) => (
              <article key={job.id} className={`job-item state-${job.state}`}>
                <div className="file-icon">
                  <Icon name={job.state === 'expired' ? 'check' : 'film'} />
                </div>
                <div className="job-body">
                  <div className="job-description">
                    <strong>{job.request.title ?? job.request.videoId}</strong>
                    <span>{job.request.videoId}</span>
                    <span className="job-format">
                      {job.request.height}p <b>·</b> {job.request.container.toUpperCase()}
                    </span>
                  </div>
                  <div className="progress-panel" aria-live="polite">
                    <p>{job.progress.message}</p>
                    {job.progress.queuePosition && isActiveJob(job.state) && (
                      <span>Позиция в очереди: {job.progress.queuePosition}</span>
                    )}
                    {(job.state === 'downloading' || job.state === 'merging') && (
                      <progress
                        aria-label={`Прогресс загрузки ${job.request.videoId}`}
                        max={100}
                        {...(job.progress.percent !== undefined
                          ? { value: job.progress.percent }
                          : {})}
                      />
                    )}
                  </div>
                  {job.errorCode && (
                    <details className="error-details">
                      <summary>Подробности ошибки</summary>
                      <p>
                        {job.errorCode}
                        {job.correlationId ? ` · ${job.correlationId}` : ''}
                      </p>
                    </details>
                  )}
                </div>
                <div className="job-actions">
                  {isActiveJob(job.state) && (
                    <button type="button" className="text-button" onClick={() => onCancel(job.id)}>
                      Отменить
                    </button>
                  )}
                  {job.state === 'ready' && (
                    <>
                      <button type="button" className="secondary" onClick={() => onSave(job.id)}>
                        <Icon name="download" />
                        Скачать ещё раз
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onCancel(job.id)}
                      >
                        Удалить файл
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
    </section>
  );
}

function jobWord(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return 'загрузка';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'загрузки';
  return 'загрузок';
}
