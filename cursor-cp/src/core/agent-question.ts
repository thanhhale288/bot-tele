/**
 * Agent question timeout / cancel sentinels (Phase 6.4).
 */

import {
  classifyDangerousCommand,
  formatDangerousCommandWarning,
} from './dangerous-command.js';

export const QUESTION_TIMEOUT_MS = 60 * 60 * 1000;
export const QUESTION_CANCELLED = '__cp_question_cancelled__';

export function isQuestionCancelled(answer: string | null | undefined): boolean {
  return answer === QUESTION_CANCELLED;
}

export function questionTimeoutMs(configured?: number): number {
  if (typeof configured === 'number' && configured >= 5_000) {
    return configured;
  }
  return QUESTION_TIMEOUT_MS;
}

export function formatQuestionTimeout(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function timeoutFallbackAnswer(question: string, options: string[]): string {
  if (classifyDangerousCommand(question)) {
    return QUESTION_CANCELLED;
  }
  return options[0] || QUESTION_CANCELLED;
}

export function formatAgentQuestion(
  question: string,
  options: { timeoutMs?: number } = {}
): string {
  const timeoutMs = questionTimeoutMs(options.timeoutMs);
  const kind = classifyDangerousCommand(question);
  const lines = [question.trim() || 'The agent needs your input to continue.'];

  if (kind) {
    lines.push('', formatDangerousCommandWarning(kind));
  }

  lines.push(
    '',
    `⏱ Times out in ${formatQuestionTimeout(timeoutMs)}. ` +
      (kind
        ? 'Dangerous questions cancel instead of auto-picking Yes. Send /stop to cancel now.'
        : 'The first option is chosen if nobody answers. Send /stop to cancel instead.')
  );

  return lines.join('\n');
}

export function formatQuestionTimedOut(chosen: string): string {
  if (isQuestionCancelled(chosen) || !chosen.trim()) {
    return 'Question timed out. Cancelled — nothing was auto-approved. Session is still open.';
  }
  return `Question timed out after ${formatQuestionTimeout(QUESTION_TIMEOUT_MS)}. Chose: ${chosen}`;
}

export function formatQuestionCancelled(): string {
  return 'Cancelled the pending question. Session is still open.';
}

export const APPLY_PLAN_PROMPT =
  'Apply the plan you just proposed. Implement it now in the workspace. Do not only restate the plan.';
