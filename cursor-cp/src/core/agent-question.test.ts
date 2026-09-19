import { describe, expect, it } from 'vitest';
import {
  QUESTION_CANCELLED,
  QUESTION_TIMEOUT_MS,
  formatAgentQuestion,
  formatQuestionTimeout,
  isQuestionCancelled,
  timeoutFallbackAnswer,
} from './agent-question.js';

describe('agent-question', () => {
  it('formats timeout and cancel sentinels', () => {
    expect(formatQuestionTimeout(QUESTION_TIMEOUT_MS)).toBe('1 hour');
    expect(formatQuestionTimeout(15 * 60_000)).toBe('15 minutes');
    expect(isQuestionCancelled(QUESTION_CANCELLED)).toBe(true);
    expect(isQuestionCancelled('Yes')).toBe(false);
  });

  it('shows timeout and /stop on questions', () => {
    const text = formatAgentQuestion('Continue?');
    expect(text).toContain('Continue?');
    expect(text).toMatch(/1 hour/);
    expect(text).toContain('/stop');
  });

  it('does not auto-approve dangerous questions on timeout', () => {
    expect(timeoutFallbackAnswer('rm -rf dist', ['Yes', 'No'])).toBe(QUESTION_CANCELLED);
    expect(timeoutFallbackAnswer('Continue?', ['Yes', 'No'])).toBe('Yes');
  });
});
