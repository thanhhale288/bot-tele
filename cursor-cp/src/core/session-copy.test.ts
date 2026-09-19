import { describe, expect, it } from 'vitest';
import {
  formatAgentBusy,
  formatCloseWarning,
  formatCurrentSession,
  formatNoActiveSession,
  formatFileKept,
  formatNothingToUndo,
  formatOpenUsage,
  formatRunStopFailed,
  formatRunStopped,
  formatSearchUsage,
  formatSessionCreatedNotice,
  formatUndoConfirm,
  formatBranchList,
  formatCommitConfirm,
  formatPushConfirm,
  formatPrConfirm,
  formatNothingToCommit,
  formatShotUsage,
  formatNoNpmScript,
  formatDangerousGitBlocked,
  formatHeardVoice,
  formatAttachedFiles,
  formatMissingFileRefs,
  formatModeChanged,
  formatWritesBlocked,
  formatWritesReverted,
  formatApplyPlanPrompt,
  formatUiStarted,
  formatAgentReplyPrefix,
  withAgentReplyPrefix,
  formatSessionAge,
  formatSessionsList,
  formatNearSessionLimit,
  formatSessionLimitReached,
} from './session-copy.js';
import type { Session } from '../models/types.js';

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    channel: 'telegram',
    channelKey: '1',
    repoPath: '/tmp/app',
    repoName: 'app',
    title: 'app',
    status: 'open',
    activity: 'idle',
    mode: 'agent',
    model: 'composer-2.5',
    sdkAgentId: null,
    lastCommand: 'fix login',
    lastFile: 'src/auth.ts',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    closedAt: null,
    errorMessage: null,
    outputPreview: '',
    ...over,
  };
}

describe('session copy', () => {
  it('formats /current with mode, path, and last activity', () => {
    const text = formatCurrentSession(session(), { branch: 'main' });
    expect(text).toContain('Path: /tmp/app');
    expect(text).toContain('Mode: agent (can edit)');
    expect(text).toContain('Branch: main');
    expect(text).toContain('Last command: fix login');
    expect(text).toContain('Last file: src/auth.ts');
  });

  it('warns that a previous session is kept when creating another workspace', () => {
    const first = formatSessionCreatedNotice({ title: 'app', previousOpenCount: 0 });
    expect(first).toContain('Created session for app');
    expect(first).toContain('/sessions');
    expect(first).toContain('/close');

    const next = formatSessionCreatedNotice({ title: 'bot', previousOpenCount: 1 });
    expect(next).toContain('still there');
    expect(next).toContain('/sessions');
  });

  it('warns that /close deletes history', () => {
    const text = formatCloseWarning(session({ title: 'app' }));
    expect(text).toContain('DELETE');
    expect(text).toContain('app');
    expect(text).toContain('/workspaces');
  });

  it('tells the user the agent is busy and they can stop without closing', () => {
    const text = formatAgentBusy();
    expect(text).toMatch(/busy/i);
    expect(text).toMatch(/\/stop/i);
    expect(text).not.toMatch(/\/close/i);
  });

  it('tells the user the session stays open after /stop', () => {
    const text = formatRunStopped();
    expect(text).toMatch(/still open/i);
    expect(text).not.toMatch(/\/close/i);
  });

  it('uses the stop failure reason from the manager', () => {
    expect(formatRunStopFailed('No run in progress')).toBe('No run in progress');
    expect(formatRunStopFailed()).toMatch(/no run/i);
  });

  it('says when there is no session', () => {
    expect(formatNoActiveSession()).toMatch(/no active session/i);
  });

  it('asks before restoring dirty files', () => {
    const text = formatUndoConfirm(['src/a.ts', 'src/b.ts']);
    expect(text).toContain('src/a.ts');
    expect(text).toMatch(/restore/i);
    expect(text).toMatch(/HEAD/);
    expect(formatNothingToUndo()).toMatch(/clean/i);
    expect(formatFileKept('src/a.ts')).toBe('Kept src/a.ts');
    expect(formatOpenUsage()).toContain('/open');
    expect(formatSearchUsage()).toContain('/search');
  });

  it('formats git branch list and confirmations', () => {
    const branches = formatBranchList('main', ['main', 'dev']);
    expect(branches).toContain('Current branch: main');
    expect(branches).toMatch(/\* main/);
    expect(branches).toContain('dev');

    const commit = formatCommitConfirm('fix login', ['src/a.ts']);
    expect(commit).toContain('fix login');
    expect(commit).toContain('src/a.ts');
    expect(commit).toMatch(/commit/i);

    expect(formatPushConfirm('main')).toContain('main');
    expect(formatPushConfirm('main', true)).toMatch(/force/i);
    expect(formatPrConfirm('Add login', 'feature/login')).toContain('Add login');
    expect(formatPrConfirm('Add login', 'feature/login')).toContain('feature/login');
    expect(formatNothingToCommit()).toMatch(/nothing to commit/i);
    expect(formatShotUsage()).toContain('/shot');
    expect(formatNoNpmScript('test')).toMatch(/test/);
    expect(formatDangerousGitBlocked('reset-hard')).toMatch(/blocked/i);
    expect(formatHeardVoice('fix the navbar')).toContain('fix the navbar');
    expect(formatAttachedFiles(['src/a.ts'])).toContain('src/a.ts');
    expect(formatMissingFileRefs(['nope.ts'])).toContain('nope.ts');
    expect(formatModeChanged('ask')).toMatch(/blocked|reverted/i);
    expect(formatModeChanged('plan')).toMatch(/Apply/);
    expect(formatWritesBlocked('ask')).toMatch(/\/agent/);
    expect(formatWritesReverted(['src/a.ts'])).toContain('src/a.ts');
    expect(formatApplyPlanPrompt()).toMatch(/Apply/);
    expect(formatUiStarted('https://x.example', true)).toMatch(/\/ui stop/);
  });

  it('prefixes agent replies with workspace and short session id', () => {
    const s = session();
    expect(formatAgentReplyPrefix(s)).toBe('[app · abcdef12]');
    expect(withAgentReplyPrefix(s, 'Hello')).toBe('[app · abcdef12]\nHello');
    expect(withAgentReplyPrefix(s, '[app · abcdef12]\nHello')).toBe('[app · abcdef12]\nHello');
  });

  it('lists sessions with current, activity, model, messages, and age', () => {
    const now = Date.parse('2024-01-01T01:00:00.000Z');
    expect(formatSessionAge('2024-01-01T00:00:00.000Z', now)).toBe('1h');

    const text = formatSessionsList({
      currentId: 'abcdef12-3456-7890-abcd-ef1234567890',
      sessions: [
        {
          session: session({ activity: 'running' }),
          messageCount: 12,
        },
        {
          session: session({
            id: 'other-id-0000',
            title: 'bot',
            repoName: 'bot',
            activity: 'idle',
            model: null,
          }),
          messageCount: 0,
        },
      ],
    });
    expect(text).toContain('← current');
    expect(text).toContain('running');
    expect(text).toContain('composer-2.5');
    expect(text).toContain('12 msg');
    expect(text).toContain('bot');
  });

  it('warns when near or at the session limit', () => {
    expect(formatNearSessionLimit(4, 5)).toMatch(/last session slot/);
    expect(formatNearSessionLimit(4, 5)).toContain('4/5');
    expect(formatSessionLimitReached(5, 5)).toMatch(/limit reached/i);
    expect(formatSessionLimitReached(5, 5)).toContain('5/5');
  });
});
