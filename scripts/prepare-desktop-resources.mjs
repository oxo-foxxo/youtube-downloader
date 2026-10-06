import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import ffmpegPath from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const ytDlpVersion = '2026.08.19';
const platform = process.platform;
const architecture = process.arch;

if (!['darwin', 'win32'].includes(platform)) {
  throw new Error(`Desktop-сборка не поддерживается на ${platform}`);
}
if (!['x64', 'arm64'].includes(architecture)) {
  throw new Error(`Desktop-сборка не поддерживается на ${architecture}`);
}
if (platform === 'win32' && architecture !== 'x64') {
  throw new Error('Текущая Windows-сборка поддерживает x64');
}
if (!ffmpegPath) throw new Error('ffmpeg-static не содержит бинарный файл для этой платформы');

const output = resolve('build/bin');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const suffix = platform === 'win32' ? '.exe' : '';
await copyFile(ffmpegPath, resolve(output, `ffmpeg${suffix}`));
await copyFile(ffprobeInstaller.path, resolve(output, `ffprobe${suffix}`));

const ytDlpAsset = platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp.exe';
const releaseRoot = `https://github.com/yt-dlp/yt-dlp/releases/download/${ytDlpVersion}`;
const [binaryResponse, checksumResponse] = await Promise.all([
  fetch(`${releaseRoot}/${ytDlpAsset}`),
  fetch(`${releaseRoot}/SHA2-256SUMS`),
]);
if (!binaryResponse.ok) throw new Error(`Не удалось скачать ${ytDlpAsset}`);
if (!checksumResponse.ok) throw new Error('Не удалось скачать контрольные суммы yt-dlp');

const checksums = await checksumResponse.text();
const checksum = checksums
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find((parts) => parts.at(-1) === ytDlpAsset)?.[0];
if (!checksum) throw new Error(`В SHA2-256SUMS нет ${ytDlpAsset}`);

const binary = Buffer.from(await binaryResponse.arrayBuffer());
const actual = createHash('sha256').update(binary).digest('hex');
if (actual !== checksum.toLowerCase()) throw new Error('Контрольная сумма yt-dlp не совпала');

const ytDlpPath = resolve(output, `yt-dlp${suffix}`);
await writeFile(ytDlpPath, binary);
if (platform !== 'win32') {
  await Promise.all([
    chmod(resolve(output, `ffmpeg${suffix}`), 0o755),
    chmod(resolve(output, `ffprobe${suffix}`), 0o755),
    chmod(ytDlpPath, 0o755),
  ]);
}

console.log(
  `Подготовлены ${basename(ffmpegPath)}, ${basename(ffprobeInstaller.path)} и ${ytDlpAsset} (${actual.slice(0, 12)}…)`,
);
