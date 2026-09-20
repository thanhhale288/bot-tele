/**
 * Phase 4 — run/verify core (test, lint, dev server, app preview, screenshot).
 * Subprocesses use argv arrays only; never a shell string.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { createConnection } from 'net';
import { existsSync, openSync, closeSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, dirname, join, relative } from 'path';
import { pathToFileURL } from 'url';
import { extractTunnelUrl, UiTunnel } from '../service/ui-tunnel.js';
import {
  runWorkspaceCommand,
  telegramPayloadForText,
  validateWorkspaceCwd,
  type TelegramCommandPayload,
  type WorkspaceCommandResult,
} from './workspace-shell.js';

export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;
export const DEFAULT_RUNCODE_WAIT_MS = 60_000;

const DASHBOARD_PORT = 8747;
const DEV_KILL_WAIT_MS = 2_000;
const DEV_KILL_POLL_MS = 50;
/** Candidate HTTP app ports. Omit 5000 — macOS AirPlay Receiver often owns it. */
const COMMON_APP_PORTS = [
  5173, 5174, 3000, 3001, 8000, 8080, 4200, 8501, 4321, 8787, 9000, 4000, 18789,
];
/** TCP-open but not a real web app (macOS AirPlay / Control Center). */
const BLOCKED_APP_PORTS = new Set([5000, 7000]);
const PORT_IN_TEXT_RE =
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::):(\d{2,5})\b|(?:--port|-p|--web-port)\s*=?\s*(\d{2,5})\b|PORT[=:]\s*(\d{2,5})\b/gi;
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
/** Secondary process for fullstack /runcode (API alongside UI). */
const companionServers = new Map<string, DevServerEntry>();
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

function liveCompanionServer(sessionId: string): DevServerEntry | undefined {
  const entry = companionServers.get(sessionId);
  if (!entry) return undefined;
  if (entry.child.exitCode !== null || !isPidAlive(entry.pid)) {
    companionServers.delete(sessionId);
    return undefined;
  }
  return entry;
}

function processMapForRole(role: 'primary' | 'api'): Map<string, DevServerEntry> {
  return role === 'api' ? companionServers : devServers;
}

function liveForRole(sessionId: string, role: 'primary' | 'api'): DevServerEntry | undefined {
  return role === 'api' ? liveCompanionServer(sessionId) : liveDevServer(sessionId);
}

function killListenersOnPort(port: number): void {
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' }
    );
    for (const raw of out.split(/\n+/)) {
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  } catch {
    // nothing listening
  }
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

export interface ManagedProcessSpec {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

function findViteConfigFile(cwd: string): string | null {
  for (const name of [
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
  ]) {
    const full = join(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Overlay so Vite accepts Cloudflare hosts and (optionally) proxies /api → backend. */
export async function buildViteTunnelSpec(
  cwd: string,
  label = 'vite',
  opts: { apiProxyPort?: number } = {}
): Promise<ManagedProcessSpec | null> {
  const userConfig = findViteConfigFile(cwd);
  if (!userConfig) return null;

  // Must live inside the project so `import from 'vite'` resolves node_modules.
  const overlay = join(cwd, '.cursor-cp.vite.tunnel.mjs');
  const userUrl = pathToFileURL(userConfig).href;
  const apiPort = opts.apiProxyPort;
  const proxyBlock =
    apiPort && Number.isInteger(apiPort)
      ? `proxy: {
      '/api': { target: ${JSON.stringify(`http://127.0.0.1:${apiPort}`)}, changeOrigin: true },
    },`
      : '';
  writeFileSync(
    overlay,
    `import { mergeConfig } from 'vite';
import userMod from ${JSON.stringify(userUrl)};
const user = userMod?.default ?? userMod;
export default async function (env) {
  const resolved = typeof user === 'function' ? await user(env) : user;
  return mergeConfig(resolved ?? {}, {
    server: {
      host: true,
      allowedHosts: true,
      ${proxyBlock}
    },
  });
}
`,
    'utf8'
  );

  return {
    label,
    command: 'npx',
    args: ['--no-install', 'vite', '--config', overlay],
    cwd,
    // Empty string → same-origin /api/... through the Cloudflare UI tunnel + Vite proxy.
    env: apiPort ? { VITE_API_URL: '' } : undefined,
  };
}

export async function startManagedProcess(
  sessionId: string,
  spec: ManagedProcessSpec,
  role: 'primary' | 'api' = 'primary'
): Promise<{ ok: boolean; message: string; pid?: number; script: string; logPath?: string }> {
  const map = processMapForRole(role);
  const existing = liveForRole(sessionId, role);
  if (existing) {
    return {
      ok: true,
      message: `Already running (pid ${existing.pid}, ${existing.script}).`,
      pid: existing.pid,
      script: existing.script,
      logPath: existing.logPath,
    };
  }

  const display = [spec.command, ...spec.args].join(' ');
  const invalid = validateWorkspaceCwd(spec.cwd);
  if (invalid) {
    rememberLog(sessionId, {
      command: display,
      cwd: spec.cwd,
      combined: invalid,
      exitCode: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    return { ok: false, message: invalid, script: spec.label };
  }

  const logDir = await mkdtemp(join(tmpdir(), 'cursor-cp-dev-'));
  const logPath = join(logDir, `${spec.label.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`);

  let fd: number;
  try {
    fd = openSync(logPath, 'w');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, script: spec.label };
  }

  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
  } catch (err) {
    closeSync(fd);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, script: spec.label };
  }

  closeSync(fd);

  const spawnError = await new Promise<string | null>((resolve) => {
    if (child.pid) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve('Failed to start the process.'), 200);
    child.once('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      resolve(
        code === 'ENOENT'
          ? `${spec.command} is not installed or not on PATH.`
          : err.message
      );
    });
  });

  if (spawnError || !child.pid) {
    rememberLog(sessionId, {
      command: display,
      cwd: spec.cwd,
      combined: spawnError || 'Failed to start the process.',
      exitCode: null,
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    return {
      ok: false,
      message: spawnError || 'Failed to start the process.',
      script: spec.label,
    };
  }

  child.unref();

  const entry: DevServerEntry = {
    pid: child.pid,
    script: spec.label,
    logPath,
    cwd: spec.cwd,
    child,
  };
  map.set(sessionId, entry);

  const combined = `Started ${display} (pid ${entry.pid}). Log: ${logPath}`;
  rememberLog(sessionId, {
    command: display,
    cwd: spec.cwd,
    combined,
    exitCode: null,
    timedOut: false,
    startedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    message: combined,
    pid: entry.pid,
    script: spec.label,
    logPath,
  };
}

export async function startDevServer(
  cwd: string,
  sessionId: string,
  script?: string
): Promise<{ ok: boolean; message: string; pid?: number; script: string }> {
  const resolved =
    script?.trim() ||
    detectNpmScript(await readPackageScripts(cwd), ['dev', 'start']) ||
    'dev';

  return startManagedProcess(sessionId, {
    label: resolved,
    command: 'npm',
    args: ['run', resolved],
    cwd,
  });
}

export async function stopDevServer(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const messages: string[] = [];

  const companion = companionServers.get(sessionId);
  if (companion) {
    companionServers.delete(sessionId);
    await stopDevProcess(companion);
    messages.push(`Stopped ${companion.script} (pid ${companion.pid}).`);
  }

  const entry = devServers.get(sessionId);
  if (entry) {
    devServers.delete(sessionId);
    await stopDevProcess(entry);
    rememberLog(sessionId, {
      command: `stop ${entry.script}`,
      cwd: entry.cwd,
      combined: `Stopped pid ${entry.pid}.`,
      exitCode: 0,
      timedOut: false,
      startedAt: new Date().toISOString(),
    });
    messages.push(`Stopped ${entry.script} (pid ${entry.pid}).`);
  }

  if (messages.length === 0) {
    return { ok: true, message: 'No dev server is running for this session.' };
  }
  return { ok: true, message: messages.join('\n') };
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

export function parseRunCodeArg(arg: string): { stop: boolean; port?: number } {
  return parsePreviewArg(arg);
}

export interface RunPlan {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  preferredPorts: number[];
  kind: 'npm' | 'uvicorn' | 'flutter' | 'make';
}

function safeReadText(path: string, maxBytes = 80_000): string {
  try {
    const buf = readFileSync(path);
    return buf.slice(0, maxBytes).toString('utf8');
  } catch {
    return '';
  }
}

function listSubdirs(root: string, maxDepth: number): string[] {
  const out: string[] = [root];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.dart_tool',
    'venv',
    '.venv',
    '__pycache__',
    'coverage',
    'target',
  ]);

  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(full);
      queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return out;
}

function portsFromText(...texts: string[]): number[] {
  const found = new Set<number>();
  for (const text of texts) {
    if (!text) continue;
    PORT_IN_TEXT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PORT_IN_TEXT_RE.exec(text)) !== null) {
      const raw = match[1] || match[2] || match[3];
      const port = Number(raw);
      if (
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        port !== DASHBOARD_PORT &&
        !BLOCKED_APP_PORTS.has(port)
      ) {
        found.add(port);
      }
    }
  }
  return [...found];
}

export function extractPortsFromLog(text: string): number[] {
  return portsFromText(text);
}

function resolvePythonBin(): string {
  for (const name of ['python3', 'python']) {
    const pathDirs = (process.env.PATH ?? '').split(delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (existsSync(candidate)) return name;
    }
  }
  return 'python3';
}

function filterAppPorts(ports: number[]): number[] {
  return [...new Set(ports)].filter(
    (p) => p !== DASHBOARD_PORT && !BLOCKED_APP_PORTS.has(p) && p > 0 && p <= 65535
  );
}

function uvicornPlanForMainPy(dir: string, body: string): { score: number; plan: RunPlan } | null {
  const reqNearby =
    safeReadText(join(dir, 'requirements.txt')) ||
    safeReadText(join(dir, '..', 'requirements.txt')) ||
    safeReadText(join(dir, '..', '..', 'requirements.txt'));
  const makefileNearby =
    safeReadText(join(dir, 'Makefile')) +
    safeReadText(join(dir, '..', 'Makefile')) +
    safeReadText(join(dir, '..', '..', 'Makefile'));

  if (
    !/FastAPI|uvicorn/i.test(body) &&
    !/uvicorn|fastapi/i.test(reqNearby) &&
    !/uvicorn/i.test(makefileNearby)
  ) {
    return null;
  }

  const ports = filterAppPorts([
    ...portsFromText(body, reqNearby, makefileNearby),
    8000,
    ...COMMON_APP_PORTS,
  ]);
  const port = ports[0] ?? 8000;
  const py = resolvePythonBin();

  // Monorepo: <root>/backend/app/main.py → uvicorn backend.app.main:app from <root>
  const parent = dirname(dir);
  const grand = dirname(parent);
  const normalized = dir.replace(/\\/g, '/');
  const isBackendApp =
    /\/backend\/app$/i.test(normalized) ||
    /uvicorn\s+backend\.app\.main:app/i.test(makefileNearby);

  if (isBackendApp && existsSync(join(grand, 'backend', 'app', 'main.py'))) {
    return {
      score: 88,
      plan: {
        kind: 'uvicorn',
        label: 'uvicorn',
        command: py,
        args: [
          '-m',
          'uvicorn',
          'backend.app.main:app',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        cwd: grand,
        preferredPorts: ports,
      },
    };
  }

  return {
    score: /FastAPI/i.test(body) ? 90 : 70,
    plan: {
      kind: 'uvicorn',
      label: 'uvicorn',
      command: py,
      args: ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)],
      cwd: dir,
      preferredPorts: ports,
    },
  };
}

function scoreAndPlanForDir(dir: string): { score: number; plan: RunPlan } | null {
  const makefile = join(dir, 'Makefile');
  if (existsSync(makefile)) {
    const text = safeReadText(makefile);
    // Prefer UI — /runcode is for a browsable Cloudflare link.
    if (/\bfe\b/.test(text) && existsSync(join(dir, 'frontend', 'package.json'))) {
      return {
        score: 120,
        plan: {
          kind: 'npm',
          label: 'dev',
          command: 'npm',
          args: ['run', 'dev'],
          cwd: join(dir, 'frontend'),
          preferredPorts: filterAppPorts([...portsFromText(text), 5173, ...COMMON_APP_PORTS]),
        },
      };
    }
    const makeMatch = text.match(/uvicorn\s+([\w.]+):app[^\n]*--port\s+(\d+)/i);
    if (makeMatch && /\bapi\b/.test(text)) {
      const module = makeMatch[1];
      const port = Number(makeMatch[2]) || 8000;
      const py = resolvePythonBin();
      return {
        score: 100,
        plan: {
          kind: 'uvicorn',
          label: 'uvicorn',
          command: py,
          args: [
            '-m',
            'uvicorn',
            `${module}:app`,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          cwd: dir,
          preferredPorts: filterAppPorts([port, ...COMMON_APP_PORTS]),
        },
      };
    }
    const target = /\brun-backend\b/.test(text)
      ? 'run-backend'
      : /\bapi\b/.test(text)
        ? 'api'
        : /\bdev\b/.test(text)
          ? 'dev'
          : /\brun\b/.test(text)
            ? 'run'
            : null;
    if (target) {
      return {
        score: 60,
        plan: {
          kind: 'make',
          label: `make-${target}`,
          command: 'make',
          args: [target],
          cwd: dir,
          preferredPorts: filterAppPorts([...portsFromText(text), 8000, ...COMMON_APP_PORTS]),
        },
      };
    }
  }

  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const raw = safeReadText(pkgPath);
      const parsed = JSON.parse(raw) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = parsed.scripts ?? {};
      const scriptName = detectNpmScript(scripts, ['dev', 'start', 'serve', 'preview']);
      if (scriptName) {
        const scriptBody = scripts[scriptName] ?? '';
        const deps = {
          ...(parsed.dependencies ?? {}),
          ...(parsed.devDependencies ?? {}),
        };
        const preferred = filterAppPorts([
          ...portsFromText(
            scriptBody,
            safeReadText(join(dir, 'vite.config.ts')),
            safeReadText(join(dir, 'vite.config.js')),
            safeReadText(join(dir, '.env'))
          ),
          ...(deps.vite || deps['@vitejs/plugin-react'] ? [5173] : []),
          ...(deps.next ? [3000] : []),
          ...COMMON_APP_PORTS,
        ]);
        let score = 80;
        if (deps.vite || /vite/.test(scriptBody)) score = 115;
        if (deps.next || /next/.test(scriptBody)) score = 110;
        return {
          score,
          plan: {
            kind: 'npm',
            label: scriptName,
            command: 'npm',
            args: ['run', scriptName],
            cwd: dir,
            preferredPorts: preferred,
          },
        };
      }
    } catch {
      // ignore bad package.json
    }
  }

  const mainPy = join(dir, 'main.py');
  if (existsSync(mainPy)) {
    const hit = uvicornPlanForMainPy(dir, safeReadText(mainPy));
    if (hit) return hit;
  }

  const pubspec = join(dir, 'pubspec.yaml');
  if (existsSync(pubspec)) {
    return {
      score: 55,
      plan: {
        kind: 'flutter',
        label: 'flutter-web',
        command: 'flutter',
        args: ['run', '-d', 'web-server', '--web-hostname', '127.0.0.1', '--web-port', '8080'],
        cwd: dir,
        preferredPorts: filterAppPorts([8080, ...COMMON_APP_PORTS]),
      },
    };
  }

  return null;
}

export async function detectRunPlan(cwd: string): Promise<RunPlan | null> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) return null;

  let best: { score: number; plan: RunPlan } | null = null;
  for (const dir of listSubdirs(cwd, 3)) {
    const hit = scoreAndPlanForDir(dir);
    if (!hit) continue;
    // Prefer shallower paths when scores are close
    const depthPenalty = relative(cwd, dir).split('/').filter(Boolean).length * 2;
    const adjusted = { score: hit.score - depthPenalty, plan: hit.plan };
    if (!best || adjusted.score > best.score) best = adjusted;
  }
  return best?.plan ?? null;
}

function resolveProjectPython(workspaceRoot: string): string {
  for (const rel of ['.venv/bin/python', '.venv/bin/python3', 'venv/bin/python']) {
    const full = join(workspaceRoot, rel);
    if (existsSync(full)) return full;
  }
  return resolvePythonBin();
}

/**
 * When /runcode picks a Vite UI, also find the sibling FastAPI/uvicorn API
 * (e.g. AI in Data Economy: frontend + Makefile api).
 */
export function detectCompanionApiPlan(
  workspaceRoot: string,
  uiPlan: RunPlan
): RunPlan | null {
  if (uiPlan.kind !== 'npm') return null;
  if (!findViteConfigFile(uiPlan.cwd)) return null;

  const makefile = join(workspaceRoot, 'Makefile');
  if (existsSync(makefile)) {
    const text = safeReadText(makefile);
    const makeMatch = text.match(/uvicorn\s+([\w.]+):app[^\n]*--port\s+(\d+)/i);
    if (makeMatch && (/\bapi\b/.test(text) || /backend\.app\.main/.test(makeMatch[1]))) {
      const module = makeMatch[1];
      const port = Number(makeMatch[2]) || 8000;
      const py = resolveProjectPython(workspaceRoot);
      return {
        kind: 'uvicorn',
        label: 'api',
        command: py,
        args: [
          '-m',
          'uvicorn',
          `${module}:app`,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        cwd: workspaceRoot,
        preferredPorts: filterAppPorts([port]),
      };
    }
  }

  for (const dir of listSubdirs(workspaceRoot, 3)) {
    if (dir === uiPlan.cwd || dir.startsWith(`${uiPlan.cwd}/`)) continue;
    const mainPy = join(dir, 'main.py');
    if (!existsSync(mainPy)) continue;
    const hit = uvicornPlanForMainPy(dir, safeReadText(mainPy));
    if (!hit || hit.plan.kind !== 'uvicorn') continue;
    return { ...hit.plan, label: 'api' };
  }

  return null;
}

export function probeLocalPort(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * True only if something answers HTTP and is not macOS AirPlay / Control Center.
 * TCP-open alone is not enough (port 5000 is often AirTunes).
 */
export async function probeHttpAppPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 800
): Promise<boolean> {
  if (BLOCKED_APP_PORTS.has(port) || port === DASHBOARD_PORT) return false;
  if (!(await probeLocalPort(port, host, Math.min(timeoutMs, 400)))) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const server = (res.headers.get('server') || '').toLowerCase();
    if (/airtunes|airplay/.test(server)) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Detect Vite blocking Cloudflare Host headers (allowedHosts). */
export async function probeAllowsCloudflareHost(
  port: number,
  host = '127.0.0.1'
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const res = await fetch(`http://${host}:${port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Host: 'probe.trycloudflare.com' },
    });
    const text = await res.text();
    if (/not allowed|allowedHosts/i.test(text)) return false;
    return res.status !== 403 || !/Blocked request/i.test(text);
  } catch {
    // Some servers reject bad Host before responding — treat as blocked for Vite.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPublicTunnelUrl(
  url: string,
  timeoutMs = 20_000
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = 'unreachable';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = (await res.text()).slice(0, 500);
      if (/not allowed|allowedHosts|Blocked request/i.test(text)) {
        return {
          ok: false,
          status: res.status,
          detail: 'Vite blocked the Cloudflare hostname (allowedHosts).',
        };
      }
      if (res.status >= 500) {
        lastDetail = `Upstream returned HTTP ${res.status}`;
      } else {
        return { ok: true, status: res.status };
      }
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    await sleep(1_500);
  }
  return { ok: false, detail: lastDetail };
}

export async function waitForAnyPort(
  ports: number[],
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    logPath?: string;
    exclude?: number[];
  } = {}
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUNCODE_WAIT_MS;
  const intervalMs = opts.intervalMs ?? 500;
  const exclude = new Set([...(opts.exclude ?? []), DASHBOARD_PORT, ...BLOCKED_APP_PORTS]);
  const deadline = Date.now() + timeoutMs;
  const base = filterAppPorts(ports).filter((p) => !exclude.has(p));

  while (Date.now() < deadline) {
    const fromLog =
      opts.logPath && existsSync(opts.logPath)
        ? extractPortsFromLog(safeReadText(opts.logPath))
        : [];
    const ordered = filterAppPorts([...fromLog, ...base]).filter((p) => !exclude.has(p));
    for (const port of ordered) {
      if (await probeHttpAppPort(port)) return port;
    }
    await sleep(intervalMs);
  }
  return null;
}

export async function stopRunCode(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const preview = await stopAppPreview(sessionId);
  const dev = await stopDevServer(sessionId);
  return {
    ok: preview.ok && dev.ok,
    message: [dev.message, preview.message].filter(Boolean).join('\n'),
  };
}

export async function runCodeAndPreview(
  cwd: string,
  sessionId: string,
  opts: { port?: number; timeoutMs?: number } = {}
): Promise<{
  ok: boolean;
  message: string;
  url?: string;
  port?: number;
  label?: string;
}> {
  const plan = await detectRunPlan(cwd);
  if (!plan && opts.port === undefined) {
    return {
      ok: false,
      message:
        'Could not detect how to run this project (npm/FastAPI/Flutter/Makefile). Pick a workspace with /workspaces, or pass a port: /runcode 8000',
    };
  }

  const preferredPorts = filterAppPorts([
    ...(opts.port !== undefined ? [opts.port] : []),
    ...(plan?.preferredPorts ?? []),
    ...COMMON_APP_PORTS,
  ]);

  // Prefer Vite's real port when tunneling a frontend (avoid picking API :8000 first).
  const orderedPorts =
    plan?.kind === 'npm' && plan.preferredPorts.includes(5173)
      ? filterAppPorts([5173, 5174, ...preferredPorts])
      : preferredPorts;

  let alreadyUp: number | null = null;
  for (const port of orderedPorts) {
    if (!(await probeHttpAppPort(port))) continue;
    // Vite without allowedHosts looks healthy on localhost but 403s via Cloudflare.
    if (plan?.kind === 'npm' && findViteConfigFile(plan.cwd)) {
      if (!(await probeAllowsCloudflareHost(port))) {
        continue;
      }
    }
    alreadyUp = port;
    break;
  }

  const companion =
    plan && plan.kind === 'npm' ? detectCompanionApiPlan(cwd, plan) : null;

  // Fullstack: always (re)start so Vite gets /api proxy + VITE_API_URL='' for phone.
  if (companion) {
    alreadyUp = null;
  }

  let logPath: string | undefined;
  let label = plan?.label;
  let startedFresh = false;
  let apiPort: number | undefined;
  let apiLabel: string | undefined;

  if (alreadyUp === null) {
    if (!plan) {
      return {
        ok: false,
        message: `Nothing listening on port ${opts.port}. Could not auto-start this project.`,
      };
    }

    // Replace a Vite that blocks Cloudflare hosts (and any prior companion API).
    await stopDevServer(sessionId);
    for (const p of orderedPorts.slice(0, 4)) {
      killListenersOnPort(p);
    }
    if (companion?.preferredPorts[0]) {
      killListenersOnPort(companion.preferredPorts[0]);
    }
    await sleep(400);

    if (companion) {
      const apiSpec: ManagedProcessSpec = {
        label: companion.label,
        command: companion.command,
        args: companion.args,
        cwd: companion.cwd,
        env: { PYTHONPATH: companion.cwd },
      };
      const apiStarted = await startManagedProcess(sessionId, apiSpec, 'api');
      if (!apiStarted.ok) {
        return {
          ok: false,
          message: `Could not start API (${companion.label}): ${apiStarted.message}`,
          label: companion.label,
        };
      }
      apiLabel = companion.label;
      const waitedApi = await waitForAnyPort(companion.preferredPorts, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_RUNCODE_WAIT_MS,
        logPath: apiStarted.logPath,
      });
      if (waitedApi === null) {
        const logTail =
          apiStarted.logPath && existsSync(apiStarted.logPath)
            ? safeReadText(apiStarted.logPath).slice(-1200)
            : '';
        return {
          ok: false,
          message: [
            `API (${companion.label}) started but no port opened.`,
            logTail ? `API log:\n${logTail}` : null,
          ]
            .filter(Boolean)
            .join('\n\n'),
          label: companion.label,
        };
      }
      apiPort = waitedApi;
    }

    const viteSpec =
      plan.kind === 'npm' && findViteConfigFile(plan.cwd)
        ? await buildViteTunnelSpec(plan.cwd, plan.label, {
            apiProxyPort: apiPort ?? companion?.preferredPorts[0],
          })
        : null;
    const spec: ManagedProcessSpec = viteSpec ?? {
      label: plan.label,
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
    };

    const started = await startManagedProcess(sessionId, spec, 'primary');
    if (!started.ok) {
      return { ok: false, message: started.message, label: plan.label };
    }
    logPath = started.logPath;
    label = started.script;
    startedFresh = true;
  } else {
    label = label ?? `port-${alreadyUp}`;
  }

  const port =
    alreadyUp ??
    (await waitForAnyPort(orderedPorts, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_RUNCODE_WAIT_MS,
      logPath,
    }));

  if (port === null) {
    const logTail = logPath && existsSync(logPath) ? safeReadText(logPath).slice(-1200) : '';
    return {
      ok: false,
      message: [
        `Started ${label}, but no open HTTP port within ${(opts.timeoutMs ?? DEFAULT_RUNCODE_WAIT_MS) / 1000}s.`,
        'Try /runcode <port> once you know it, or /logs.',
        logTail ? `Log tail:\n${logTail}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      label,
    };
  }

  const preview = await startAppPreview(sessionId, port);
  if (!preview.ok || !preview.url) {
    return {
      ok: false,
      message: [
        startedFresh ? `Process started (${label}) on :${port}, but tunnel failed.` : null,
        preview.message,
      ]
        .filter(Boolean)
        .join('\n'),
      port,
      label,
    };
  }

  const publicOk = await verifyPublicTunnelUrl(preview.url);
  if (!publicOk.ok) {
    // Local DNS proxies (WARP/AdGuard on 127.0.2.2) often fail trycloudflare lookups
    // even when the tunnel is fine for phones. If Vite accepts the CF Host header, still OK.
    const hostOk = await probeAllowsCloudflareHost(port);
    const dnsFail = /ENOTFOUND|getaddrinfo|Could not resolve|fetch failed/i.test(
      publicOk.detail || ''
    );
    if (!(hostOk && dnsFail)) {
      return {
        ok: false,
        url: preview.url,
        port,
        label,
        message: [
          `Tunnel opened but the public URL failed: ${publicOk.detail ?? `HTTP ${publicOk.status}`}`,
          `Public: ${preview.url}`,
          `Local: http://127.0.0.1:${port}`,
          'If this is Vite, set server.allowedHosts: true in vite.config, then /runcode stop && /runcode.',
        ].join('\n'),
      };
    }
  }

  const where = plan ? relative(cwd, plan.cwd) || '.' : '.';
  return {
    ok: true,
    url: preview.url,
    port,
    label,
    message: [
      `✅ Running ${label} (${where})`,
      apiPort ? `API: ${apiLabel ?? 'api'} on http://127.0.0.1:${apiPort} (proxied via /api)` : null,
      `Local UI: http://127.0.0.1:${port}`,
      `Public: ${preview.url}`,
      alreadyUp !== null ? '(reused already-listening port)' : null,
      !publicOk.ok
        ? '(Mac DNS may block trycloudflare locally — open the link on phone/4G)'
        : null,
      'Stop with /runcode stop',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
