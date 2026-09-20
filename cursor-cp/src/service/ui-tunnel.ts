/**
 * Quick Cloudflare Tunnel in front of the local dashboard.
 * Parses the trycloudflare.com URL from cloudflared stderr.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { logger } from '../util/logger.js';
import { getProjectRoot } from '../config/home.js';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NAMED_READY_RE = /registered tunnel connection|connection registered|tunnel connection/i;
const QUICK_READY_RE = /registered tunnel connection/i;

export interface UiTunnelOptions {
  namedToken?: string;
  namedHostname?: string;
}

export function extractTunnelUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? match[0].toLowerCase() : null;
}

export function normalizeTunnelHostname(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.protocol = 'https:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function resolveCloudflaredBin(): string {
  const fromEnv = process.env.CLOUDFLARED_BIN?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    resolve(getProjectRoot(), '../bin/cloudflared'),
    resolve(getProjectRoot(), 'bin/cloudflared'),
    resolve(homedir(), '.local/bin/cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cloudflared';
}

export class UiTunnel {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private localUrl: string;
  private options: UiTunnelOptions;

  constructor(localUrl: string, options: UiTunnelOptions = {}) {
    this.localUrl = localUrl;
    this.options = options;
  }

  getCurrentUrl(): string | null {
    return this.url;
  }

  isRunning(): boolean {
    if (this.url && this.namedHostname() && !this.options.namedToken) {
      return true;
    }
    return this.child !== null && this.child.exitCode === null;
  }

  private namedHostname(): string | null {
    return normalizeTunnelHostname(this.options.namedHostname || '');
  }

  async start(timeoutMs = 45_000): Promise<string> {
    if (this.url && this.isRunning()) {
      return this.url;
    }
    if (this.starting) {
      return this.starting;
    }

    const hostname = this.namedHostname();
    if (hostname && !this.options.namedToken) {
      this.url = hostname;
      return hostname;
    }

    this.starting = this.options.namedToken
      ? this.spawnNamedTunnel(timeoutMs, hostname)
      : this.spawnQuickTunnel(timeoutMs);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  stop(): void {
    this.starting = null;
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.url = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // already exited
    }
  }

  private spawnNamedTunnel(timeoutMs: number, hostname: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      this.killChild();

      const child = spawn(
        resolveCloudflaredBin(),
        ['tunnel', 'run', '--token', this.options.namedToken!, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      this.child = child;

      let settled = false;
      let buffer = '';

      const finishOk = (url: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.url = url;
        logger.info({ url }, 'Cloudflare named tunnel ready');
        resolve(url);
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop();
        reject(err);
      };

      const maybeReady = () => {
        if (hostname && NAMED_READY_RE.test(buffer)) {
          finishOk(hostname);
        }
      };

      const onChunk = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        maybeReady();
      };

      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);

      child.once('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          finishErr(
            new Error(
              'cloudflared is not installed. Place the binary at bin/cloudflared or run: brew install cloudflared'
            )
          );
          return;
        }
        finishErr(err);
      });

      child.once('exit', (code, signal) => {
        if (settled) return;
        finishErr(new Error(`cloudflared named tunnel exited (code=${code}, signal=${signal})`));
      });

      const timer = setTimeout(() => {
        if (hostname && this.child === child) {
          finishOk(hostname);
          return;
        }
        finishErr(new Error('Timed out waiting for named Cloudflare tunnel'));
      }, timeoutMs);
    });
  }

  private spawnQuickTunnel(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.killChild();

      // Prefer HTTP/2: many home networks block QUIC/UDP :7844.
      const child = spawn(
        resolveCloudflaredBin(),
        ['tunnel', '--url', this.localUrl, '--protocol', 'http2', '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      this.child = child;

      let settled = false;
      let buffer = '';
      let seenUrl: string | null = null;

      const finishOk = (url: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.url = url;
        logger.info({ url }, 'Cloudflare quick tunnel ready');
        resolve(url);
      };

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop();
        reject(err);
      };

      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        buffer += text;
        logger.debug({ text: text.trim() }, 'cloudflared output');
        const url = extractTunnelUrl(buffer);
        if (url) seenUrl = url;
        // URL banner alone is too early — wait until the edge connection registers.
        if (seenUrl && QUICK_READY_RE.test(buffer)) {
          finishOk(seenUrl);
        }
      };

      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);

      child.once('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          finishErr(
            new Error(
              'cloudflared is not installed. Place the binary at bin/cloudflared or run: brew install cloudflared'
            )
          );
          return;
        }
        finishErr(err);
      });

      child.once('exit', (code, signal) => {
        if (settled) return;
        finishErr(
          new Error(`cloudflared exited (code=${code}, signal=${signal})`)
        );
      });

      const timer = setTimeout(() => {
        if (seenUrl && this.child === child) {
          finishOk(seenUrl);
          return;
        }
        finishErr(new Error('Timed out waiting for Cloudflare tunnel URL'));
      }, timeoutMs);
    });
  }
}

let singleton: UiTunnel | null = null;

export function getUiTunnel(localUrl: string, options?: UiTunnelOptions): UiTunnel {
  if (!singleton) {
    singleton = new UiTunnel(localUrl, options);
  }
  return singleton;
}

export function stopUiTunnel(): void {
  singleton?.stop();
  singleton = null;
}
