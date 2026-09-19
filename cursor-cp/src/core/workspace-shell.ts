/**
 * Run a fixed command in a session workspace.
 * Do not pass untrusted shell strings; use command + args only (no shell).
 */

import { execa, ExecaError } from 'execa';
import { existsSync, statSync } from 'fs';

export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 80_000;

export interface WorkspaceCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunWorkspaceCommandOptions {
  cwd: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr;
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n…(truncated, ${text.length} chars total)`,
    truncated: true,
  };
}

export function validateWorkspaceCwd(cwd: string): string | null {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return 'No workspace path on this session. Pick one with /workspaces or /repos.';
  }
  if (!existsSync(trimmed)) {
    return `Workspace path does not exist:\n${trimmed}`;
  }
  try {
    if (!statSync(trimmed).isDirectory()) {
      return `Workspace path is not a directory:\n${trimmed}`;
    }
  } catch {
    return `Cannot access workspace path:\n${trimmed}`;
  }
  return null;
}

export async function runWorkspaceCommand(
  options: RunWorkspaceCommandOptions
): Promise<WorkspaceCommandResult> {
  const cwd = options.cwd.trim();
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const display = [options.command, ...args].join(' ').trim();

  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return {
      ok: false,
      command: display,
      cwd,
      stdout: '',
      stderr: invalid,
      combined: invalid,
      exitCode: null,
      timedOut: false,
      truncated: false,
    };
  }

  try {
    const result = await execa(options.command, args, {
      cwd,
      timeout: timeoutMs,
      reject: false,
      stripFinalNewline: false,
    });

    const raw = combineOutput(result.stdout ?? '', result.stderr ?? '');
    const clipped = clip(raw, maxOutputChars);
    const stdoutClip = clip(result.stdout ?? '', maxOutputChars);
    const stderrClip = clip(result.stderr ?? '', maxOutputChars);

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      command: display,
      cwd,
      stdout: stdoutClip.text,
      stderr: stderrClip.text,
      combined: clipped.text,
      exitCode: result.exitCode ?? null,
      timedOut: Boolean(result.timedOut),
      truncated: clipped.truncated || stdoutClip.truncated || stderrClip.truncated,
    };
  } catch (err) {
    const timedOut = err instanceof ExecaError && Boolean(err.timedOut);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command: display,
      cwd,
      stdout: '',
      stderr: message,
      combined: message,
      exitCode: err instanceof ExecaError ? (err.exitCode ?? null) : null,
      timedOut,
      truncated: false,
    };
  }
}

export interface TelegramCommandPayload {
  text: string;
  asDocument: boolean;
  filename: string;
  body: string;
}

/** Decide whether Telegram gets a short message or a document. */
export function telegramPayloadForText(
  header: string,
  body: string,
  filename: string,
  textLimit = TELEGRAM_MESSAGE_LIMIT
): TelegramCommandPayload {
  const trimmed = body.trim() || '(no output)';
  const full = header ? `${header}\n\n${trimmed}` : trimmed;

  if (full.length <= textLimit) {
    return { text: full, asDocument: false, filename, body: trimmed };
  }

  const captionBudget = Math.min(900, textLimit - 80);
  const preview = trimmed.slice(0, captionBudget);
  const caption = header
    ? `${header}\n\n${preview}\n\n…full output attached as ${filename}`
    : `${preview}\n\n…full output attached as ${filename}`;
  return { text: caption, asDocument: true, filename, body: trimmed };
}

/** Decide whether Telegram gets a short message or a .txt document. */
export function telegramPayloadForCommand(
  result: WorkspaceCommandResult,
  textLimit = TELEGRAM_MESSAGE_LIMIT
): TelegramCommandPayload {
  const headerParts = [
    `$ ${result.command}`,
    result.timedOut ? 'timed out' : `exit ${result.exitCode ?? '?'}`,
    result.truncated ? 'truncated' : null,
  ].filter(Boolean);
  return telegramPayloadForText(
    headerParts.join(' · '),
    result.combined.trim() || '(no output)',
    'command-output.txt',
    textLimit
  );
}
