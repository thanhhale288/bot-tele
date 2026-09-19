/**
 * Phase 4 — run/verify core (test, lint, dev server, app preview, screenshot).
 * Subprocesses use argv arrays only; never a shell string.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { existsSync, openSync, closeSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { extractTunnelUrl, UiTunnel } from '../service/ui-tunnel.js';
import {
  runWorkspaceCommand,
  telegramPayloadForText,
  validateWorkspaceCwd,
  type TelegramCommandPayload,
  type WorkspaceCommandResult,
} from './workspace-shell.js';

export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;

const DASHBOARD_PORT = 8747;
const DEV_KILL_WAIT_MS = 2_000;
const DEV_KILL_POLL_MS = 50;
const NO_BROWSER_HINT =
  'No browser for /shot. Install Google Chrome or: npx playwright install chromium';
const NO_COMMAND_YET = 'No command has been run in this session yet.';

export interface LastCommandLog {
  command: string;
  cwd: string;
  combined: string;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
}

interface DevServerEntry {
  pid: number;
  script: string;
  logPath: string;
  cwd: string;
  child: ChildProcess;
}

interface PreviewEntry {
  port: number;
  url: string;
  tunnel: UiTunnel;
}

const lastLogs = new Map<string, LastCommandLog>();
const devServers = new Map<string, DevServerEntry>();
const previews = new Map<string, PreviewEntry>();

const CHROME_ABS_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/local/bin/google-chrome',
  '/usr/local/bin/chromium',
  '/opt/homebrew/bin/chromium',
  '/opt/google/chrome/chrome',
];

const CHROME_PATH_NAMES = ['google-chrome', 'chromium', 'google-chrome-stable', 'chromium-browser'];

export function detectNpmScript(
  scripts: Record<string, string> | undefined,
  candidates: string[]
): string | null {
  if (!scripts) return null;
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) return name;
  }
  return null;
}

export async function readPackageScripts(cwd: string): Promise<Record<string, string> | undefined> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) return undefined;

  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

export function testScriptCandidates(): string[] {
  return ['test'];
}

export function lintScriptCandidates(): string[] {
  return ['lint', 'typecheck', 'tsc'];
}

function rememberLog(sessionId: string, log: LastCommandLog): LastCommandLog {
  lastLogs.set(sessionId, log);
  return log;
}

function rememberFromResult(
  sessionId: string,
  result: WorkspaceCommandResult,
  startedAt = new Date().toISOString()
): LastCommandLog {
  return rememberLog(sessionId, {
    command: result.command,
    cwd: result.cwd,
    combined: result.combined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    startedAt,
  });
}

function payloadForScript(result: WorkspaceCommandResult, script: string): TelegramCommandPayload {
  const headerParts = [
    `$ ${result.command}`,
    result.timedOut ? 'timed out' : `exit ${result.exitCode ?? '?'}`,
    result.truncated ? 'truncated' : null,
  ].filter(Boolean);
  return telegramPayloadForText(
    headerParts.join(' · '),
    result.combined.trim() || '(no output)',
    `${script}.log`
  );
}

function npmArgsForScript(script: string): string[] {
  return script === 'test' ? ['test'] : ['run', script, '--'];
}

export async function runNpmScript(
  cwd: string,
  script: string,
  sessionId: string,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS
): Promise<{
  ok: boolean;
  script: string;
  result: WorkspaceCommandResult;
  payload: TelegramCommandPayload;
}> {
  const startedAt = new Date().toISOString();
  const result = await runWorkspaceCommand({
    cwd,
    command: 'npm',
    args: npmArgsForScript(script),
    timeoutMs,
  });
  rememberFromResult(sessionId, result, startedAt);
  return {
    ok: result.ok,
    script,
    result,
    payload: payloadForScript(result, script),
  };
}

export function getLastCommandLog(sessionId: string): LastCommandLog | undefined {
  return lastLogs.get(sessionId);
}

export function formatLastCommandLog(log: LastCommandLog | undefined): string {
  if (!log) return NO_COMMAND_YET;
  const status = log.timedOut ? 'timed out' : `exit ${log.exitCode ?? '?'}`;
  const body = log.combined.trim() || '(no output)';
  return [`$ ${log.command}`, status, `cwd: ${log.cwd}`, `started: ${log.startedAt}`, '', body].join(
    '\n'
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function liveDevServer(sessionId: string): DevServerEntry | undefined {
  const entry = devServers.get(sessionId);
  if (!entry) return undefined;
  if (entry.child.exitCode !== null || !isPidAlive(entry.pid)) {
    devServers.delete(sessionId);
    return undefined;
  }
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function killProcessGroup(pid: number, child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // fall through to the child handle
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

async function stopDevProcess(entry: DevServerEntry): Promise<void> {
  killProcessGroup(entry.pid, entry.child, 'SIGTERM');
  const terminated = await waitForChildExit(entry.child, DEV_KILL_WAIT_MS);
  if (terminated && !isPidAlive(entry.pid)) return;

  const deadline = Date.now() + DEV_KILL_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(entry.pid) || entry.child.exitCode !== null) return;
    await sleep(DEV_KILL_POLL_MS);
  }

  killProcessGroup(entry.pid, entry.child, 'SIGKILL');
  await waitForChildExit(entry.child, 1_000);
}

export async function startDevServer(
  cwd: string,
  sessionId: string,
  script?: string
): Promise<{ ok: boolean; message: string; pid?: number; script: string }> {
  const existing = liveDevServer(sessionId);
  if (existing) {
    return {
      ok: true,
      message: `Dev server already running (pid ${existing.pid}, npm run ${existing.script}).`,
      pid: existing.pid,
      script: existing.script,
    };
  }

  const resolved =
    script?.trim() ||
    detectNpmScript(await readPackageScripts(cwd), ['dev', 'start']) ||
    'dev';

  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    rememberLog(sessionId, {
      command: `npm run ${resolved}`,
      cwd,
      combined: invalid,
      exitCode: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    return { ok: false, message: invalid, script: resolved };
  }

  const logDir = await mkdtemp(join(tmpdir(), 'cursor-cp-dev-'));
  const logPath = join(logDir, `${resolved.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`);

  let fd: number;
  try {
    fd = openSync(logPath, 'w');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, script: resolved };
  }

  let child: ChildProcess;
  try {
    child = spawn('npm', ['run', resolved], {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } catch (err) {
    closeSync(fd);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, script: resolved };
  }

  closeSync(fd);

  const spawnError = await new Promise<string | null>((resolve) => {
    if (child.pid) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve('Failed to start the dev server.'), 200);
    child.once('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      resolve(code === 'ENOENT' ? 'npm is not installed or not on PATH.' : err.message);
    });
  });

  if (spawnError || !child.pid) {
    rememberLog(sessionId, {
      command: `npm run ${resolved}`,
      cwd,
      combined: spawnError || 'Failed to start the dev server.',
      exitCode: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    return { ok: false, message: spawnError || 'Failed to start the dev server.', script: resolved };
  }

  child.unref();

  const entry: DevServerEntry = {
    pid: child.pid,
    script: resolved,
    logPath,
    cwd,
    child,
  };
  devServers.set(sessionId, entry);

  const combined = `Started npm run ${resolved} (pid ${entry.pid}). Log: ${logPath}`;
  rememberLog(sessionId, {
    command: `npm run ${resolved}`,
    cwd,
    combined,
    exitCode: null,
    timedOut: false,
    startedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    message: combined,
    pid: entry.pid,
    script: resolved,
  };
}

export async function stopDevServer(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const entry = devServers.get(sessionId);
  if (!entry) {
    return { ok: true, message: 'No dev server is running for this session.' };
  }
  devServers.delete(sessionId);
  await stopDevProcess(entry);
  rememberLog(sessionId, {
    command: `stop npm run ${entry.script}`,
    cwd: entry.cwd,
    combined: `Stopped pid ${entry.pid}.`,
    exitCode: 0,
    timedOut: false,
    startedAt: new Date().toISOString(),
  });
  return { ok: true, message: `Stopped npm run ${entry.script} (pid ${entry.pid}).` };
}

export function getDevServer(
  sessionId: string
): { pid: number; script: string; logPath: string } | undefined {
  const entry = liveDevServer(sessionId);
  if (!entry) return undefined;
  return { pid: entry.pid, script: entry.script, logPath: entry.logPath };
}

export function listDevServers(): Array<{ sessionId: string; pid: number; script: string }> {
  const out: Array<{ sessionId: string; pid: number; script: string }> = [];
  for (const [sessionId] of [...devServers.keys()]) {
    const live = liveDevServer(sessionId);
    if (live) {
      out.push({ sessionId, pid: live.pid, script: live.script });
    }
  }
  return out;
}

export function listOpenPreviews(): Array<{ sessionId: string; port: number; url: string }> {
  return [...previews.entries()].map(([sessionId, entry]) => ({
    sessionId,
    port: entry.port,
    url: entry.tunnel.getCurrentUrl() ?? entry.url,
  }));
}

function invalidPreviewPort(port: number): string | null {
  if (port === DASHBOARD_PORT) {
    return 'Use /ui for the dashboard. /preview is for the app.';
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return `Invalid port: ${port}`;
  }
  return null;
}

export async function startAppPreview(
  sessionId: string,
  port: number
): Promise<{ ok: boolean; message: string; url?: string }> {
  const refused = invalidPreviewPort(port);
  if (refused) {
    return { ok: false, message: refused };
  }

  const existing = previews.get(sessionId);
  if (existing && existing.port === port && existing.tunnel.isRunning()) {
    const url = existing.tunnel.getCurrentUrl() ?? existing.url;
    return { ok: true, message: `Preview already running on port ${port}: ${url}`, url };
  }
  if (existing) {
    existing.tunnel.stop();
    previews.delete(sessionId);
  }

  const localUrl = `http://127.0.0.1:${port}`;
  const tunnel = new UiTunnel(localUrl);
  try {
    const url = await tunnel.start();
    if (!extractTunnelUrl(url)) {
      tunnel.stop();
      return { ok: false, message: 'Tunnel did not return a trycloudflare URL.' };
    }
    previews.set(sessionId, { port, url, tunnel });
    return { ok: true, message: `Preview: ${url}`, url };
  } catch (err) {
    tunnel.stop();
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function stopAppPreview(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const existing = previews.get(sessionId);
  if (!existing) {
    return { ok: true, message: 'No preview is running for this session.' };
  }
  existing.tunnel.stop();
  previews.delete(sessionId);
  return { ok: true, message: 'Preview tunnel stopped.' };
}

export function parsePreviewPort(arg: string, fallback?: number): number | null {
  const trimmed = arg.trim();
  if (!trimmed) {
    return fallback !== undefined ? fallback : null;
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

export function isAllowedShotUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveChromeBin(): string | null {
  const fromEnv = process.env.CHROME_BIN?.trim() || process.env.CHROMIUM_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  for (const candidate of CHROME_ABS_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const name of CHROME_PATH_NAMES) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

interface PlaywrightLike {
  chromium: {
    launch: (opts: { headless: boolean }) => Promise<{
      newPage: () => Promise<{
        setViewportSize: (s: { width: number; height: number }) => Promise<void>;
        goto: (url: string, opts?: { timeout?: number }) => Promise<unknown>;
        screenshot: (opts: { path: string; type: 'png' }) => Promise<Buffer>;
      }>;
      close: () => Promise<void>;
    }>;
  };
}

function loadPlaywright(): PlaywrightLike | null {
  try {
    const require = createRequire(import.meta.url);
    return require('playwright') as PlaywrightLike;
  } catch {
    try {
      const require = createRequire(import.meta.url);
      return require('playwright-core') as PlaywrightLike;
    } catch {
      return null;
    }
  }
}

async function screenshotWithChrome(
  chromeBin: string,
  url: string,
  outPath: string
): Promise<WorkspaceCommandResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'cursor-cp-shot-'));
  return runWorkspaceCommand({
    cwd: workDir,
    command: chromeBin,
    args: [
      '--headless=new',
      '--disable-gpu',
      `--screenshot=${outPath}`,
      '--window-size=1280,720',
      url,
    ],
    timeoutMs: 45_000,
  });
}

async function screenshotWithPlaywright(url: string, outPath: string): Promise<boolean> {
  const playwright = loadPlaywright();
  if (!playwright) return false;
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url, { timeout: 30_000 });
    await page.screenshot({ path: outPath, type: 'png' });
    return true;
  } finally {
    await browser.close();
  }
}

function shotFilename(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/[^A-Za-z0-9.-]+/g, '_') || 'page';
    return `shot-${host}.png`;
  } catch {
    return 'shot.png';
  }
}

export async function capturePageScreenshot(
  sessionId: string,
  url: string
): Promise<{ ok: boolean; message: string; png?: Buffer; filename?: string }> {
  const trimmed = url.trim();
  const startedAt = new Date().toISOString();
  const cwd = tmpdir();

  if (!isAllowedShotUrl(trimmed)) {
    const message = 'URL must be http or https. file:, javascript:, and data: are not allowed.';
    rememberLog(sessionId, {
      command: `shot ${trimmed || '(empty)'}`,
      cwd,
      combined: message,
      exitCode: 1,
      timedOut: false,
      startedAt,
    });
    return { ok: false, message };
  }

  const outDir = await mkdtemp(join(tmpdir(), 'cursor-cp-shot-'));
  const outPath = join(outDir, 'shot.png');
  const filename = shotFilename(trimmed);
  const command = `shot ${trimmed}`;

  const chromeBin = resolveChromeBin();
  if (chromeBin) {
    const result = await screenshotWithChrome(chromeBin, trimmed, outPath);
    if (result.ok && existsSync(outPath)) {
      const png = await readFile(outPath);
      if (png.length > 0) {
        rememberFromResult(
          sessionId,
          {
            ...result,
            command,
            combined: `Screenshot captured via Chrome (${png.length} bytes).`,
          },
          startedAt
        );
        return {
          ok: true,
          message: `Screenshot of ${trimmed}`,
          png,
          filename,
        };
      }
    }
  }

  try {
    const viaPlaywright = await screenshotWithPlaywright(trimmed, outPath);
    if (viaPlaywright && existsSync(outPath)) {
      const png = await readFile(outPath);
      if (png.length > 0) {
        rememberLog(sessionId, {
          command,
          cwd,
          combined: `Screenshot captured via Playwright (${png.length} bytes).`,
          exitCode: 0,
          timedOut: false,
          startedAt,
        });
        return {
          ok: true,
          message: `Screenshot of ${trimmed}`,
          png,
          filename,
        };
      }
    }
  } catch {
    // optional playwright path — fall through to the install hint
  }

  rememberLog(sessionId, {
    command,
    cwd,
    combined: NO_BROWSER_HINT,
    exitCode: 1,
    timedOut: false,
    startedAt,
  });
  return { ok: false, message: NO_BROWSER_HINT };
}

export function parseDevArg(arg: string): { stop: boolean; script?: string } {
  const trimmed = arg.trim();
  if (trimmed === 'stop') return { stop: true };
  if (!trimmed || trimmed === 'start') return { stop: false };
  return { stop: false, script: trimmed };
}

export function parsePreviewArg(arg: string): { stop: boolean; port?: number } {
  const trimmed = arg.trim();
  if (trimmed === 'stop') return { stop: true };
  if (!trimmed) return { stop: false };
  const port = parsePreviewPort(trimmed);
  if (port === null) return { stop: false };
  return { stop: false, port };
}
