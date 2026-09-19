import { describe, expect, it } from 'vitest';
import {
  classifyDangerousCommand,
  formatDangerousCommandWarning,
} from './dangerous-command.js';

describe('classifyDangerousCommand', () => {
  it('detects rm -rf, force-push, reset, drop, and migrate', () => {
    expect(classifyDangerousCommand('rm -rf /tmp/app')).toBe('rm-rf');
    expect(classifyDangerousCommand('rm -fr ./dist')).toBe('rm-rf');
    expect(classifyDangerousCommand('git push --force origin main')).toBe('force-push');
    expect(classifyDangerousCommand('push -f')).toBe('force-push');
    expect(classifyDangerousCommand('git reset --hard HEAD~1')).toBe('reset-hard');
    expect(classifyDangerousCommand('DROP DATABASE app')).toBe('drop-db');
    expect(classifyDangerousCommand('prisma migrate reset')).toBe('drop-db');
    expect(classifyDangerousCommand('prisma migrate deploy')).toBe('migrate');
    expect(classifyDangerousCommand('npm run migrate')).toBe('migrate');
  });

  it('leaves ordinary commands alone', () => {
    expect(classifyDangerousCommand('git status')).toBeNull();
    expect(classifyDangerousCommand('npm test')).toBeNull();
    expect(classifyDangerousCommand('rm file.txt')).toBeNull();
  });

  it('formats a confirmation warning', () => {
    expect(formatDangerousCommandWarning('rm-rf')).toMatch(/rm -rf/i);
    expect(formatDangerousCommandWarning('rm-rf')).toMatch(/\/stop/);
  });
});
