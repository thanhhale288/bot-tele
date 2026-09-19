import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  runWorkspaceCommand,
  telegramPayloadForCommand,
  telegramPayloadForText,
  validateWorkspaceCwd,
} from './workspace-shell.js';

describe('workspace-shell', () => {
  it('rejects a missing workspace path', () => {
    expect(validateWorkspaceCwd('')).toMatch(/No workspace path/);
    expect(validateWorkspaceCwd(resolve(tmpdir(), 'no-such-ws-dir-xyz'))).toMatch(/does not exist/);
  });

  it('runs a command in the workspace and captures stdout', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'ws-shell-'));
    const result = await runWorkspaceCommand({
      cwd,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello-ws")'],
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.combined).toContain('hello-ws');
    expect(result.timedOut).toBe(false);
  });

  it('times out a hung command', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'ws-shell-'));
    const result = await runWorkspaceCommand({
      cwd,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('truncates oversized output', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'ws-shell-'));
    const result = await runWorkspaceCommand({
      cwd,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(500))'],
      timeoutMs: 10_000,
      maxOutputChars: 40,
    });
    expect(result.truncated).toBe(true);
    expect(result.combined.length).toBeLessThan(200);
    expect(result.combined).toContain('truncated');
  });

  it('sends long output as a Telegram document payload', () => {
    const long = 'y'.repeat(5000);
    const payload = telegramPayloadForCommand({
      ok: true,
      command: 'git diff',
      cwd: '/tmp',
      stdout: long,
      stderr: '',
      combined: long,
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(payload.asDocument).toBe(true);
    expect(payload.filename).toBe('command-output.txt');
    expect(payload.body).toBe(long);
    expect(payload.text).toContain('full output attached');
  });

  it('attaches long file text as a named document', () => {
    const payload = telegramPayloadForText('📄 src/a.ts', 'z'.repeat(5000), 'a.ts');
    expect(payload.asDocument).toBe(true);
    expect(payload.filename).toBe('a.ts');
    expect(payload.text).toContain('src/a.ts');
  });

  it('keeps short output as a plain message', () => {
    const payload = telegramPayloadForCommand({
      ok: true,
      command: 'git status',
      cwd: '/tmp',
      stdout: 'clean',
      stderr: '',
      combined: 'clean',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(payload.asDocument).toBe(false);
    expect(payload.text).toContain('git status');
    expect(payload.text).toContain('clean');
  });

  it('rejects a file path that is not a directory', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'ws-shell-'));
    const file = resolve(cwd, 'note.txt');
    writeFileSync(file, 'x');
    expect(validateWorkspaceCwd(file)).toMatch(/not a directory/);
    mkdirSync(resolve(cwd, 'ok'), { recursive: true });
  });
});
