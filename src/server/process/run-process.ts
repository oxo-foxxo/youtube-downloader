import { spawn } from 'node:child_process';

import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from '../../shared/contracts.js';

export type ProcessErrorCode = 'TIMEOUT' | 'CANCELLED' | 'FAILED';

export class ProcessExecutionError extends Error {
  constructor(
    readonly code: ProcessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

function appendBounded(current: string, chunk: string, maximum: number): string {
  const combined = current + chunk;
  const bytes = Buffer.from(combined);
  if (bytes.length <= maximum) return combined;
  return bytes.subarray(bytes.length - maximum).toString('utf8');
}

function redactLine(line: string): string {
  if (/https?:\/\/[^\s]*googlevideo\.com\//i.test(line)) return '[redacted media URL]';
  return line.replace(/([?&](?:sig|signature|token|pot)=)[^&\s]+/gi, '$1[redacted]');
}

function lineCollector(callback?: (line: string) => void) {
  let pending = '';
  return {
    push(chunk: string) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) callback?.(redactLine(line));
    },
    flush() {
      if (pending) callback?.(redactLine(pending));
      pending = '';
    },
  };
}

export const runProcess: ProcessRunner = async (
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> => {
  if (options.signal?.aborted) {
    throw new ProcessExecutionError('CANCELLED', 'Process was cancelled');
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const maximum = options.maxOutputBytes ?? 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let reason: ProcessErrorCode | null = null;
    let settled = false;
    const stdoutLines = lineCollector(options.onStdoutLine);
    const stderrLines = lineCollector(options.onStderrLine);

    const terminate = (nextReason: ProcessErrorCode) => {
      if (reason) return;
      reason = nextReason;
      child.kill('SIGTERM');
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => terminate('TIMEOUT'), options.timeoutMs)
      : undefined;
    const abort = () => terminate('CANCELLED');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      stdout = appendBounded(stdout, chunk, maximum);
      stdoutLines.push(chunk);
    });
    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      stderr = appendBounded(stderr, chunk, maximum);
      stderrLines.push(chunk);
    });
    child.once('error', (error) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      reject(new ProcessExecutionError('FAILED', error.message));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      stdoutLines.flush();
      stderrLines.flush();
      if (reason) {
        reject(
          new ProcessExecutionError(
            reason,
            reason === 'TIMEOUT' ? 'Process timed out' : 'Process was cancelled',
          ),
        );
        return;
      }
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
};

