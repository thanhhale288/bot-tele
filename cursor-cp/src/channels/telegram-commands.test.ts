import { describe, expect, it } from 'vitest';
import { listTelegramBotCommands, telegramStartHelp } from './telegram-commands.js';

describe('telegram commands', () => {
  it('registers phase-0 and reserved commands for autocomplete', () => {
    const names = listTelegramBotCommands().map((c) => c.command);
    for (const required of [
      'ask',
      'agent',
      'plan',
      'machine',
      'progress',
      'stop',
      'diff',
      'files',
      'open',
      'search',
      'tree',
      'undo',
      'status',
      'log',
      'commit',
      'push',
      'pr',
      'test',
      'lint',
      'dev',
      'preview',
      'shot',
      'logs',
      'rules',
      'close',
      'current',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('help mentions session keep and close warning', () => {
    const help = telegramStartHelp();
    expect(help).toContain('/sessions');
    expect(help).toContain('/close');
    expect(help).toContain('keeps the old session');
    expect(help).toContain('/progress');
    expect(help).toContain('/stop');
    expect(help).toContain('/diff');
    expect(help).toContain('/undo');
    expect(help).toContain('/status');
    expect(help).toContain('/commit');
    expect(help).toContain('/test');
    expect(help).toContain('/preview');
    expect(help).toContain('photo');
    expect(help).toContain('voice');
    expect(help).toContain('@path/to/file');
    expect(help).toContain('/rules');
    expect(help).toContain('/ui stop');
  });
});
