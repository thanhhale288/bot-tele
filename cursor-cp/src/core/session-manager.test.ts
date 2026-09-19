/**
 * Tests for SessionManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAgent, sdkMock } = vi.hoisted(() => {
  const mockAgent = {
    agentId: 'agent-test-id',
    model: { id: 'composer-2' },
    send: vi.fn(),
    close: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    listArtifacts: vi.fn().mockResolvedValue([]),
    downloadArtifact: vi.fn(),
  };

  return {
    mockAgent,
    sdkMock: {
      Agent: {
        create: vi.fn().mockResolvedValue(mockAgent),
        resume: vi.fn().mockResolvedValue(mockAgent),
      },
      Cursor: {
        models: {
          list: vi.fn().mockResolvedValue([{ id: 'composer-2', displayName: 'Composer 2' }]),
        },
      },
      CursorAgentError: class CursorAgentError extends Error {
        isRetryable = false;
      },
    },
  };
});

vi.mock('@cursor/sdk', () => sdkMock);
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { SessionManager, SessionLimitError } from './session-manager.js';
import { AgentService } from './agent-service.js';
import { EventBus } from './events.js';
import {
  SessionRepository,
  MessageRepository,
  ParticipantRepository,
  SettingsRepository,
} from '../db/repositories.js';
import type { ChannelRegistry } from '../channels/base.js';
import { migrateAgentSessions } from '../db/connection.js';

const mockRegistry: ChannelRegistry = {
  register: () => {},
  get: () => undefined,
  list: () => [],
  startAll: async () => {},
  stopAll: async () => {},
};

describe('SessionManager', () => {
  let db: Database.Database;
  let sessionManager: SessionManager;
  let agentService: AgentService;
  let eventBus: EventBus;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.Agent.create.mockResolvedValue(mockAgent);

    dbPath = resolve(tmpdir(), `test-sm-${Date.now()}.db`);
    db = new Database(dbPath);

    // Setup schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        repo_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        model TEXT,
        sdk_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (session_id, channel, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);
    migrateAgentSessions(db);

    eventBus = new EventBus();
    agentService = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
    });

    sessionManager = new SessionManager({
      repositories: {
        sessions: new SessionRepository(db),
        messages: new MessageRepository(db),
        participants: new ParticipantRepository(db),
        settings: new SettingsRepository(db),
      },
      agentService,
      eventBus,
      registry: mockRegistry,
      maxSessions: 2,
      defaultModel: 'composer-2',
    });
  });

  afterEach(async () => {
    // Clean up all sessions before closing DB
    try {
      await sessionManager.closeAllSessions();
    } catch { /* ignore */ }

    db.close();
    try {
      unlinkSync(dbPath);
    } catch { /* ignore */ }
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const session = await sessionManager.createSession(
        'web',
        'web:default',
        '/tmp/repo',
        'Test Session'
      );

      expect(session).toBeDefined();
      expect(session.channel).toBe('web');
      expect(session.title).toBe('Test Session');
      expect(session.repoPath).toBe('/tmp/repo');
      expect(session.status).toBe('open');
      expect(session.mode).toBe('agent');
    });

    it('should enforce session limit', async () => {
      await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      await sessionManager.createSession('web', 'web:2', '/tmp/r2', 'S2');

      await expect(
        sessionManager.createSession('web', 'web:3', '/tmp/r3', 'S3')
      ).rejects.toThrow(SessionLimitError);
    });

    it('should use provided model', async () => {
      const session = await sessionManager.createSession(
        'web',
        'web:default',
        '/tmp/repo',
        'Test',
        'claude-sonnet-4'
      );

      expect(session.model).toBe('claude-sonnet-4');
    });

    it('should persist sdk agent id', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');

      const fromDb = sessionManager.getSession(session.id);
      expect(fromDb?.sdkAgentId).toBe('agent-test-id');
    });
  });

  describe('rehydration after restart', () => {
    it('should resume SDK agent from persisted id', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      expect(session.sdkAgentId).toBe('agent-test-id');

      // Simulate process restart: new in-memory agent service, same DB
      await agentService.closeAllSessions();
      const restartedAgentService = new AgentService({
        apiKey: 'test-key',
        defaultModel: 'composer-2',
      });
      sdkMock.Agent.resume.mockResolvedValue(mockAgent);

      const restartedManager = new SessionManager({
        repositories: {
          sessions: new SessionRepository(db),
          messages: new MessageRepository(db),
          participants: new ParticipantRepository(db),
          settings: new SettingsRepository(db),
        },
        agentService: restartedAgentService,
        eventBus,
        registry: mockRegistry,
        maxSessions: 2,
        defaultModel: 'composer-2',
      });

      sdkMock.Agent.create.mockClear();
      sdkMock.Agent.resume.mockClear();

      mockAgent.send.mockResolvedValue({
        id: 'run-2',
        agentId: 'agent-test-id',
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Resumed reply' }],
            },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-2',
          status: 'finished',
          result: 'Resumed reply',
        }),
      });

      const joined = await restartedManager.joinSession(session.id, 'web', 'web:1');
      expect(joined).toBeDefined();
      expect(sdkMock.Agent.resume).toHaveBeenCalledWith(
        'agent-test-id',
        expect.objectContaining({
          apiKey: 'test-key',
          model: { id: 'composer-2' },
          local: expect.objectContaining({ cwd: '/tmp/r1' }),
        })
      );
      expect(sdkMock.Agent.create).not.toHaveBeenCalled();

      const result = await restartedManager.sendSessionMessage(session.id, 'Continue', 'web', 'web:1');
      expect(result.activity).not.toBe('error');
      expect(mockAgent.send).toHaveBeenCalledWith('Continue');
    });
  });

  describe('closeSession', () => {
    it('should close and delete session', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');

      const result = await sessionManager.closeSession(session.id);
      expect(result).toBe(true);

      const found = sessionManager.getSession(session.id);
      expect(found).toBeUndefined();
    });

    it('should return false for nonexistent session', async () => {
      const result = await sessionManager.closeSession('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list sessions by channel', async () => {
      // Clean up from previous tests
      await sessionManager.closeAllSessions();

      await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      await sessionManager.createSession('web', 'web:1', '/tmp/r2', 'S2');

      const webSessions = sessionManager.listSessions('web', 'web:1', true);
      expect(webSessions).toHaveLength(2);
    });
  });

  describe('session mode', () => {
    it('sets and persists mode', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      const updated = sessionManager.setSessionMode(session.id, 'ask');
      expect(updated?.mode).toBe('ask');
      expect(sessionManager.getSession(session.id)?.mode).toBe('ask');
    });

    it('prefixes ask-mode prompts sent to the agent', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      sessionManager.setSessionMode(session.id, 'ask');

      mockAgent.send.mockResolvedValue({
        id: 'run-ask',
        agentId: 'agent-test-id',
        async *stream() {},
        wait: vi.fn().mockResolvedValue({
          id: 'run-ask',
          status: 'finished',
          result: 'ok',
        }),
      });

      await sessionManager.sendSessionMessage(session.id, 'What does main.ts do?', 'web', 'web:1');
      expect(mockAgent.send).toHaveBeenCalledWith(
        expect.stringContaining('[SESSION MODE: ask')
      );
      expect(mockAgent.send).toHaveBeenCalledWith(
        expect.stringContaining('What does main.ts do?')
      );
      expect(sessionManager.getSession(session.id)?.lastCommand).toBe('What does main.ts do?');
    });

    it('stores extra rules and last plan', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      expect(sessionManager.setExtraRules(session.id, 'no secrets')).toBe('no secrets');
      expect(sessionManager.getExtraRules(session.id)).toBe('no secrets');
      sessionManager.setExtraRules(session.id, '');
      expect(sessionManager.getExtraRules(session.id)).toBe('');

      sessionManager.setSessionMode(session.id, 'plan');
      mockAgent.send.mockResolvedValue({
        id: 'run-plan',
        agentId: 'agent-test-id',
        async *stream() {},
        wait: vi.fn().mockResolvedValue({
          id: 'run-plan',
          status: 'finished',
          result: '1. add auth',
        }),
      });
      await sessionManager.sendSessionMessage(session.id, 'plan auth', 'web', 'web:1');
      expect(sessionManager.getLastPlan(session.id)).toMatch(/add auth|plan auth/i);
    });

    it('forwards image prompts as objects with text and images', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      const images = [{ data: 'abc', mimeType: 'image/png' }];

      mockAgent.send.mockResolvedValue({
        id: 'run-img',
        agentId: 'agent-test-id',
        async *stream() {},
        wait: vi.fn().mockResolvedValue({
          id: 'run-img',
          status: 'finished',
          result: 'ok',
        }),
      });

      await sessionManager.sendSessionMessage(
        session.id,
        'fix this screenshot',
        'web',
        'web:1',
        { images }
      );

      expect(mockAgent.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('fix this screenshot'),
          images,
        })
      );
    });
  });

  describe('stopCurrentRun', () => {
    it('returns Session not found for an unknown session', async () => {
      const result = await sessionManager.stopCurrentRun('nonexistent');
      expect(result).toEqual({ stopped: false, reason: 'Session not found' });
    });

    it('returns No run in progress for an idle session', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      expect(session.activity).toBe('idle');

      const result = await sessionManager.stopCurrentRun(session.id);
      expect(result).toEqual({ stopped: false, reason: 'No run in progress' });
    });

    it('treats a cancelled agent run as idle, not error', async () => {
      const session = await sessionManager.createSession('web', 'web:1', '/tmp/r1', 'S1');
      mockAgent.send.mockResolvedValue({
        id: 'run-c',
        agentId: 'agent-test-id',
        async *stream() {},
        wait: vi.fn().mockResolvedValue({
          id: 'run-c',
          status: 'cancelled',
          result: '',
        }),
      });

      await sessionManager.sendSessionMessage(session.id, 'do it', 'web', 'web:1');
      const after = sessionManager.getSession(session.id);
      expect(after?.status).toBe('open');
      expect(after?.activity).toBe('idle');
      expect(after?.errorMessage).toMatch(/cancelled/i);
    });
  });

  describe('default model', () => {
    it('should get default model', () => {
      expect(sessionManager.getDefaultModel()).toBe('composer-2');
    });

    it('should set default model', () => {
      sessionManager.setDefaultModel('gpt-4');
      expect(sessionManager.getDefaultModel()).toBe('gpt-4');
    });

    it('should clear default model', () => {
      sessionManager.setDefaultModel('gpt-4');
      sessionManager.setDefaultModel(null);
      expect(sessionManager.getDefaultModel()).toBe('composer-2');
    });
  });
});
