import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  capturePageScreenshot,
  detectNpmScript,
  formatLastCommandLog,
  getDevServer,
  getLastCommandLog,
  isAllowedShotUrl,
  parseDevArg,
  parsePreviewArg,
  parsePreviewPort,
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

    expect(parsePreviewPort('', 5173)).toBe(5173);
    expect(parsePreviewPort('3000')).toBe(3000);
    expect(parsePreviewPort('abc')).toBeNull();
    expect(parsePreviewPort('0')).toBeNull();
    expect(parsePreviewPort('99999')).toBeNull();
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
