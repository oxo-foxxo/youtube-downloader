import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from '../../shared/contracts.js';
import { isTerminalJob } from '../../shared/job-state.js';
import type { ApiClient } from '../api.js';

function upsertJob(jobs: Job[], next: Job): Job[] {
  return jobs.some((job) => job.id === next.id)
    ? jobs.map((job) => (job.id === next.id ? next : job))
    : [...jobs, next];
}

export function useDownloads(api: ApiClient, onError: (message: string) => void) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const subscriptions = useRef(new Map<string, () => void>());
  const downloaded = useRef(new Set<string>());

  const watch = useCallback(
    (job: Job, autoDownload: boolean) => {
      if (subscriptions.current.has(job.id) || isTerminalJob(job.state)) return;
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      const stop = () => {
        stopped = true;
        unsubscribe?.();
        subscriptions.current.delete(job.id);
      };
      // Register first: even an immediate event must be able to close its subscription.
      subscriptions.current.set(job.id, stop);
      unsubscribe = api.subscribeJob(
        job.id,
        (next) => {
          if (stopped) return;
          setJobs((current) =>
            next.state === 'expired'
              ? current.filter((item) => item.id !== next.id)
              : upsertJob(current, next),
          );
          if (autoDownload && next.state === 'ready' && !downloaded.current.has(next.id)) {
            downloaded.current.add(next.id);
            api.startDownload(next.id);
          }
          if (isTerminalJob(next.state)) stop();
        },
        (error) => {
          if (!stopped) onError(error.message);
        },
      );
      if (stopped) unsubscribe();
    },
    [api, onError],
  );

  useEffect(() => {
    let active = true;
    const activeSubscriptions = subscriptions.current;
    void api
      .listJobs?.()
      .then((existing) => {
        if (!active) return;
        // A slow initial response must not overwrite newer progress or newly added jobs.
        setJobs((current) => [
          ...existing.filter(
            (job) => job.state !== 'expired' && !current.some((item) => item.id === job.id),
          ),
          ...current,
        ]);
        existing.forEach((job) => watch(job, job.state !== 'ready'));
      })
      .catch(() => {
        if (active) onError('Не удалось восстановить список загрузок. Обновите страницу');
      });
    return () => {
      active = false;
      activeSubscriptions.forEach((stop) => stop());
      activeSubscriptions.clear();
    };
  }, [api, onError, watch]);

  const addJob = (job: Job) => {
    setJobs((current) => upsertJob(current, job));
    watch(job, true);
  };

  const removeJobs = (ids: string[]) => {
    const removed = new Set(ids);
    for (const id of removed) subscriptions.current.get(id)?.();
    setJobs((current) => current.filter((job) => !removed.has(job.id)));
  };

  return { jobs, addJob, removeJobs };
}
