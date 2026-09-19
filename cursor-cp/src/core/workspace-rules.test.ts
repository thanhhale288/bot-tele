import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { extraRulesPromptPrefix, summarizeWorkspaceRules } from './workspace-rules.js';

describe('workspace-rules', () => {
  it('summarizes .cursorrules and session extras', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'rules-'));
    writeFileSync(resolve(cwd, '.cursorrules'), 'always be kind');
    const text = await summarizeWorkspaceRules(cwd, 'no force-push');
    expect(text).toContain('.cursorrules');
    expect(text).toContain('always be kind');
    expect(text).toContain('no force-push');
    expect(extraRulesPromptPrefix('be careful')).toContain('[SESSION EXTRA RULES]');
    expect(extraRulesPromptPrefix('')).toBe('');
  });
});
