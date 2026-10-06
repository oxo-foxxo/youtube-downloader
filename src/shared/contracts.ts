export type Container = 'mp4' | 'mov';

export interface ParsedYouTubeUrl {
  videoId: string;
  canonicalUrl: string;
}

export interface ContainerOption {
  container: Container;
  available: boolean;
  reason?: string;
}

export interface MediaVariant {
  height: number;
  width?: number;
  fps?: number;
  hdr: boolean;
  videoCodec: string;
  audioCodec: string;
  estimatedSizeBytes?: number;
  containers: ContainerOption[];
}

export interface VideoInfo {
  videoId: string;
  canonicalUrl: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  variants: MediaVariant[];
}

export interface DownloadRequest {
  videoId: string;
  canonicalUrl: string;
  height: number;
  container: Container;
}

export type JobState =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ProgressEvent {
  state: JobState;
  message: string;
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  queuePosition?: number;
}

export interface Job {
  id: string;
  request: DownloadRequest;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  progress: ProgressEvent;
  filename?: string;
  expiresAt?: string;
  errorCode?: ProviderErrorCode;
  correlationId?: string;
}

export type ProviderErrorCode =
  | 'INVALID_URL'
  | 'VIDEO_UNAVAILABLE'
  | 'LOGIN_REQUIRED'
  | 'AGE_RESTRICTED'
  | 'REGION_RESTRICTED'
  | 'LIVE_STREAM'
  | 'FORMAT_UNAVAILABLE'
  | 'DISK_FULL'
  | 'CANCELLED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'EXPIRED_MEDIA_URL'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_FAILURE';

export interface ProcessOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

export type ProgressCallback = (event: ProgressEvent) => void;

export interface DownloadResult {
  provider: string;
  filePath: string;
  sizeBytes: number;
}

export interface HealthStatus {
  healthy: boolean;
  detail?: string;
}

export interface SourceAdapter {
  readonly name: string;
  inspect?(canonicalUrl: string, signal: AbortSignal): Promise<VideoInfo>;
  download(
    request: DownloadRequest,
    destination: string,
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<DownloadResult>;
  health(): Promise<HealthStatus>;
  cancel?(jobId: string): Promise<void>;
}
