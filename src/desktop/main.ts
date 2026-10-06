// Проект реализован Шевелевым Александром Максимовичем.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, shell } from 'electron';

import { DesktopSessionBrowser } from './session-browser.js';

let mainWindow: BrowserWindow | undefined;
let serverProcess: ChildProcess | undefined;
let serverLog: WriteStream | undefined;
let sessionBrowser: DesktopSessionBrowser | undefined;
let applicationUrl = '';

app.setPath('userData', join(app.getPath('appData'), 'Videorix'));

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Не удалось выбрать локальный порт'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function resourceBinary(name: 'yt-dlp' | 'ffmpeg' | 'ffprobe'): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build');
  return join(root, 'bin', `${name}${suffix}`);
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Локальный сервис завершился при запуске');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Локальный сервис не запустился за 30 секунд');
}

async function startBackend(): Promise<string> {
  const userData = app.getPath('userData');
  const jobs = join(userData, 'downloads');
  const auth = join(userData, 'youtube-session');
  const tokenPath = join(auth, 'control-token');
  mkdirSync(jobs, { recursive: true });
  mkdirSync(auth, { recursive: true });

  sessionBrowser = new DesktopSessionBrowser(auth, tokenPath);
  const sessionUrl = await sessionBrowser.start();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverEntry = join(app.getAppPath(), 'dist', 'src', 'server', 'index.js');
  const logDirectory = join(userData, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  serverLog = createWriteStream(join(logDirectory, 'server.log'), { flags: 'a' });
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: userData,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      WORK_ROOT: jobs,
      WEB_ROOT: join(app.getAppPath(), 'dist', 'web'),
      YT_DLP_PATH: resourceBinary('yt-dlp'),
      FFMPEG_PATH: resourceBinary('ffmpeg'),
      FFPROBE_PATH: resourceBinary('ffprobe'),
      YT_DLP_JS_RUNTIME: `node:${process.execPath}`,
      YT_DLP_PLAIN_MODE: '1',
      COBALT_URL: 'http://127.0.0.1:9',
      SESSION_BROWSER_URL: sessionUrl,
      SESSION_VIEWER_URL: 'http://127.0.0.1:9',
      SESSION_TOKEN_PATH: tokenPath,
      SESSION_SNAPSHOTS: join(auth, 'snapshots'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout?.pipe(serverLog);
  serverProcess.stderr?.pipe(serverLog);
  await waitForServer(url, serverProcess);
  return url;
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f3e8',
    title: 'Videorix',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  await window.loadURL(applicationUrl);
  mainWindow = window;
}

async function shutdown(): Promise<void> {
  serverProcess?.kill();
  serverProcess = undefined;
  serverLog?.end();
  serverLog = undefined;
  await sessionBrowser?.stop();
  sessionBrowser = undefined;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) void createWindow();
    else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      applicationUrl = await startBackend();
      await createWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        'Videorix не запустился',
        `${message}\n\nДиагностика сохранена в папке приложения.`,
      );
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow && applicationUrl) void createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!serverProcess && !sessionBrowser) return;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });
}
