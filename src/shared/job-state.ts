import type { JobState } from './contracts.js';

export const MAX_QUEUED_JOBS = 50;
export const JOB_RETENTION_MS = 60 * 60 * 1000;

export function isActiveJob(state: JobState): boolean {
  return state === 'queued' || state === 'downloading' || state === 'merging';
}

// A ready file still receives events until it is delivered or removed.
export function isTerminalJob(state: JobState): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'expired';
}
