/**
 * User-facing session copy (Telegram / help). Keep strings here so they can be tested.
 */

import type { Session } from '../models/types.js';
import { SESSION_MODE_LABEL, type SessionMode } from './session-mode.js';

export function formatCurrentSession(
  session: Session,
  extras?: { branch?: string | null }
): string {
  const path = session.repoPath || '(no workspace path)';
  const lastCommand = session.lastCommand?.trim() || '—';
  const lastFile = session.lastFile?.trim() || '—';
  const branch = extras?.branch?.trim();

  const lines = [
    `📁 ${session.title || session.repoName}`,
    `Path: ${path}`,
    `Mode: ${SESSION_MODE_LABEL[session.mode]}`,
    `Status: ${session.status}`,
    `Activity: ${session.activity}`,
    `Model: ${session.model || 'Auto'}`,
  ];

  if (branch) {
    lines.push(`Branch: ${branch}`);
  }

  lines.push(`Last command: ${lastCommand}`);
  lines.push(`Last file: ${lastFile}`);
  return lines.join('\n');
}

export function formatSessionCreatedNotice(opts: {
  title: string;
  previousOpenCount: number;
}): string {
  const keep =
    opts.previousOpenCount > 0
      ? `Previous session(s) are still there (${opts.previousOpenCount} open). Switch back with /sessions.`
      : 'This session is kept when you open another workspace. Switch with /sessions.';

  return (
    `✅ Created session for ${opts.title}. Send me text to start!\n\n` +
    `${keep}\n` +
    `/close deletes a session and its chat history — it does not just disconnect.`
  );
}

export function formatCloseWarning(session: Session): string {
  const name = session.title || session.repoName || session.id;
  return (
    `⚠️ /close will DELETE session "${name}":\n` +
    '• the agent stops\n' +
    '• chat history is removed\n' +
    '• this is not just leaving the session\n\n' +
    'To work in another folder, use /workspaces or /sessions — the old session stays.\n\n' +
    'Delete this session?'
  );
}

export function formatCloseAllWarning(count: number): string {
  return (
    `⚠️ /closeall will DELETE all ${count} session(s) and their chat history. ` +
    'This cannot be undone.\n\nDelete everything?'
  );
}

export function formatModeChanged(mode: SessionMode): string {
  if (mode === 'ask') {
    return `✅ Session mode set to ${SESSION_MODE_LABEL[mode]}. File writes are blocked and reverted.`;
  }
  if (mode === 'plan') {
    return (
      `✅ Session mode set to ${SESSION_MODE_LABEL[mode]}. ` +
      'File writes are blocked. After the plan, tap Apply to switch to agent and implement it.'
    );
  }
  return `✅ Session mode set to ${SESSION_MODE_LABEL[mode]}.`;
}

export function formatWritesBlocked(mode: SessionMode): string {
  return (
    `This session is in ${SESSION_MODE_LABEL[mode]}. ` +
    'Switch to /agent before commit, push, or PR.'
  );
}

export function formatWritesReverted(files: string[]): string {
  const list = files.slice(0, 12).map((file) => `• ${file}`).join('\n');
  const extra = files.length > 12 ? `\n…and ${files.length - 12} more` : '';
  return (
    `⚠️ ask/plan mode blocked file writes. Reverted ${files.length} file(s):\n${list}${extra}`
  );
}

export function formatApplyPlanPrompt(): string {
  return 'Plan is ready. Apply it (switches to agent and implements) or keep planning.';
}

export function formatNoActiveSession(): string {
  return 'No active session. Use /sessions to connect to one.';
}

export function formatAgentBusy(): string {
  return (
    'Agent is busy with the current run. Tap Stop or send /stop to cancel it, or wait for it to finish.'
  );
}

export function formatRunStopped(): string {
  return 'Stopped. Session is still open — send another message to continue.';
}

export function formatRunStopFailed(reason?: string): string {
  return reason?.trim() || 'No run in progress';
}

export function formatOpenUsage(): string {
  return 'Usage: /open <path>\nExample: /open src/index.ts';
}

export function formatSearchUsage(): string {
  return 'Usage: /search <query>\nExample: /search formatRunProgress';
}

export function formatUndoConfirm(files: string[]): string {
  const list = files.slice(0, 20).map((file) => `• ${file}`).join('\n');
  const extra = files.length > 20 ? `\n…and ${files.length - 20} more` : '';
  return (
    `⚠️ Undo will restore these ${files.length} dirty file(s) to HEAD:\n\n` +
    `${list}${extra}\n\n` +
    'Untracked new files are not deleted. Session stays open.\n\nRestore them?'
  );
}

export function formatNothingToUndo(): string {
  return 'Nothing to undo. Working tree is clean.';
}

export function formatFileKept(path: string): string {
  return `Kept ${path}`;
}

export function formatReviewExpired(): string {
  return 'That review expired. Send /diff again.';
}

export function formatUndoCancelled(): string {
  return 'Kept the dirty files.';
}

export function formatMachineStatus(opts: {
  version: string;
  port: number;
  workspaceRoot: string;
  sessionCount: number;
  maxSessions: number;
  currentTitle?: string;
}): string {
  const current = opts.currentTitle?.trim() || 'none';
  return [
    `Cursor Control Plane v${opts.version}`,
    `Dashboard: http://127.0.0.1:${opts.port}`,
    `Workspace root: ${opts.workspaceRoot}`,
    `Sessions: ${opts.sessionCount} / ${opts.maxSessions}`,
    `Current: ${current}`,
    '',
    'Send /ui for a public dashboard URL. /ui stop when done.',
  ].join('\n');
}

export function formatUiStarted(url: string, named?: boolean): string {
  return (
    (named ? 'Stable dashboard:\n' : 'Dashboard is up:\n') +
    url +
    '\n\nToken is required off-localhost. Anyone with this link can open it. ' +
    'Send /ui stop when you are done.'
  );
}

export function formatBranchList(current: string | null, branches: string[]): string {
  const cur = current?.trim() || '(unknown)';
  const lines = [`Current branch: ${cur}`];
  if (branches.length === 0) {
    lines.push('No local branches.');
    return lines.join('\n');
  }
  lines.push('', 'Local branches:');
  for (const branch of branches) {
    lines.push(`${branch === current ? '* ' : '  '}${branch}`);
  }
  return lines.join('\n');
}

export function formatCommitConfirm(message: string, files: string[]): string {
  const list = files.slice(0, 20).map((file) => `• ${file}`).join('\n');
  const extra = files.length > 20 ? `\n…and ${files.length - 20} more` : '';
  return (
    `Commit ${files.length} file(s) with message:\n\n` +
    `"${message}"\n\n` +
    `${list}${extra}\n\n` +
    'Create this commit?'
  );
}

export function formatPushConfirm(branch: string, force?: boolean): string {
  if (force) {
    return (
      `⚠️ Force-push ${branch} to origin with --force-with-lease.\n\n` +
      'This can overwrite the remote branch. Push anyway?'
    );
  }
  return `Push ${branch} to origin (git push -u origin HEAD)?`;
}

export function formatPrConfirm(title: string, branch: string): string {
  return (
    `Create a pull request from ${branch}?\n\n` +
    `Title: ${title}\n\n` +
    'Open the PR?'
  );
}

export function formatNothingToCommit(): string {
  return 'Nothing to commit. Working tree is clean.';
}

export function formatLogUsage(): string {
  return 'Usage: /log [n]\nExample: /log 20  (1–50)';
}

export function formatShotUsage(): string {
  return 'Usage: /shot <url>\nExample: /shot http://127.0.0.1:5173';
}

export function formatNoNpmScript(kind: 'test' | 'lint'): string {
  return kind === 'test'
    ? 'No npm "test" script in this workspace.'
    : 'No npm lint/typecheck script in this workspace (looked for lint, typecheck, tsc).';
}

export function formatDangerousGitBlocked(
  kind: 'reset-hard' | 'delete-remote-branch'
): string {
  if (kind === 'reset-hard') {
    return 'Reset --hard is blocked from Telegram. Do it on the laptop if you really need it.';
  }
  return 'Deleting a remote branch is blocked from Telegram. Do it on the laptop if you really need it.';
}

export function formatHeardVoice(text: string): string {
  return `Heard:\n${text}`;
}

export function formatAttachedFiles(paths: string[]): string {
  if (paths.length === 0) return '';
  return `Attached ${paths.join(', ')}.`;
}

export function formatMissingFileRefs(paths: string[]): string {
  if (paths.length === 0) return '';
  return `Could not attach: ${paths.join(', ')}`;
}

/** Short workspace + session id prefix on every agent reply (Phase 8.1). */
export function formatAgentReplyPrefix(session: Session): string {
  const name = (session.repoName || session.title || 'session').trim() || 'session';
  const shortId = session.id.replace(/-/g, '').slice(0, 8);
  return `[${name} · ${shortId}]`;
}

export function withAgentReplyPrefix(session: Session, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const prefix = formatAgentReplyPrefix(session);
  if (trimmed.startsWith(prefix)) return trimmed;
  return `${prefix}\n${trimmed}`;
}

export function formatSessionAge(createdAt: string, nowMs = Date.now()): string {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return '?';
  const sec = Math.max(0, Math.floor((nowMs - created) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

/** Text block for /sessions (Phase 8.2). */
export function formatSessionsList(opts: {
  sessions: Array<{ session: Session; messageCount: number }>;
  currentId?: string | null;
}): string {
  if (opts.sessions.length === 0) {
    return 'No active sessions. Send me text or use /workspaces to create one!';
  }

  const lines = ['Active sessions — tap a button below to connect:', ''];
  for (const { session, messageCount } of opts.sessions) {
    const current = session.id === opts.currentId ? ' ← current' : '';
    const name = session.title || session.repoName || session.id.slice(0, 8);
    const model = session.model || 'Auto';
    const age = formatSessionAge(session.createdAt);
    lines.push(
      `• ${name}${current}`,
      `  ${session.activity} · ${model} · ${messageCount} msg · age ${age}`
    );
  }
  return lines.join('\n');
}

export function formatNearSessionLimit(count: number, max: number): string {
  return (
    `You are about to use your last session slot (${count}/${max}).\n\n` +
    'Continue to create a new session, or close an old one first (closes deletes that chat history).'
  );
}

export function formatSessionLimitReached(count: number, max: number): string {
  return (
    `Session limit reached (${count}/${max}).\n\n` +
    'Close an old session below before creating a new one. /close deletes history — switching with /sessions does not.'
  );
}
