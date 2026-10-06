import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

interface BrowserVersion {
  userAgent?: string;
  webSocketDebuggerUrl?: string;
}

interface BrowserTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface SessionSnapshot {
  connected: boolean;
  cookies?: string;
  userAgent?: string;
  browserMode: 'external';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
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

async function findBrowser(): Promise<string> {
  const configured = process.env.VIDEORIX_BROWSER_PATH;
  const candidates = configured ? [configured] : browserCandidates();
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  throw new Error('Для входа в YouTube установите Google Chrome, Microsoft Edge или Brave Browser');
}

function browserCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env.PROGRAMFILES ?? '';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? '';
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ].filter((value) => value.length > 0);
  }
  return [];
}

function authorized(actual: string | undefined, token: string): boolean {
  if (!actual) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(actual);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class DesktopSessionBrowser {
  private readonly profileDirectory: string;
  private readonly markerPath: string;
  private readonly userAgentPath: string;
  private token = '';
  private server: Server | undefined;
  private browser: ChildProcess | undefined;
  private debuggingPort: number | undefined;
  private headless = false;

  constructor(
    private readonly dataDirectory: string,
    readonly tokenPath: string,
  ) {
    this.profileDirectory = join(dataDirectory, 'browser-profile');
    this.markerPath = join(dataDirectory, 'connected');
    this.userAgentPath = join(dataDirectory, 'user-agent');
  }

  async start(): Promise<string> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.token = randomBytes(32).toString('hex');
    await writeFile(this.tokenPath, this.token, { mode: 0o600 });
    const port = await freePort();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await this.stopBrowser();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const send = (status: number, body: object) => {
      const payload = Buffer.from(JSON.stringify(body));
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': String(payload.length),
      });
      response.end(payload);
    };
    try {
      if (request.url === '/health') {
        send(200, { ready: true });
        return;
      }
      if (!authorized(request.headers.authorization, this.token)) {
        send(403, { error: 'Forbidden' });
        return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        send(200, await this.status());
        return;
      }
      if (request.method === 'POST' && request.url === '/open') {
        await this.open();
        send(200, { ready: true, browserMode: 'external' });
        return;
      }
      if (request.method === 'POST' && request.url === '/snapshot') {
        send(200, await this.snapshot());
        return;
      }
      if (request.method === 'POST' && request.url === '/logout') {
        await this.logout();
        send(200, { connected: false, browserMode: 'external' });
        return;
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      send(503, { error: error instanceof Error ? error.message : 'Браузер недоступен' });
    }
  }

  private async status(): Promise<SessionSnapshot> {
    if (this.browser && this.debuggingPort) {
      try {
        return await this.readSnapshot();
      } catch {
        await this.stopBrowser();
      }
    }
    return { connected: await pathExists(this.markerPath), browserMode: 'external' };
  }

  private async open(): Promise<void> {
    if (!this.browser || this.headless) {
      await this.stopBrowser();
      await this.launchBrowser(false);
    }
    const targets = await this.fetchTargets();
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      await this.cdp(page.webSocketDebuggerUrl, 'Page.navigate', {
        url: 'https://www.youtube.com/',
      });
      await this.cdp(page.webSocketDebuggerUrl, 'Page.bringToFront');
    } else {
      const version = await this.browserVersion();
      if (!version.webSocketDebuggerUrl) throw new Error('Не удалось открыть YouTube');
      await this.cdp(version.webSocketDebuggerUrl, 'Target.createTarget', {
        url: 'https://www.youtube.com/',
      });
    }
  }

  private async snapshot(): Promise<SessionSnapshot> {
    if (!this.browser) {
      if (!(await pathExists(this.markerPath))) {
        return { connected: false, browserMode: 'external' };
      }
      await this.launchBrowser(true);
    }
    return await this.readSnapshot();
  }

  private async readSnapshot(): Promise<SessionSnapshot> {
    const version = await this.browserVersion();
    if (!version.webSocketDebuggerUrl) throw new Error('Браузер не отвечает');
    const result = (await this.cdp(version.webSocketDebuggerUrl, 'Storage.getCookies')) as {
      cookies?: CdpCookie[];
    };
    const cookies = (result.cookies ?? []).filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '');
      return (
        domain === 'youtube.com' ||
        domain.endsWith('.youtube.com') ||
        domain === 'google.com' ||
        domain.endsWith('.google.com')
      );
    });
    const connected = cookies.some((cookie) =>
      ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'].includes(cookie.name),
    );
    if (!connected) return { connected: false, browserMode: 'external' };

    const userAgent = this.headless
      ? await readFile(this.userAgentPath, 'utf8').catch(() => version.userAgent ?? '')
      : (version.userAgent ?? '');
    if (!this.headless && userAgent)
      await writeFile(this.userAgentPath, userAgent, { mode: 0o600 });
    await writeFile(this.markerPath, 'connected\n', { mode: 0o600 });
    const rows = ['# Netscape HTTP Cookie File'];
    for (const cookie of cookies) {
      const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`;
      rows.push(
        [
          domain,
          cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
          cookie.path,
          cookie.secure ? 'TRUE' : 'FALSE',
          String(Math.max(0, Math.trunc(cookie.expires ?? 0))),
          cookie.name,
          cookie.value,
        ].join('\t'),
      );
    }
    return {
      connected: true,
      cookies: `${rows.join('\n')}\n`,
      userAgent,
      browserMode: 'external',
    };
  }

  private async logout(): Promise<void> {
    await this.stopBrowser();
    await rm(this.profileDirectory, { recursive: true, force: true });
    await Promise.all([
      rm(this.markerPath, { force: true }),
      rm(this.userAgentPath, { force: true }),
    ]);
  }

  private async launchBrowser(headless: boolean): Promise<void> {
    const executable = await findBrowser();
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    this.debuggingPort = await freePort();
    this.headless = headless;
    const args = [
      `--remote-debugging-port=${this.debuggingPort}`,
      `--user-data-dir=${this.profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--hide-crash-restore-bubble',
      ...(headless ? ['--headless=new', '--disable-gpu'] : []),
      headless ? 'about:blank' : 'https://www.youtube.com/',
    ];
    this.browser = spawn(executable, args, { stdio: 'ignore', windowsHide: headless });
    this.browser.once('exit', () => {
      this.browser = undefined;
      this.debuggingPort = undefined;
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await this.browserVersion();
        return;
      } catch {
        if (this.browser.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await this.stopBrowser();
    throw new Error('Chrome или Edge не удалось запустить');
  }

  private async stopBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.debuggingPort = undefined;
    if (!browser || browser.exitCode !== null) return;
    browser.kill();
    await Promise.race([
      new Promise<void>((resolve) => browser.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }

  private async browserVersion(): Promise<BrowserVersion> {
    if (!this.debuggingPort) throw new Error('Браузер не запущен');
    const response = await fetch(`http://127.0.0.1:${this.debuggingPort}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('Браузер не отвечает');
    return (await response.json()) as BrowserVersion;
  }

  private async fetchTargets(): Promise<BrowserTarget[]> {
    if (!this.debuggingPort) throw new Error('Браузер не запущен');
    const response = await fetch(`http://127.0.0.1:${this.debuggingPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('Браузер не отвечает');
    return (await response.json()) as BrowserTarget[];
  }

  private async cdp(
    endpoint: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Браузер не ответил вовремя'));
      }, 10_000);
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        socket.close();
        callback();
      };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method, params }));
      });
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          if (message.id !== 1) return;
          if (message.error) {
            finish(() =>
              reject(new Error(message.error?.message ?? 'Команда браузера не выполнена')),
            );
          } else finish(() => resolve(message.result));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.addEventListener('error', () => {
        finish(() => reject(new Error('Не удалось подключиться к браузеру')));
      });
    });
  }
}
