/**
 * Tests for AgentService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        prompt: vi.fn(),
        resume: vi.fn(),
        list: vi.fn(),
      },
      Cursor: {
        models: {
          list: vi.fn().mockResolvedValue([
            { id: 'composer-2', displayName: 'Composer 2' },
            { id: 'auto', displayName: 'Auto' },
          ]),
        },
      },
      CursorAgentError: class CursorAgentError extends Error {
        isRetryable: boolean;
        constructor(message: string, isRetryable = false) {
          super(message);
          this.name = 'CursorAgentError';
          this.isRetryable = isRetryable;
        }
      },
      AgentBusyError: class AgentBusyError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'AgentBusyError';
        }
      },
    },
  };
});

vi.mock('@cursor/sdk', () => sdkMock);

import { AgentService } from './agent-service.js';

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.Agent.create.mockResolvedValue(mockAgent);
    sdkMock.Agent.resume.mockResolvedValue(mockAgent);
    service = new AgentService({
      apiKey: 'test-key',
      defaultModel: 'composer-2',
    });
  });

  it('should initialize with correct options', () => {
    expect(service).toBeDefined();
  });

  it('should create session via Agent.create', async () => {
    const session = await service.createSession('test-id', '/tmp/workspace');

    expect(sdkMock.Agent.create).toHaveBeenCalledWith({
      apiKey: 'test-key',
      model: { id: 'composer-2' },
      local: {
        cwd: '/tmp/workspace',
        settingSources: ['project'],
      },
    });
    expect(session).toBeDefined();
    expect(session.id).toBe('test-id');
    expect(session.workspacePath).toBe('/tmp/workspace');
    expect(session.model).toBe('composer-2');
    expect(session.sdkAgentId).toBe('agent-test-id');
  });

  it('should resume session via Agent.resume', async () => {
    const session = await service.resumeSession(
      'test-id',
      'agent-existing-id',
      '/tmp/workspace',
      'composer-2'
    );

    expect(sdkMock.Agent.resume).toHaveBeenCalledWith('agent-existing-id', {
      apiKey: 'test-key',
      model: { id: 'composer-2' },
      local: {
        cwd: '/tmp/workspace',
        settingSources: ['project'],
      },
    });
    expect(session.id).toBe('test-id');
    expect(session.sdkAgentId).toBe('agent-test-id');
    expect(service.getSession('test-id')).toBeDefined();
  });

  it('should list sessions', () => {
    const sessions = service.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should handle session not found', async () => {
    const result = await service.sendPrompt('nonexistent-id', 'test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });

  it('should stream assistant output and wait for completion', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-1',
      agentId: 'agent-test-id',
      async *stream() {
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
          },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-1',
        status: 'finished',
        result: 'Hello world',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi');

    expect(result.success).toBe(true);
    expect(result.text).toBe('Hello world');
    expect(mockAgent.send).toHaveBeenCalledWith('Hi');
  });

  it('should forward image prompts as SDKUserMessage objects', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-img',
      agentId: 'agent-test-id',
      async *stream() {
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-img',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
          },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-img',
        status: 'finished',
        result: 'ok',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const prompt = {
      text: 'fix this',
      images: [{ data: 'abc', mimeType: 'image/png' }],
    };
    const result = await service.sendPrompt('test-id', prompt);

    expect(result.success).toBe(true);
    expect(mockAgent.send).toHaveBeenCalledWith(prompt);
  });

  it('should retry send with local.force when agent has wedged active run', async () => {
    mockAgent.send
      .mockRejectedValueOnce(new Error('Agent already has active run'))
      .mockResolvedValueOnce({
        id: 'run-2',
        agentId: 'agent-test-id',
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered' }],
            },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-2',
          status: 'finished',
          result: 'Recovered',
        }),
      });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Hi again');

    expect(result.success).toBe(true);
    expect(mockAgent.send).toHaveBeenCalledTimes(2);
    expect(mockAgent.send).toHaveBeenNthCalledWith(1, 'Hi again');
    expect(mockAgent.send).toHaveBeenNthCalledWith(2, 'Hi again', { local: { force: true } });
  });

  it('should register question callback', async () => {
    const questionHandler = vi.fn().mockResolvedValue('Yes');
    service.onQuestion(questionHandler);

    await service.createSession('test-id', '/tmp/workspace');
    expect(service).toBeDefined();
  });

  it('should list models via Cursor.models.list', async () => {
    const models = await service.listAvailableModels();

    expect(sdkMock.Cursor.models.list).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(models).toEqual([
      { id: 'composer-2', name: 'Composer 2' },
      { id: 'auto', name: 'Auto' },
    ]);
  });

  it('should expose current step from tool_call events during and after the tool chunk', async () => {
    const snapshots: Array<ReturnType<AgentService['getRunProgress']>> = [];

    service.onStream((sessionId, chunk) => {
      if (chunk.type === 'tool' || chunk.type === 'text') {
        snapshots.push(service.getRunProgress(sessionId));
      }
    });

    mockAgent.send.mockResolvedValue({
      id: 'run-tool',
      agentId: 'agent-test-id',
      supports: vi.fn((capability: string) => capability === 'cancel'),
      cancel: vi.fn().mockResolvedValue(undefined),
      async *stream() {
        yield {
          type: 'tool_call',
          agent_id: 'agent-test-id',
          run_id: 'run-tool',
          call_id: 'call-1',
          name: 'Read',
          status: 'running',
          args: { path: 'src/a.ts' },
        };
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-tool',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'File contents' }],
          },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-tool',
        status: 'finished',
        result: 'File contents',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const result = await service.sendPrompt('test-id', 'Read the file');

    expect(snapshots).toHaveLength(2);
    for (const progress of snapshots) {
      expect(progress?.activity).toBe('running');
      expect(progress?.step?.tool).toBe('Read');
      expect(progress?.step?.file).toBe('src/a.ts');
      expect(progress?.step?.status).toBe('running');
    }
    expect(result.success).toBe(true);
    expect(result.text).toBe('File contents');
    expect(service.getTouchedFiles('test-id')).toEqual(['src/a.ts']);
  });

  it('keeps last-run touched files after the run finishes', async () => {
    mockAgent.send.mockResolvedValue({
      id: 'run-files',
      agentId: 'agent-test-id',
      async *stream() {
        yield {
          type: 'tool_call',
          agent_id: 'agent-test-id',
          run_id: 'run-files',
          call_id: 'call-1',
          name: 'Read',
          status: 'running',
          args: { path: 'src/a.ts' },
        };
        yield {
          type: 'tool_call',
          agent_id: 'agent-test-id',
          run_id: 'run-files',
          call_id: 'call-2',
          name: 'StrReplace',
          status: 'running',
          args: { path: 'src/b.ts' },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-files',
        status: 'finished',
        result: 'ok',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    await service.sendPrompt('test-id', 'edit');
    expect(service.getTouchedFiles('test-id')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(service.getRunProgress('test-id')?.activity).toBe('idle');
  });

  it('should call run.cancel when cancelCurrentRun is used on a live run', async () => {
    let releaseStream!: () => void;
    const streamLatch = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let streamReady!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      streamReady = resolve;
    });

    const cancel = vi.fn().mockImplementation(async () => {
      releaseStream();
    });
    const supports = vi.fn((capability: string) => capability === 'cancel');

    mockAgent.send.mockResolvedValue({
      id: 'run-long',
      agentId: 'agent-test-id',
      supports,
      cancel,
      async *stream() {
        streamReady();
        await streamLatch;
        yield {
          type: 'assistant',
          agent_id: 'agent-test-id',
          run_id: 'run-long',
          message: { role: 'assistant', content: [] },
        };
      },
      wait: vi.fn().mockResolvedValue({
        id: 'run-long',
        status: 'cancelled',
        result: '',
      }),
    });

    await service.createSession('test-id', '/tmp/workspace');
    const sendPromise = service.sendPrompt('test-id', 'Long task');
    await streamStarted;

    const cancelled = await service.cancelCurrentRun('test-id');
    expect(cancelled).toBe(true);
    expect(supports).toHaveBeenCalledWith('cancel');
    expect(cancel).toHaveBeenCalled();

    const result = await sendPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
  });

  it('should return false from cancelCurrentRun when no run is in progress', async () => {
    expect(await service.cancelCurrentRun('missing')).toBe(false);

    await service.createSession('test-id', '/tmp/workspace');
    expect(await service.cancelCurrentRun('test-id')).toBe(false);
  });

  it('cancels a run that is assigned after cancelCurrentRun', async () => {
    let releaseSend!: () => void;
    const sendLatch = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const cancel = vi.fn().mockResolvedValue(undefined);

    mockAgent.send.mockImplementation(async () => {
      await sendLatch;
      return {
        id: 'run-late',
        agentId: 'agent-test-id',
        supports: (capability: string) => capability === 'cancel',
        cancel,
        async *stream() {
          yield {
            type: 'assistant',
            agent_id: 'agent-test-id',
            run_id: 'run-late',
            message: { role: 'assistant', content: [] },
          };
        },
        wait: vi.fn().mockResolvedValue({
          id: 'run-late',
          status: 'cancelled',
          result: '',
        }),
      };
    });

    await service.createSession('test-id', '/tmp/workspace');
    const sendPromise = service.sendPrompt('test-id', 'Hi');
    await Promise.resolve();
    expect(service.getRunProgress('test-id')?.activity).toBe('running');

    const cancelled = await service.cancelCurrentRun('test-id');
    expect(cancelled).toBe(true);
    releaseSend();

    const result = await sendPromise;
    expect(cancel).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
  });
});
