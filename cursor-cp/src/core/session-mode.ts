/**
 * Session interaction modes. Prompt prefix plus a post-run write revert in
 * ask/plan (Phase 6).
 */

import type { SessionMode } from '../models/types.js';

export type { SessionMode };

export const SESSION_MODES = ['ask', 'agent', 'plan'] as const;

export const DEFAULT_SESSION_MODE: SessionMode = 'agent';

const MODE_SET = new Set<string>(SESSION_MODES);

export function parseSessionMode(value: unknown): SessionMode {
  if (typeof value === 'string' && MODE_SET.has(value)) {
    return value as SessionMode;
  }
  return DEFAULT_SESSION_MODE;
}

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  ask: 'ask (read-only)',
  agent: 'agent (can edit)',
  plan: 'plan (no file writes)',
};

export function modeAllowsWrites(mode: SessionMode): boolean {
  return mode === 'agent';
}

export function promptWithSessionMode(mode: SessionMode, userText: string): string {
  if (mode === 'ask') {
    return (
      '[SESSION MODE: ask — read-only. Do not modify files, install packages, ' +
      'commit, or run write commands. Answer the question only.]\n\n' +
      userText
    );
  }
  if (mode === 'plan') {
    return (
      '[SESSION MODE: plan — propose a step-by-step plan only. Do not modify ' +
      'files or run write commands until the user applies the plan.]\n\n' +
      userText
    );
  }
  return userText;
}

export function summarizeUserCommand(text: string, maxLen = 120): string {
  const first = text.trim().split(/\r?\n/)[0] ?? '';
  return first.slice(0, maxLen);
}
