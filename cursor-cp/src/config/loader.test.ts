/**
 * Tests for configuration loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { deepMerge, loadConfigFromPaths } from './loader.js';
import { defaultWorkspaceRoot } from '../paths.js';

describe('deepMerge', () => {
  it('merges nested objects and replaces scalars', () => {
    const base = { server: { host: '0.0.0.0', port: 8747 }, cursor: { api_key: '' } };
    const override = { cursor: { api_key: 'cursor_abc' }, server: { port: 9000 } };
    const merged = deepMerge(base, override);
    expect(merged).toEqual({
      server: { host: '0.0.0.0', port: 9000 },
      cursor: { api_key: 'cursor_abc' },
    });
  });
});

describe('loadConfigFromPaths', () => {
  let tempDir: string;
  let defaultPath: string;
  let overridePath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    defaultPath = resolve(tempDir, 'config.default.yaml');
    overridePath = resolve(tempDir, 'config.yaml');
  });

  afterEach(() => {
    for (const path of [defaultPath, overridePath]) {
      try {
        unlinkSync(path);
      } catch { /* ignore */ }
    }
    try {
      rmdirSync(tempDir);
    } catch { /* ignore */ }
  });

  it('loads defaults when no override exists', () => {
    writeFileSync(defaultPath, 'server:\n  port: 8747\n');
    const { config } = loadConfigFromPaths(defaultPath, [overridePath]);
    expect(config.server.port).toBe(8747);
    expect(config.workspaceRoot).toBe(defaultWorkspaceRoot());
  });

  it('merges override onto defaults', () => {
    writeFileSync(defaultPath, 'server:\n  host: 0.0.0.0\n  port: 8747\nsdk:\n  default_model: composer-2.5\n');
    writeFileSync(
      overridePath,
      `cursor:\n  api_key: file-key\nserver:\n  port: 3000\nchannels:\n  telegram:\n    bot_token: tok\n    allowed_user_ids: [1]\n`
    );

    const { config, overridePaths } = loadConfigFromPaths(defaultPath, [overridePath]);

    expect(overridePaths).toEqual([overridePath]);
    expect(config.cursorApiKey).toBe('file-key');
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.port).toBe(3000);
    expect(config.sdk.defaultModel).toBe('composer-2.5');
    expect(config.channels.telegram.botToken).toBe('tok');
    expect(config.channels.telegram.allowedUserIds).toEqual([1]);
  });
});

describe('applyEnvOverrides', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env.CURSOR_API_KEY = original.CURSOR_API_KEY;
    process.env.TELEGRAM_BOT_TOKEN = original.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_ALLOWED_USER_ID = original.TELEGRAM_ALLOWED_USER_ID;
    process.env.TELEGRAM_ALLOWED_USER_IDS = original.TELEGRAM_ALLOWED_USER_IDS;
  });

  it('overlays API key and telegram allowlist from env', async () => {
    const { applyEnvOverrides } = await import('./loader.js');
    process.env.CURSOR_API_KEY = 'cursor_from_env';
    process.env.TELEGRAM_BOT_TOKEN = 'bot:token';
    process.env.TELEGRAM_ALLOWED_USER_ID = '12345';

    const config = applyEnvOverrides({
      cursorApiKey: '',
      repos: [],
      workspaceRoot: '/tmp',
      channels: {
        telegram: { enabled: false, botToken: '', allowedUserIds: [] },
        web: { enabled: true },
      },
      server: { host: '127.0.0.1', port: 8747 },
      sdk: { defaultModel: 'composer-2.5', maxSessions: 5 },
      logging: { level: 'info', file: null },
    });

    expect(config.cursorApiKey).toBe('cursor_from_env');
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('bot:token');
    expect(config.channels.telegram.allowedUserIds).toEqual([12345]);
  });
});
