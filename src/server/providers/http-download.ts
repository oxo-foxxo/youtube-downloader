import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function writeResponseToFile(
  response: Response,
  path: string,
  signal: AbortSignal,
  maximumBytes = 20 * 1024 * 1024 * 1024,
): Promise<number> {
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximumBytes ? new Error('Download exceeds size limit') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(path), {
    signal,
  });
  return bytes;
}
