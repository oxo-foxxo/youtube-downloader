import { describe, expect, it, vi } from 'vitest';

import { ProcessExecutionError, runProcess } from '../../src/server/process/run-process.js';

describe('runProcess', () => {
  it('passes shell metacharacters as a literal argument', async () => {
    const literal = '$(touch /tmp/never) `whoami`; echo unsafe';
    const result = await runProcess(process.execPath, [
      '-e',
      'console.log(process.argv[1])',
      literal,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(literal);
  });

  it('delivers complete output lines and redacts signed URLs', async () => {
    const onStdoutLine = vi.fn();
    await runProcess(
      process.execPath,
      ['-e', "console.log('one'); console.log('https://googlevideo.com/a?sig=secret&x=1')"],
      { onStdoutLine },
    );

    expect(onStdoutLine).toHaveBeenNthCalledWith(1, 'one');
    expect(onStdoutLine).toHaveBeenNthCalledWith(2, '[redacted media URL]');
  });

  it('bounds captured stdout and stderr', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('a'.repeat(200)); process.stderr.write('b'.repeat(200))"],
      { maxOutputBytes: 64 },
    );

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
  });

  it('terminates a process on timeout', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' } satisfies Partial<ProcessExecutionError>);
  });

  it('terminates a process when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' } satisfies Partial<ProcessExecutionError>);
  });
});
