/**
 * Phase 3 — git status / log / branch / commit / push / pr helpers.
 * Commands use execa argv arrays, never a shell string.
 */

import {
  listDirtyFiles,
  parseGitStatusPorcelain,
  safeResolveWorkspacePath,
} from './workspace-review.js';
import {
  runWorkspaceCommand,
  type WorkspaceCommandResult,
} from './workspace-shell.js';

export const DEFAULT_GIT_LOG_COUNT = 10;
export const MAX_GIT_LOG_COUNT = 50;

export interface GitStatusInfo {
  ok: boolean;
  error?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  short: string;
  dirtyCount: number;
}

const SHELL_META = /[\s\0\\$`;&|<>(){}[\]*?!~'"#^:@]/;

export function isSafeGitRef(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (SHELL_META.test(name)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.endsWith('/') || name.endsWith('.')) return false;
  return true;
}

export function parsePushForceFlag(arg: string): boolean {
  const trimmed = arg.trim();
  return trimmed === '--force' || trimmed === '-f';
}

export function classifyDangerousGit(
  input: string
): 'force-push' | 'reset-hard' | 'delete-remote-branch' | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() === 'git') {
    tokens.shift();
  }

  const lower = tokens.map((token) => token.toLowerCase());
  const hasToken = (value: string) => tokens.includes(value);
  const hasLower = (value: string) => lower.includes(value);

  if (hasLower('reset') && hasToken('--hard')) {
    return 'reset-hard';
  }

  if (hasLower('push')) {
    if (hasToken('--force') || hasToken('-f')) {
      return 'force-push';
    }
    if (hasToken('--delete') || tokens.some((token) => token.startsWith(':') && token.length > 1)) {
      return 'delete-remote-branch';
    }
  }

  if (hasLower('branch') && (hasToken('-d') || hasToken('-D'))) {
    if (tokens.some((token) => token === 'origin' || token.startsWith('origin/'))) {
      return 'delete-remote-branch';
    }
  }

  if (hasLower('remote') && (hasLower('delete') || hasToken('--delete') || hasToken('-d') || hasToken('-D'))) {
    return 'delete-remote-branch';
  }

  return null;
}

export function extractPrUrl(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match ? match[0] : null;
}

export function suggestCommitMessage(dirtyFiles: string[]): string {
  const names = dirtyFiles
    .map((file) => file.split(/[/\\]/).pop() || file)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return 'Update workspace';
  }
  return `Update ${names.slice(0, 3).join(', ')}`;
}

export function formatGitStatus(info: GitStatusInfo): string {
  if (!info.ok) {
    return info.error || 'Could not read git status.';
  }

  const lines: string[] = [`Branch: ${info.branch ?? '(detached)'}`];
  if (info.upstream) {
    lines.push(`Upstream: ${info.upstream}`);
  }
  if (info.ahead !== 0 || info.behind !== 0) {
    lines.push(`ahead ${info.ahead}, behind ${info.behind}`);
  }
  lines.push(
    info.dirtyCount === 0 ? 'Working tree is clean.' : `Dirty files: ${info.dirtyCount}`
  );
  if (info.short) {
    lines.push('', info.short);
  }
  return lines.join('\n');
}

export function formatGitLog(text: string, count: number): string {
  const body = text.trim();
  if (!body) {
    return 'No commits yet.';
  }
  return `Last ${count} commit(s):\n${body}`;
}

export async function getGitStatus(cwd: string): Promise<GitStatusInfo> {
  const status = await git(cwd, ['status', '-sb'], 15_000);
  const short = (status.stdout || '').trim();

  if (!status.ok) {
    return emptyStatus(
      isGitRepoError(status)
        ? 'This workspace is not a git repository.'
        : status.combined || 'git status failed.',
      short
    );
  }

  const headerLine =
    (status.stdout || '').split('\n').find((line) => line.startsWith('##')) ?? '';
  const parsed = parseStatusShortHeader(headerLine);

  let ahead = parsed.ahead;
  let behind = parsed.behind;
  if (parsed.upstream) {
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], 10_000);
    if (counts.ok) {
      const parts = counts.stdout.trim().split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        ahead = Number(parts[0]);
        behind = Number(parts[1]);
      }
    }
  }

  const body = (status.stdout || '')
    .split('\n')
    .filter((line) => line && !line.startsWith('##'))
    .join('\n');
  const fromShort = parseGitStatusPorcelain(body).length;
  const dirty = await listDirtyFiles(cwd);
  const dirtyCount = dirty.ok ? dirty.tracked.length + dirty.untracked.length : fromShort;

  return {
    ok: true,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead,
    behind,
    short,
    dirtyCount,
  };
}

export async function getGitLog(
  cwd: string,
  count?: number
): Promise<{ ok: boolean; error?: string; text: string; count: number }> {
  const n = clampLogCount(count);
  const result = await git(
    cwd,
    ['log', '-n', String(n), '--pretty=format:%h %ad %an %s', '--date=short'],
    15_000
  );

  if (!result.ok) {
    return {
      ok: false,
      error: isGitRepoError(result)
        ? 'This workspace is not a git repository.'
        : result.combined || 'git log failed.',
      text: '',
      count: n,
    };
  }

  return { ok: true, text: result.stdout.trim(), count: n };
}

export async function listGitBranches(
  cwd: string
): Promise<{ ok: boolean; error?: string; current: string | null; branches: string[] }> {
  const currentResult = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 8_000);
  if (!currentResult.ok && isGitRepoError(currentResult)) {
    return {
      ok: false,
      error: 'This workspace is not a git repository.',
      current: null,
      branches: [],
    };
  }

  const current = currentResult.ok ? normalizeCurrentBranch(currentResult.stdout.trim()) : null;

  const formatted = await git(cwd, ['branch', '--format=%(refname:short)'], 8_000);
  if (formatted.ok) {
    const branches = formatted.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: true, current, branches };
  }

  const listed = await git(cwd, ['branch'], 8_000);
  if (!listed.ok) {
    return {
      ok: false,
      error: isGitRepoError(listed)
        ? 'This workspace is not a git repository.'
        : listed.combined || 'git branch failed.',
      current,
      branches: [],
    };
  }

  const parsed = parseGitBranchList(listed.stdout || listed.combined);
  return { ok: true, current: current ?? parsed.current, branches: parsed.branches };
}

export async function checkoutGitBranch(
  cwd: string,
  name: string
): Promise<{ ok: boolean; message: string }> {
  const ref = name.trim();
  if (!isSafeGitRef(ref)) {
    return { ok: false, message: `Unsafe git ref: ${name}` };
  }

  const switched = await git(cwd, ['switch', '--', ref]);
  if (switched.ok) {
    return { ok: true, message: `Switched to branch ${ref}.` };
  }

  const missingSwitch =
    switched.exitCode === 127 ||
    (/switch/i.test(switched.combined) &&
      /is not a git command|unknown option|invalid option/i.test(switched.combined));

  if (missingSwitch) {
    const checked = await git(cwd, ['checkout', '--', ref]);
    if (checked.ok) {
      return { ok: true, message: `Switched to branch ${ref}.` };
    }
    return { ok: false, message: checked.combined || `Could not checkout ${ref}.` };
  }

  return { ok: false, message: switched.combined || `Could not switch to ${ref}.` };
}

export async function commitWorkspaceFiles(
  cwd: string,
  message: string,
  files: string[]
): Promise<{ ok: boolean; message: string; sha?: string }> {
  const msg = message.trim();
  if (!msg) {
    return { ok: false, message: 'Commit message is required.' };
  }

  const unique = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { ok: false, message: 'No files to commit.' };
  }

  const relatives: string[] = [];
  for (const file of unique) {
    const resolved = safeResolveWorkspacePath(cwd, file);
    if (!resolved.ok) {
      return { ok: false, message: resolved.error };
    }
    relatives.push(resolved.relative);
  }

  const add = await git(cwd, ['add', '--', ...relatives]);
  if (!add.ok) {
    return { ok: false, message: add.combined || 'git add failed.' };
  }

  const staged = await git(cwd, ['diff', '--cached', '--name-only', '--', ...relatives], 10_000);
  const added = (staged.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (added.length === 0) {
    return { ok: false, message: 'No files were added. Commit skipped.' };
  }

  const commit = await git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '--message', msg, '--']);
  if (!commit.ok) {
    return { ok: false, message: commit.combined || 'git commit failed.' };
  }

  const rev = await git(cwd, ['rev-parse', '--short', 'HEAD'], 5_000);
  const sha = rev.ok ? rev.stdout.trim() : undefined;
  return {
    ok: true,
    message: sha ? `Committed ${added.join(', ')} (${sha}).` : `Committed ${added.join(', ')}.`,
    sha,
  };
}

export async function pushCurrentBranch(
  cwd: string,
  options?: { force?: boolean }
): Promise<{ ok: boolean; message: string }> {
  const args = options?.force
    ? ['push', '--force-with-lease', '-u', 'origin', 'HEAD']
    : ['push', '-u', 'origin', 'HEAD'];
  const result = await git(cwd, args, 60_000);
  return {
    ok: result.ok,
    message: result.ok
      ? result.combined.trim() || 'Pushed current branch to origin.'
      : result.combined || 'git push failed.',
  };
}

export async function createPullRequest(
  cwd: string,
  title: string
): Promise<{ ok: boolean; message: string; url?: string }> {
  const heading = title.trim();
  if (!heading) {
    return { ok: false, message: 'Pull request title is required.' };
  }

  const created = await runWorkspaceCommand({
    cwd,
    command: 'gh',
    args: ['pr', 'create', '--title', heading, '--body', heading],
    timeoutMs: 30_000,
  });

  if (created.ok) {
    const url = urlFromGhOutput(created.combined);
    return {
      ok: true,
      message: created.combined.trim() || 'Pull request created.',
      url: url ?? undefined,
    };
  }

  if (/already exists/i.test(created.combined)) {
    const viewed = await runWorkspaceCommand({
      cwd,
      command: 'gh',
      args: ['pr', 'view', '--json', 'url', '--jq', '.url'],
      timeoutMs: 15_000,
    });
    const url = urlFromGhOutput(viewed.ok ? viewed.combined : created.combined);
    if (url) {
      return { ok: true, message: `Pull request already exists.\n${url}`, url };
    }

    const jsonView = await runWorkspaceCommand({
      cwd,
      command: 'gh',
      args: ['pr', 'view', '--json', 'url'],
      timeoutMs: 15_000,
    });
    const fromJson = urlFromGhOutput(jsonView.combined);
    if (fromJson) {
      return { ok: true, message: `Pull request already exists.\n${fromJson}`, url: fromJson };
    }
  }

  return { ok: false, message: created.combined || 'gh pr create failed.' };
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 20_000
): Promise<WorkspaceCommandResult> {
  return runWorkspaceCommand({
    cwd,
    command: 'git',
    args,
    timeoutMs,
    maxOutputChars: 200_000,
  });
}

function emptyStatus(error: string, short = ''): GitStatusInfo {
  return {
    ok: false,
    error,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    short,
    dirtyCount: 0,
  };
}

function isGitRepoError(result: WorkspaceCommandResult): boolean {
  return /not a git repository/i.test(result.combined);
}

function clampLogCount(count?: number): number {
  if (count === undefined || !Number.isFinite(count)) {
    return DEFAULT_GIT_LOG_COUNT;
  }
  return Math.min(MAX_GIT_LOG_COUNT, Math.max(1, Math.trunc(count)));
}

function normalizeCurrentBranch(name: string): string | null {
  if (!name || name === 'HEAD') return name || null;
  return name;
}

function parseStatusShortHeader(header: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
} {
  let line = header.replace(/^##\s*/, '').trim();
  let ahead = 0;
  let behind = 0;

  const bracket = line.match(/\[([^\]]+)]\s*$/);
  if (bracket) {
    const meta = bracket[1];
    line = line.slice(0, bracket.index).trim();
    const aheadMatch = meta.match(/ahead\s+(\d+)/i);
    const behindMatch = meta.match(/behind\s+(\d+)/i);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
  }

  if (/^HEAD \(no branch\)/i.test(line)) {
    return { branch: null, upstream: null, ahead, behind };
  }

  const noCommits = line.match(/^No commits yet on\s+(\S+)/i);
  if (noCommits) {
    const [left, right] = noCommits[1].split('...');
    return { branch: left || null, upstream: right || null, ahead, behind };
  }

  const [left, right] = line.split('...');
  return {
    branch: left || null,
    upstream: right || null,
    ahead,
    behind,
  };
}

function parseGitBranchList(output: string): { current: string | null; branches: string[] } {
  const branches: string[] = [];
  let current: string | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('*')) {
      const name = line.replace(/^\*\s+/, '').trim();
      if (name && !name.startsWith('(')) {
        current = name;
        branches.push(name);
      }
      continue;
    }
    branches.push(line);
  }
  return { current, branches };
}

function urlFromGhOutput(text: string): string | null {
  const extracted = extractPrUrl(text);
  if (extracted) return extracted;

  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as { url?: unknown };
    if (typeof parsed.url === 'string') {
      return extractPrUrl(parsed.url) ?? parsed.url;
    }
  } catch {
    // not JSON
  }

  return null;
}
