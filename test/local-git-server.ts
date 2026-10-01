import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tempDirs: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const GIT_IDENTITY = ['-c', 'user.email=fixture@ai-agent-runner.test', '-c', 'user.name=fixture'];

/** Обычный (не bare) локальный git-репозиторий-источник с одним файлом. */
export function createSourceRepo(fileName = 'source.txt', content = 'hello from source repo\n'): string {
  const dir = makeTempDir('ai-agent-runner-src-repo-');
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, fileName), content);
  execFileSync('git', ['-C', dir, 'add', fileName]);
  execFileSync('git', ['-C', dir, ...GIT_IDENTITY, 'commit', '-qm', 'init']);
  return dir;
}

/** Bare-репозиторий, клонированный из source (для file:// и http-источников). */
export function createBareRepo(sourceDir: string, targetPath: string): string {
  mkdirSync(dirname(targetPath), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', sourceDir, targetPath]);
  return targetPath;
}

export interface AuthGitServer {
  baseUrl: string;
  rootDir: string;
  repoPath: string;
  authorizedRequests: number;
  close: () => Promise<void>;
}

/**
 * Локальный git smart-HTTP сервер с Basic-auth (без внешней сети): отдаёт bare-репозиторий
 * <rootDir>/<repoName>.git через `git http-backend`, принимая пароль только вида
 * `x-access-token:<token>` — ровно тот способ аутентификации, который использует runner.
 */
export async function startAuthGitServer(options: { repoName: string; token: string }): Promise<AuthGitServer> {
  const rootDir = makeTempDir('ai-agent-runner-git-server-');
  const repoPath = join(rootDir, `${options.repoName}.git`);
  const source = createSourceRepo();
  createBareRepo(source, repoPath);

  const expectedHeader = `Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`;
  let authorizedRequests = 0;

  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== expectedHeader) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ai-agent-runner-test"', 'Content-Type': 'text/plain' });
      res.end('auth required');
      return;
    }
    authorizedRequests += 1;
    const url = new URL(req.url ?? '/', 'http://local');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: rootDir,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(req.headers['content-length'] ?? ''),
    };
    const cgi = spawn('git', ['http-backend'], { env });
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    cgi.on('close', () => {
      const raw = Buffer.concat(chunks).toString('binary');
      const headerEnd = raw.search(/\r?\n\r?\n/);
      if (headerEnd < 0) {
        res.writeHead(500);
        res.end('git http-backend produced no headers');
        return;
      }
      const separatorLength = /\r?\n\r?\n/.exec(raw.slice(headerEnd))![0].length;
      const headLines = raw.slice(0, headerEnd).split(/\r?\n/);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headLines) {
        const statusMatch = /^Status:\s*(\d+)/.exec(line) ?? /^HTTP\/1\.[01]\s+(\d+)/.exec(line);
        if (statusMatch) {
          status = Number(statusMatch[1]);
          continue;
        }
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
      }
      res.writeHead(status, headers);
      res.end(Buffer.from(raw.slice(headerEnd + separatorLength), 'binary'));
    });
    req.pipe(cgi.stdin);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    rootDir,
    repoPath,
    get authorizedRequests() {
      return authorizedRequests;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
