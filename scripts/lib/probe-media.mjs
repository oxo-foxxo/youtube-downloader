import { spawn } from 'node:child_process';

export function probeWithDocker(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'app',
        'ffprobe',
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        'pipe:0',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(
            `FFprobe завершился с кодом ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new Error('FFprobe вернул некорректный JSON'));
      }
    });
    // FFprobe can finish reading metadata before the entire input is consumed.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(bytes);
  });
}
