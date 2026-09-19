import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { runWorkspaceCommand } from './workspace-shell.js';
import {
  checkoutGitBranch,
  classifyDangerousGit,
  commitWorkspaceFiles,
  DEFAULT_GIT_LOG_COUNT,
  extractPrUrl,
  formatGitLog,
  formatGitStatus,
  getGitLog,
  getGitStatus,
  isSafeGitRef,
  listGitBranches,
  parsePushForceFlag,
  suggestCommitMessage,
} from './workspace-git.js';

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(resolve(tmpdir(), 'git-core-'));
  const init = await runWorkspaceCommand({ cwd, command: 'git', args: ['init', '-b', 'main'] });
  if (!init.ok) {
    await runWorkspaceCommand({ cwd, command: 'git', args: ['init'] });
  }
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'user.email', 't@t.test'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'user.name', 'Test'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['config', 'commit.gpgsign', 'false'] });
  writeFileSync(resolve(cwd, 'a.ts'), 'one\n');
  await runWorkspaceCommand({ cwd, command: 'git', args: ['add', 'a.ts'] });
  await runWorkspaceCommand({ cwd, command: 'git', args: ['commit', '-m', 'init'] });
  return cwd;
}

describe('workspace-git', () => {
  it('reads status on a repo with a dirty file', async () => {
    const cwd = await initRepo();
    writeFileSync(resolve(cwd, 'a.ts'), 'dirty\n');

    const status = await getGitStatus(cwd);
    expect(status.ok).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.dirtyCount).toBeGreaterThanOrEqual(1);
    expect(status.short).toContain(status.branch ?? '');
  });

  it('returns log lines for two commits with default count 10', async () => {
    const cwd = await initRepo();
    writeFileSync(resolve(cwd, 'a.ts'), 'two\n');
    await runWorkspaceCommand({ cwd, command: 'git', args: ['add', 'a.ts'] });
    await runWorkspaceCommand({ cwd, command: 'git', args: ['commit', '-m', 'second subject'] });

    const log = await getGitLog(cwd);
    expect(log.ok).toBe(true);
    expect(log.count).toBe(DEFAULT_GIT_LOG_COUNT);
    expect(log.count).toBe(10);
    expect(log.text).toMatch(/init/);
    expect(log.text).toMatch(/second subject/);
    expect(formatGitLog(log.text, log.count)).toContain('10');
  });

  it('lists branches and checks out a newly created branch', async () => {
    const cwd = await initRepo();
    await runWorkspaceCommand({ cwd, command: 'git', args: ['branch', 'dev'] });

    const listed = await listGitBranches(cwd);
    expect(listed.ok).toBe(true);
    expect(listed.current).toBeTruthy();
    expect(listed.branches).toEqual(expect.arrayContaining(['dev', listed.current ?? '']));

    const switched = await checkoutGitBranch(cwd, 'dev');
    expect(switched.ok).toBe(true);

    const after = await listGitBranches(cwd);
    expect(after.current).toBe('dev');

    const unsafe = await checkoutGitBranch(cwd, '../x');
    expect(unsafe.ok).toBe(false);
  });

  it('rejects unsafe git refs', () => {
    expect(isSafeGitRef('main')).toBe(true);
    expect(isSafeGitRef('feature/foo')).toBe(true);
    expect(isSafeGitRef('hotfix-1')).toBe(true);
    expect(isSafeGitRef('../x')).toBe(false);
    expect(isSafeGitRef('-m')).toBe(false);
    expect(isSafeGitRef('foo;rm')).toBe(false);
    expect(isSafeGitRef('a b')).toBe(false);
    expect(isSafeGitRef('HEAD~1')).toBe(false);
    expect(isSafeGitRef('foo..bar')).toBe(false);
  });

  it('classifies dangerous git commands', () => {
    expect(classifyDangerousGit('git push --force')).toBe('force-push');
    expect(classifyDangerousGit('push -f origin main')).toBe('force-push');
    expect(classifyDangerousGit('git reset --hard HEAD')).toBe('reset-hard');
    expect(classifyDangerousGit('git push origin :old-branch')).toBe('delete-remote-branch');
    expect(classifyDangerousGit('git branch -D origin/foo')).toBe('delete-remote-branch');
    expect(classifyDangerousGit('git push --delete origin feature')).toBe('delete-remote-branch');
    expect(classifyDangerousGit('git status')).toBeNull();
    expect(classifyDangerousGit('git push origin main')).toBeNull();
  });

  it('suggests a commit message from dirty files', () => {
    expect(suggestCommitMessage([])).toBe('Update workspace');
    expect(suggestCommitMessage(['a.ts'])).toBe('Update a.ts');
    expect(suggestCommitMessage(['a.ts', 'b.ts'])).toBe('Update a.ts, b.ts');
    expect(suggestCommitMessage(['src/a.ts', 'b.ts', 'c.ts', 'd.ts'])).toBe('Update a.ts, b.ts, c.ts');
  });

  it('commits workspace files and leaves that file clean', async () => {
    const cwd = await initRepo();
    writeFileSync(resolve(cwd, 'a.ts'), 'changed\n');

    const committed = await commitWorkspaceFiles(cwd, 'Update a.ts', ['a.ts']);
    expect(committed.ok).toBe(true);
    expect(committed.sha).toMatch(/^[0-9a-f]{4,}$/i);

    const after = await getGitStatus(cwd);
    expect(after.ok).toBe(true);
    expect(after.dirtyCount).toBe(0);
  });

  it('rejects path traversal files when committing', async () => {
    const cwd = await initRepo();
    const bad = await commitWorkspaceFiles(cwd, 'nope', ['../secret.txt']);
    expect(bad.ok).toBe(false);
    expect(bad.sha).toBeUndefined();
  });

  it('parses push force flags and nothing else', () => {
    expect(parsePushForceFlag('--force')).toBe(true);
    expect(parsePushForceFlag('-f')).toBe(true);
    expect(parsePushForceFlag(' --force ')).toBe(true);
    expect(parsePushForceFlag('--force-with-lease')).toBe(false);
    expect(parsePushForceFlag('--force origin')).toBe(false);
    expect(parsePushForceFlag('force')).toBe(false);
    expect(parsePushForceFlag('')).toBe(false);
  });

  it('formats status with ahead/behind when set', () => {
    const formatted = formatGitStatus({
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      short: '## main...origin/main [ahead 2, behind 1]',
      dirtyCount: 0,
    });
    expect(formatted).toMatch(/ahead/i);
    expect(formatted).toMatch(/behind/i);
    expect(formatted).toContain('2');
    expect(formatted).toContain('1');
  });

  it('extracts a GitHub pull request URL', () => {
    expect(extractPrUrl('https://github.com/org/repo/pull/12')).toBe(
      'https://github.com/org/repo/pull/12'
    );
    expect(extractPrUrl('Opened https://github.com/a/b/pull/3 for review\n')).toBe(
      'https://github.com/a/b/pull/3'
    );
    expect(extractPrUrl('no url here')).toBeNull();
  });
});
