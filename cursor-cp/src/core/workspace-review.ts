/**
 * Phase 2 — inspect and revert workspace changes (diff / files / open / search / tree / undo).
 * Commands use execa argv arrays, never a shell string.
 */

import { existsSync, realpathSync, statSync } from 'fs';
import { readFile, readdir, unlink } from 'fs/promises';
import { basename, isAbsolute, relative, resolve } from 'path';
import {
  runWorkspaceCommand,
  telegramPayloadForText,
  validateWorkspaceCwd,
  type TelegramCommandPayload,
  type WorkspaceCommandResult,
} from './workspace-shell.js';

export const REVIEW_PATCH_LIMIT = 3500;
export const MAX_DIFF_FILE_MESSAGES = 12;
export const MAX_SEARCH_HITS = 40;
export const MAX_TREE_ENTRIES = 80;
export const TREE_DEPTH = 2;
export const MAX_OPEN_BYTES = 512_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', '.turbo', '.cursor']);

export interface ReviewFileDiff {
  path: string;
  kind: 'modified' | 'staged' | 'untracked' | 'deleted';
  patch: string;
}

export interface WorkspaceDiffResult {
  ok: boolean;
  error?: string;
  files: ReviewFileDiff[];
  clean: boolean;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface DirtyFiles {
  ok: boolean;
  error?: string;
  tracked: string[];
  untracked: string[];
}

export function safeResolveWorkspacePath(
  cwd: string,
  userPath: string
): { ok: true; absolute: string; relative: string } | { ok: false; error: string } {
  const trimmed = userPath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Path is empty.' };
  }
  if (trimmed.includes('\0')) {
    return { ok: false, error: 'Invalid path.' };
  }

  const root = resolve(cwd);
  const target = resolve(root, trimmed);
  const rel = relative(root, target);
  if (!rel) {
    return { ok: true, absolute: target, relative: '.' };
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'Path is outside the workspace.' };
  }
  return { ok: true, absolute: target, relative: rel.split(/[/\\]/).join('/') };
}

function assertRealPathInsideWorkspace(cwd: string, absolute: string): string | null {
  try {
    const realRoot = realpathSync(resolve(cwd));
    const realTarget = realpathSync(absolute);
    const rel = relative(realRoot, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return 'Path is outside the workspace.';
    }
  } catch {
    return null;
  }
  return null;
}

export function parseGitStatusPorcelain(output: string): Array<{ code: string; path: string }> {
  const rows: Array<{ code: string; path: string }> = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    const renamed = path.split(' -> ');
    if (renamed.length === 2) {
      path = renamed[1];
    }
    if (path) rows.push({ code, path });
  }
  return rows;
}

export function splitGitDiffByFile(diff: string): ReviewFileDiff[] {
  const text = diff.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const chunks = text.split(/^diff --git /m).filter((chunk) => chunk.trim());
  const files: ReviewFileDiff[] = [];

  for (const chunk of chunks) {
    const body = chunk.startsWith('diff --git ') ? chunk : `diff --git ${chunk}`;
    const header = body.split('\n', 1)[0] ?? '';
    const path = pathFromDiffHeader(header, body);
    const deleted = /^deleted file mode/m.test(body) || /\n\+\+\+ \/dev\/null/m.test(body);
    files.push({
      path,
      kind: deleted ? 'deleted' : 'modified',
      patch: body.trimEnd(),
    });
  }

  return files;
}

function pathFromDiffHeader(header: string, body: string): string {
  const plus = body.match(/^\+\+\+ b\/(.+)$/m);
  if (plus?.[1] && plus[1] !== '/dev/null') {
    return plus[1];
  }
  const minus = body.match(/^--- a\/(.+)$/m);
  if (minus?.[1] && minus[1] !== '/dev/null') {
    return minus[1];
  }
  const git = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (git) {
    return git[2] === '/dev/null' ? git[1] : git[2];
  }
  return header.replace(/^diff --git\s+/, '').trim() || 'unknown';
}

export function parseSearchHits(output: string, limit = MAX_SEARCH_HITS): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of output.split('\n')) {
    if (!raw) continue;
    const match = raw.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;
    hits.push({
      file: match[1],
      line: Number(match[2]),
      text: match[3].slice(0, 200),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function formatDiffSummary(files: ReviewFileDiff[]): string {
  if (files.length === 0) {
    return 'Working tree is clean. No diff to review.';
  }
  const lines = [`Changed files (${files.length}):`];
  for (const file of files.slice(0, 30)) {
    lines.push(`• ${file.path} (${file.kind})`);
  }
  if (files.length > 30) {
    lines.push(`…and ${files.length - 30} more`);
  }
  lines.push('', 'Tap Keep or Revert under each file.');
  return lines.join('\n');
}

export function formatFilesList(touched: string[], dirty: Array<{ code: string; path: string }>): string {
  const lines: string[] = [];
  if (touched.length > 0) {
    lines.push(`Files from last run (${touched.length}):`);
    for (const file of touched.slice(0, 40)) {
      lines.push(`• ${file}`);
    }
    if (touched.length > 40) {
      lines.push(`…and ${touched.length - 40} more`);
    }
  }

  if (dirty.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Dirty in git (${dirty.length}):`);
    for (const row of dirty.slice(0, 40)) {
      lines.push(`• ${row.code} ${row.path}`);
    }
  }

  if (lines.length === 0) {
    return 'No files recorded for this run, and the working tree is clean.';
  }
  return lines.join('\n');
}

export function formatSearchResults(query: string, hits: SearchHit[], tool: string): string {
  if (hits.length === 0) {
    return `No matches for "${query}".`;
  }
  const lines = [`Search "${query}" · ${hits.length} hit(s) via ${tool}`];
  for (const hit of hits) {
    lines.push(`${hit.file}:${hit.line}: ${hit.text.trim()}`);
  }
  return lines.join('\n');
}

export function patchPayload(file: ReviewFileDiff): TelegramCommandPayload {
  const filename = `${basename(file.path) || 'change'}.patch`;
  return telegramPayloadForText(`📄 ${file.path} (${file.kind})`, file.patch, filename, REVIEW_PATCH_LIMIT);
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

function isMissingCommand(result: WorkspaceCommandResult): boolean {
  if (result.exitCode === 127) return true;
  return /ENOENT|not found|spawn /i.test(result.combined);
}

function isGitRepoError(result: WorkspaceCommandResult): boolean {
  return /not a git repository/i.test(result.combined);
}

export async function buildWorkspaceDiff(cwd: string): Promise<WorkspaceDiffResult> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid, files: [], clean: true };
  }

  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 5_000);
  if (!inside.ok) {
    return {
      ok: false,
      error: isGitRepoError(inside) ? 'This workspace is not a git repository.' : inside.combined,
      files: [],
      clean: true,
    };
  }

  let diffText = '';
  const vsHead = await git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD']);
  if (vsHead.ok || vsHead.exitCode === 0) {
    diffText = vsHead.stdout || vsHead.combined;
  } else if (/unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(vsHead.combined)) {
    const unstaged = await git(cwd, ['diff', '--no-color', '--no-ext-diff']);
    const staged = await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff']);
    diffText = [unstaged.stdout, staged.stdout].filter(Boolean).join('\n');
  } else {
    return { ok: false, error: vsHead.combined, files: [], clean: true };
  }

  const files = splitGitDiffByFile(diffText);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.ok) {
    for (const path of untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (files.some((file) => file.path === path)) continue;
      files.push({
        path,
        kind: 'untracked',
        patch: await untrackedPreview(cwd, path),
      });
    }
  }

  return { ok: true, files, clean: files.length === 0 };
}

async function untrackedPreview(cwd: string, relPath: string): Promise<string> {
  const resolved = safeResolveWorkspacePath(cwd, relPath);
  if (!resolved.ok) {
    return '(untracked file)';
  }
  try {
    if (assertRealPathInsideWorkspace(cwd, resolved.absolute)) {
      return '(untracked file outside workspace)';
    }
    const stat = statSync(resolved.absolute);
    if (!stat.isFile()) {
      return '(untracked directory)';
    }
    if (stat.size > 32_000) {
      return `(untracked file, ${stat.size} bytes — content omitted)`;
    }
    const buf = await readFile(resolved.absolute);
    if (buf.includes(0)) {
      return '(untracked binary file)';
    }
    const content = buf.toString('utf8');
    return `New untracked file\n\n${content}`;
  } catch {
    return '(untracked file, could not read)';
  }
}

export async function listDirtyFiles(cwd: string): Promise<DirtyFiles> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid, tracked: [], untracked: [] };
  }

  const status = await git(cwd, ['status', '--porcelain'], 10_000);
  if (!status.ok && status.exitCode !== 0) {
    return {
      ok: false,
      error: isGitRepoError(status) ? 'This workspace is not a git repository.' : status.combined,
      tracked: [],
      untracked: [],
    };
  }

  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const row of parseGitStatusPorcelain(status.stdout || status.combined)) {
    if (row.code === '??') {
      untracked.push(row.path);
    } else {
      tracked.push(row.path);
    }
  }
  return { ok: true, tracked, untracked };
}

export async function restoreWorkspaceFiles(
  cwd: string,
  files: string[]
): Promise<WorkspaceCommandResult> {
  const unique = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return {
      ok: false,
      command: 'git restore',
      cwd,
      stdout: '',
      stderr: 'No files to restore.',
      combined: 'No files to restore.',
      exitCode: null,
      timedOut: false,
      truncated: false,
    };
  }

  const restore = await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...unique]);
  if (restore.ok) return restore;
  if (/unknown option|is not a git command|restore/i.test(restore.combined) && restore.exitCode !== 0) {
    return git(cwd, ['checkout', '--', ...unique]);
  }
  return restore;
}

export async function revertWorkspaceFile(
  cwd: string,
  userPath: string
): Promise<{ ok: boolean; message: string }> {
  const resolved = safeResolveWorkspacePath(cwd, userPath);
  if (!resolved.ok) {
    return { ok: false, message: resolved.error };
  }

  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', resolved.relative], 5_000);
  if (tracked.ok) {
    const restored = await restoreWorkspaceFiles(cwd, [resolved.relative]);
    return {
      ok: restored.ok,
      message: restored.ok
        ? `Reverted ${resolved.relative} to HEAD.`
        : restored.combined || `Could not revert ${resolved.relative}.`,
    };
  }

  if (!existsSync(resolved.absolute)) {
    return { ok: false, message: `File not found: ${resolved.relative}` };
  }

  const escaped = assertRealPathInsideWorkspace(cwd, resolved.absolute);
  if (escaped) {
    return { ok: false, message: escaped };
  }

  try {
    const stat = statSync(resolved.absolute);
    if (!stat.isFile()) {
      return { ok: false, message: `Refusing to delete directory ${resolved.relative}.` };
    }
    await unlink(resolved.absolute);
    return { ok: true, message: `Removed untracked file ${resolved.relative}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Paths that became dirty after a run. Pre-existing dirty files are left alone. */
export function writesToRevert(before: DirtyFiles, after: DirtyFiles): string[] {
  const prior = new Set([...before.tracked, ...before.untracked]);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const path of [...after.tracked, ...after.untracked]) {
    if (!path || prior.has(path) || seen.has(path)) continue;
    seen.add(path);
    next.push(path);
  }
  return next;
}

export async function revertNewWrites(
  cwd: string,
  paths: string[]
): Promise<string[]> {
  const reverted: string[] = [];
  for (const path of paths) {
    const result = await revertWorkspaceFile(cwd, path);
    if (result.ok) reverted.push(path);
  }
  return reverted;
}

export async function openWorkspaceFile(
  cwd: string,
  userPath: string
): Promise<{ ok: boolean; error?: string; payload?: TelegramCommandPayload }> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid };
  }

  const resolved = safeResolveWorkspacePath(cwd, userPath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  if (!existsSync(resolved.absolute)) {
    return { ok: false, error: `File not found: ${resolved.relative}` };
  }

  const escaped = assertRealPathInsideWorkspace(cwd, resolved.absolute);
  if (escaped) {
    return { ok: false, error: escaped };
  }

  let stat;
  try {
    stat = statSync(resolved.absolute);
  } catch {
    return { ok: false, error: `Cannot access ${resolved.relative}` };
  }

  if (stat.isDirectory()) {
    return { ok: false, error: `${resolved.relative} is a directory. Use /tree ${resolved.relative}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `${resolved.relative} is not a regular file.` };
  }

  const size = Math.min(stat.size, MAX_OPEN_BYTES);
  const buf = await readFile(resolved.absolute);
  const slice = buf.subarray(0, size);
  if (slice.includes(0)) {
    return { ok: false, error: `${resolved.relative} looks like a binary file.` };
  }

  const text = slice.toString('utf8');
  const truncated = stat.size > MAX_OPEN_BYTES;
  const header = truncated
    ? `📄 ${resolved.relative} (first ${MAX_OPEN_BYTES} bytes)`
    : `📄 ${resolved.relative}`;
  return {
    ok: true,
    payload: telegramPayloadForText(header, text, basename(resolved.relative), 3500),
  };
}

export async function searchWorkspace(
  cwd: string,
  query: string
): Promise<{ ok: boolean; error?: string; hits: SearchHit[]; tool: 'rg' | 'git' | null }> {
  const q = query.trim();
  if (!q) {
    return { ok: false, error: 'Usage: /search <query>', hits: [], tool: null };
  }

  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid, hits: [], tool: null };
  }

  const grep = await git(cwd, ['grep', '-n', '-I', '--max-count', '40', '-e', q, '--', '.'], 8_000);
  if (grep.exitCode === 0 || grep.exitCode === 1) {
    return { ok: true, hits: parseSearchHits(grep.stdout || grep.combined), tool: 'git' };
  }

  const rg = await runWorkspaceCommand({
    cwd,
    command: 'rg',
    args: [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      '40',
      '--max-filesize',
      '256K',
      '-g',
      '!node_modules/**',
      '-g',
      '!.git/**',
      '-g',
      '!dist/**',
      '--',
      q,
      '.',
    ],
    timeoutMs: 6_000,
    maxOutputChars: 40_000,
  });

  if ((rg.exitCode === 0 || rg.exitCode === 1) && !rg.timedOut && !isMissingCommand(rg)) {
    return { ok: true, hits: parseSearchHits(rg.stdout || rg.combined), tool: 'rg' };
  }

  return {
    ok: false,
    error: grep.combined || rg.combined || 'Search failed.',
    hits: [],
    tool: isGitRepoError(grep) ? 'rg' : 'git',
  };
}

export async function listWorkspaceTree(
  cwd: string,
  userPath = ''
): Promise<{ ok: boolean; error?: string; text: string }> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid, text: '' };
  }

  const resolved = safeResolveWorkspacePath(cwd, userPath || '.');
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, text: '' };
  }
  if (!existsSync(resolved.absolute)) {
    return { ok: false, error: `Path not found: ${resolved.relative}`, text: '' };
  }

  let stat;
  try {
    stat = statSync(resolved.absolute);
  } catch {
    return { ok: false, error: `Cannot access ${resolved.relative}`, text: '' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `${resolved.relative} is a file. Use /open ${resolved.relative}`, text: '' };
  }

  const lines: string[] = [resolved.relative === '.' ? basename(resolve(cwd)) + '/' : `${resolved.relative}/`];
  await walkTree(resolved.absolute, 1, lines);
  if (lines.length === 1) {
    lines.push('  (empty)');
  }
  return { ok: true, text: lines.join('\n') };
}

async function walkTree(abs: string, depth: number, acc: string[]): Promise<void> {
  if (acc.length >= MAX_TREE_ENTRIES) {
    acc.push('  …');
    return;
  }

  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (acc.length >= MAX_TREE_ENTRIES) {
      acc.push('  …');
      return;
    }
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const indent = '  '.repeat(depth);
    acc.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory() && depth < TREE_DEPTH) {
      await walkTree(resolve(abs, entry.name), depth + 1, acc);
    }
  }
}

export function fileLabel(path: string): string {
  const name = path.split(/[/\\]/).pop() || path;
  return name.length > 28 ? `${name.slice(0, 25)}…` : name;
}