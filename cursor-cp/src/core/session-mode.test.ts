import { describe, expect, it } from 'vitest';
import {
  modeAllowsWrites,
  parseSessionMode,
  promptWithSessionMode,
  summarizeUserCommand,
} from './session-mode.js';

describe('session mode', () => {
  it('defaults unknown values to agent', () => {
    expect(parseSessionMode(undefined)).toBe('agent');
    expect(parseSessionMode('nope')).toBe('agent');
    expect(parseSessionMode('ask')).toBe('ask');
  });

  it('only agent mode allows writes', () => {
    expect(modeAllowsWrites('agent')).toBe(true);
    expect(modeAllowsWrites('ask')).toBe(false);
    expect(modeAllowsWrites('plan')).toBe(false);
  });

  it('leaves agent prompts unchanged', () => {
    expect(promptWithSessionMode('agent', 'fix the bug')).toBe('fix the bug');
  });

  it('prefixes ask and plan prompts', () => {
    expect(promptWithSessionMode('ask', 'why?')).toContain('[SESSION MODE: ask');
    expect(promptWithSessionMode('ask', 'why?')).toContain('why?');
    expect(promptWithSessionMode('plan', 'add auth')).toContain('[SESSION MODE: plan');
  });

  it('summarizes the first line of a user command', () => {
    expect(summarizeUserCommand('hello\nworld')).toBe('hello');
    expect(summarizeUserCommand('x'.repeat(200)).length).toBe(120);
  });
});
