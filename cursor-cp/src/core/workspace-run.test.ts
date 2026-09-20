import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  capturePageScreenshot,
  detectNpmScript,
  detectRunPlan,
  extractPortsFromLog,
  formatLastCommandLog,
  getDevServer,
  getLastCommandLog,
  isAllowedShotUrl,
  parseDevArg,
  parsePreviewArg,
  parsePreviewPort,
  parseRunCodeArg,
  readPackageScripts,
  runNpmScript,
  startAppPreview,
  startDevServer,
  stopDevServer,
  testScriptCandidates,
  lintScriptCandidates,
} from './workspace-run.js';

function tempWorkspace(scripts: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ws-run-'));
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'ws-run-fixture', private: true, scripts }, null, 2)
  );
  return cwd;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('workspace-run', () => {
  it('detectNpmScript prefers the first existing candidate', async () => {
    expect(detectNpmScript({ lint: 'x', typecheck: 'y' }, ['typecheck', 'lint'])).toBe('typecheck');
    expect(detectNpmScript({ lint: 'x' }, ['typecheck', 'lint', 'tsc'])).toBe('lint');
    expect(detectNpmScript(undefined, ['test'])).toBeNull();
    expect(detectNpmScript({}, ['test'])).toBeNull();
    expect(testScriptCandidates()).toEqual(['test']);
    expect(lintScriptCandidates()).toEqual(['lint', 'typecheck', 'tsc']);

    const cwd = tempWorkspace({ lint: 'echo lint' });
    const scripts = await readPackageScripts(cwd);
    expect(detectNpmScript(scripts, lintScriptCandidates())).toBe('lint');
  });

  it('runNpmScript runs the test script and stores the last command log', async () => {
    const cwd = tempWorkspace({
      test: 'node -e "process.stdout.write(\'ok-test\')"',
    });
    const sessionId = 'sess-test-script';
    const ran = await runNpmScript(cwd, 'test', sessionId, 20_000);

    expect(ran.ok).toBe(true);
    expect(ran.script).toBe('test');
    expect(ran.result.combined).toContain('ok-test');
    expect(ran.payload.body).toContain('ok-test');
    expect(ran.payload.text).toContain('ok-test');
    expect(ran.payload.filename).toBe('test.log');

    const log = getLastCommandLog(sessionId);
    expect(log).toBeDefined();
    expect(log?.cwd).toBe(cwd);
    expect(log?.combined).toContain('ok-test');
    expect(log?.timedOut).toBe(false);
    expect(log?.exitCode).toBe(0);
    expect(log?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('formatLastCommandLog handles empty vs present', () => {
    expect(formatLastCommandLog(undefined)).toBe(
      'No command has been run in this session yet.'
    );
    const text = formatLastCommandLog({
      command: 'npm test',
      cwd: '/tmp/ws',
      combined: 'ok-test',
      exitCode: 0,
      timedOut: false,
      startedAt: '2026-09-19T00:00:00.000Z',
    });
    expect(text).toContain('npm test');
    expect(text).toContain('ok-test');
    expect(text).toContain('exit 0');
    expect(text).toContain('/tmp/ws');
  });

  it('parses /dev and /preview arguments', () => {
    expect(parseDevArg('stop')).toEqual({ stop: true });
    expect(parseDevArg('start')).toEqual({ stop: false });
    expect(parseDevArg('')).toEqual({ stop: false });
    expect(parseDevArg('  ')).toEqual({ stop: false });
    expect(parseDevArg('dev:web')).toEqual({ stop: false, script: 'dev:web' });

    expect(parsePreviewArg('stop')).toEqual({ stop: true });
    expect(parsePreviewArg('')).toEqual({ stop: false });
    expect(parsePreviewArg('3000')).toEqual({ stop: false, port: 3000 });
    expect(parsePreviewArg('nope')).toEqual({ stop: false });

    expect(parseRunCodeArg('stop')).toEqual({ stop: true });
    expect(parseRunCodeArg('8000')).toEqual({ stop: false, port: 8000 });
    expect(parseRunCodeArg('')).toEqual({ stop: false });

    expect(parsePreviewPort('', 5173)).toBe(5173);
    expect(parsePreviewPort('3000')).toBe(3000);
    expect(parsePreviewPort('abc')).toBeNull();
    expect(parsePreviewPort('0')).toBeNull();
    expect(parsePreviewPort('99999')).toBeNull();
  });

  it('extractPortsFromLog finds listen addresses', () => {
    expect(extractPortsFromLog('Listening on http://127.0.0.1:5173/')).toContain(5173);
    expect(extractPortsFromLog('Uvicorn running on http://0.0.0.0:8000')).toContain(8000);
    expect(extractPortsFromLog('Local: http://localhost:3000')).toContain(3000);
    expect(extractPortsFromLog('--port 4321 ready')).toContain(4321);
  });

  it('detectRunPlan prefers FastAPI over Flutter when both exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-plan-'));
    const backend = join(root, 'backend');
    const mobile = join(root, 'mobile');
    mkdirSync(backend, { recursive: true });
    mkdirSync(mobile, { recursive: true });
    writeFileSync(join(backend, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
    writeFileSync(join(backend, 'requirements.txt'), 'uvicorn[standard]\nfastapi\n');
    writeFileSync(join(mobile, 'pubspec.yaml'), 'name: demo\n');

    const plan = await detectRunPlan(root);
    expect(plan).not.toBeNull();
    expect(plan?.kind).toBe('uvicorn');
    expect(plan?.preferredPorts[0]).toBe(8000);
    expect(plan?.args).toContain('main:app');
  });

  it('detectRunPlan prefers frontend Vite when Makefile has fe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-fe-'));
    const frontend = join(root, 'frontend');
    const backendApp = join(root, 'backend', 'app');
    mkdirSync(frontend, { recursive: true });
    mkdirSync(backendApp, { recursive: true });
    writeFileSync(
      join(root, 'Makefile'),
      'api:\n\tuvicorn backend.app.main:app --port 8000\nfe:\n\tcd frontend && npm run dev\n'
    );
    writeFileSync(
      join(frontend, 'package.json'),
      JSON.stringify({
        name: 'fe',
        private: true,
        scripts: { dev: 'vite --host 0.0.0.0' },
        devDependencies: { vite: '^5.0.0' },
      })
    );
    writeFileSync(join(frontend, 'vite.config.js'), 'export default {}\n');
    writeFileSync(join(backendApp, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');

    const plan = await detectRunPlan(root);
    expect(plan?.kind).toBe('npm');
    expect(plan?.cwd).toBe(frontend);
    expect(plan?.preferredPorts).toContain(5173);
    expect(plan?.preferredPorts).not.toContain(5000);

    const { detectCompanionApiPlan } = await import('./workspace-run.js');
    const api = detectCompanionApiPlan(root, plan!);
    expect(api?.kind).toBe('uvicorn');
    expect(api?.label).toBe('api');
    expect(api?.args).toContain('backend.app.main:app');
    expect(api?.preferredPorts[0]).toBe(8000);
    expect(api?.cwd).toBe(root);
  });

  it('probeHttpAppPort rejects macOS AirPlay port 5000', async () => {
    const { probeHttpAppPort } = await import('./workspace-run.js');
    expect(await probeHttpAppPort(5000)).toBe(false);
  });

  it('detectRunPlan finds npm vite apps', async () => {
    const cwd = tempWorkspace({
      dev: 'vite --port 5173',
    });
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify(
        {
          name: 'vite-app',
          private: true,
          scripts: { dev: 'vite --port 5173' },
          devDependencies: { vite: '^5.0.0' },
        },
        null,
        2
      )
    );
    const plan = await detectRunPlan(cwd);
    expect(plan?.kind).toBe('npm');
    expect(plan?.label).toBe('dev');
    expect(plan?.preferredPorts).toContain(5173);
  });

  it('refuses startAppPreview on the dashboard port', async () => {
    const refused = await startAppPreview('sess-preview-8747', 8747);
    expect(refused.ok).toBe(false);
    expect(refused.url).toBeUndefined();
    expect(refused.message).toBe('Use /ui for the dashboard. /preview is for the app.');

    const bad = await startAppPreview('sess-preview-bad', 0);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Invalid port/);
  });

  it('isAllowedShotUrl accepts http(s) and rejects file:', () => {
    expect(isAllowedShotUrl('https://example.com')).toBe(true);
    expect(isAllowedShotUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedShotUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedShotUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedShotUrl('data:text/html,hi')).toBe(false);
  });

  it(
    'startDevServer + stopDevServer actually stops the process',
    async () => {
      const cwd = tempWorkspace({
        hang: 'node -e "setInterval(()=>{}, 1000)"',
      });
      const sessionId = 'sess-dev-hang';
      try {
        const started = await startDevServer(cwd, sessionId, 'hang');
        expect(started.ok).toBe(true);
        expect(started.script).toBe('hang');
        expect(started.pid).toBeTypeOf('number');
        expect(pidAlive(started.pid!)).toBe(true);

        const stored = getDevServer(sessionId);
        expect(stored?.pid).toBe(started.pid);
        expect(stored?.script).toBe('hang');
        expect(stored?.logPath).toBeTruthy();

        const again = await startDevServer(cwd, sessionId, 'hang');
        expect(again.ok).toBe(true);
        expect(again.pid).toBe(started.pid);
        expect(again.message).toMatch(/already running/i);

        const stopped = await stopDevServer(sessionId);
        expect(stopped.ok).toBe(true);
        expect(getDevServer(sessionId)).toBeUndefined();
        expect(pidAlive(started.pid!)).toBe(false);
      } finally {
        await stopDevServer(sessionId);
      }
    },
    20_000
  );

  it('refuses invalid screenshot URLs without fetching them', async () => {
    const sessionId = 'sess-shot-refuse';
    const fileUrl = await capturePageScreenshot(sessionId, 'file:///etc/passwd');
    expect(fileUrl.ok).toBe(false);
    expect(fileUrl.png).toBeUndefined();
    expect(fileUrl.message).toMatch(/http or https/i);

    const jsUrl = await capturePageScreenshot(sessionId, 'javascript:alert(1)');
    expect(jsUrl.ok).toBe(false);
    expect(jsUrl.message).toMatch(/javascript/i);

    const dataUrl = await capturePageScreenshot(sessionId, 'data:text/html,hi');
    expect(dataUrl.ok).toBe(false);

    const log = getLastCommandLog(sessionId);
    expect(log?.command).toMatch(/^shot /);
    expect(log?.exitCode).toBe(1);
  });
});
