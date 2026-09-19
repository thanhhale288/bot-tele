import { describe, expect, it } from 'vitest';
import {
  extractStepFromToolCall,
  formatElapsed,
  formatRunProgress,
  type AgentRunProgress,
} from './run-progress.js';

describe('run-progress', () => {
  it('extracts file and command from tool args', () => {
    const read = extractStepFromToolCall('Read', { path: 'src/auth.ts' }, 'running');
    expect(read.tool).toBe('Read');
    expect(read.file).toBe('src/auth.ts');
    expect(read.command).toBeNull();

    const shell = extractStepFromToolCall('Shell', { command: 'npm test' }, 'running');
    expect(shell.tool).toBe('Shell');
    expect(shell.command).toBe('npm test');
  });

  it('formats idle and running snapshots', () => {
    expect(formatRunProgress(undefined)).toMatch(/idle/i);
    const running: AgentRunProgress = {
      activity: 'running',
      runStartedAt: new Date().toISOString(),
      elapsedMs: 45000,
      step: {
        tool: 'Read',
        file: 'src/a.ts',
        command: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    };
    const text = formatRunProgress(running);
    expect(text).toContain('Read');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('45s');
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(800)).toBe('800ms');
    expect(formatElapsed(12000)).toBe('12s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });
});
