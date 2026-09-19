import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { runWorkspaceCommand } from './workspace-shell.js';
import {
  buildWorkspaceDiff,
  formatDiffSummary,
  formatFilesList,
  formatSearchResults,
  listDirtyFiles,
  listWorkspaceTree,
  openWorkspaceFile,
  parseGitStatusPorcelain,
  parseSearchHits,
  restoreWorkspaceFiles,
  revertWorkspaceFile,
  safeResolveWorkspacePath,
  writesToRevert,
  searchWorkspace,
  splitGitDiffByFile,
} from './workspace-review.js';

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(resolve(tmpdir(), 'review-'));
  await runWorkspaceCommand({ cwd, command: 'git', args: ['init'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'user.email', 't@t.test'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'user.name', 'Test'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'commit.gpgsign', 'false'] });
  writeFileSync(resolve(cwd, 'a.ts'), 'one\n');
  await runWorkspaceCommand({ cwd, command: 'git', args: ['add', 'a.ts'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['commit', '-m', 'init'] });
  return cwd;
}

describe('workspace-review', () => {
  it('rejects path traversal', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'review-safe-'));
    expect(safeResolveWorkspacePath(cwd, '../../etc/passwd').ok).toBe(false);
    expect(safeResolveWorkspacePath(cwd, 'src/a.ts').ok).toBe(true);
    if (safeResolveWorkspacePath(cwd, 'src/a.ts').ok) {
      expect(safeResolveWorkspacePath(cwd, 'src/a.ts')).toMatchObject({ relative: 'src/a.ts' });
    }
  });

  it('splits a unified diff by file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const files = splitGitDiffByFile(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('src/a.ts');
    expect(files[1].path).toBe('src/b.ts');
    expect(formatDiffSummary(files)).toContain('src/a.ts');
    expect(formatDiffSummary(files)).toMatch(/Keep or Revert/i);
  });

  it('parses porcelain status and search hits', () => {
    const dirty = parseGitStatusPorcelain(' M src/a.ts\n?? new.ts\n');
    expect(dirty).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: '??', path: 'new.ts' },
    ]);
    expect(formatFilesList(['src/a.ts'], dirty)).toContain('src/a.ts');
    expect(formatFilesList([], [])).toMatch(/clean/i);

    const hits = parseSearchHits('src/a.ts:12: const x = 1\n');
    expect(hits).toEqual([{ file: 'src/a.ts', line: 12, text: ' const x = 1' }]);
    expect(formatSearchResults('x', hits, 'rg')).toContain('src/a.ts:12');
  });

  it('builds a diff, opens a file, and reverts a dirty file', async () => {
    const cwd = await initRepo();
    writeFileSync(resolve(cwd, 'a.ts'), 'two\n');
    writeFileSync(resolve(cwd, 'new.ts'), 'fresh\n');

    const diff = await buildWorkspaceDiff(cwd);
    expect(diff.ok).toBe(true);
    expect(diff.files.map((file) => file.path).sort()).toEqual(['a.ts', 'new.ts']);

    const opened = await openWorkspaceFile(cwd, 'a.ts');
    expect(opened.ok).toBe(true);
    expect(opened.payload?.body).toContain('two');

    const outside = await openWorkspaceFile(cwd, '../secret.txt');
    expect(outside.ok).toBe(false);

    const secret = resolve(cwd, '..', `secret-${Date.now()}.txt`);
    writeFileSync(secret, 'nope');
    symlinkSync(secret, resolve(cwd, 'link.txt'));
    const viaLink = await openWorkspaceFile(cwd, 'link.txt');
    expect(viaLink.ok).toBe(false);

    const dirty = await listDirtyFiles(cwd);
    expect(dirty.tracked).toContain('a.ts');
    expect(dirty.untracked).toContain('new.ts');

    const restored = await restoreWorkspaceFiles(cwd, ['a.ts']);
    expect(restored.ok).toBe(true);
    const after = await openWorkspaceFile(cwd, 'a.ts');
    expect(after.payload?.body).toContain('one');

    const removed = await revertWorkspaceFile(cwd, 'new.ts');
    expect(removed.ok).toBe(true);
    const gone = await openWorkspaceFile(cwd, 'new.ts');
    expect(gone.ok).toBe(false);
  });

  it('lists a shallow tree and searches file contents', async () => {
    const cwd = await initRepo();
    mkdirSync(resolve(cwd, 'src'), { recursive: true });
    writeFileSync(resolve(cwd, 'src/hello.ts'), 'export const hello = 1;\n');
    await runWorkspaceCommand({ cwd, command: 'git', args: ['add', 'src/hello.ts'] });

    const tree = await listWorkspaceTree(cwd);
    expect(tree.ok).toBe(true);
    expect(tree.text).toContain('src/');
    expect(tree.text).toContain('hello.ts');
    expect(tree.text).not.toContain('node_modules');

    const result = await searchWorkspace(cwd, 'hello');
    expect(result.ok).toBe(true);
    expect(result.hits.some((hit) => hit.file.includes('hello.ts'))).toBe(true);
  });

  it('reverts only newly dirty paths', () => {
    const before = { ok: true, tracked: ['old.ts'], untracked: [] };
    const after = { ok: true, tracked: ['old.ts', 'new.ts'], untracked: ['tmp.txt'] };
    expect(writesToRevert(before, after)).toEqual(['new.ts', 'tmp.txt']);
  });
});
