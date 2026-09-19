/**
 * Cursor SDK Agent Service
 * Manages agent lifecycle using the official @cursor/sdk
 */

import {
  Agent,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type Run,
  type SDKAgent,
} from '@cursor/sdk';
import type { AgentActivity } from '../models/types.js';
import {
  extractStepFromToolCall,
  type AgentRunProgress,
  type AgentRunStep,
} from './run-progress.js';
import { isWedgedActiveRunError } from '../util/agent-errors.js';
import { isQuestionCancelled } from './agent-question.js';
import { logger } from '../util/logger.js';

export interface AgentRunResult {
  success: boolean;
  error?: string;
  text: string;
}

export type AgentPromptImage =
  | { data: string; mimeType: string }
  | { url: string };

export type AgentPrompt =
  | string
  | { text: string; images?: AgentPromptImage[] };

export interface AgentSession {
  id: string;
  agent: SDKAgent;
  sdkAgentId: string;
  model: string;
  workspacePath: string;
  activity: AgentActivity;
  outputBuffer: string;
  createdAt: Date;
  currentRun: Run | null;
  runStartedAt: Date | null;
  currentStep: AgentRunStep | null;
  touchedFiles: string[];
}

interface StreamChunk {
  text: string;
  type: 'text' | 'tool' | 'error' | 'thinking' | 'status';
}

export interface AgentQuestion {
  question: string;
  options: string[];
  requestId?: string;
}

export class AgentService {
  private sessions: Map<string, AgentSession> = new Map();
  private apiKey: string;
  private defaultModel: string;
  private onStreamCallback?: (sessionId: string, chunk: StreamChunk) => void;
  private onQuestionCallback?: (sessionId: string, question: AgentQuestion) => Promise<string>;
  /** /stop before currentRun exists — cancel as soon as the SDK run is assigned. */
  private pendingCancels = new Set<string>();

  constructor(options: { apiKey: string; defaultModel: string }) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
  }

  onStream(callback: (sessionId: string, chunk: StreamChunk) => void): void {
    this.onStreamCallback = callback;
  }

  onQuestion(callback: (sessionId: string, question: AgentQuestion) => Promise<string>): void {
    this.onQuestionCallback = callback;
  }

  async createSession(
    sessionId: string,
    workspacePath: string,
    model?: string | null
  ): Promise<AgentSession> {
    const effectiveModel = model || this.defaultModel;

    const agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: effectiveModel },
      local: {
        cwd: workspacePath,
        // Avoid loading ambient user IDE settings. 'project' loads
        // .cursorrules / .cursor/rules from the workspace cwd.
        settingSources: ['project'],
      },
    });

    const session: AgentSession = {
      id: sessionId,
      agent,
      sdkAgentId: agent.agentId,
      model: effectiveModel,
      workspacePath,
      activity: 'idle',
      outputBuffer: '',
      createdAt: new Date(),
      currentRun: null,
      runStartedAt: null,
      currentStep: null,
      touchedFiles: [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  async resumeSession(
    sessionId: string,
    sdkAgentId: string,
    workspacePath: string,
    model?: string | null
  ): Promise<AgentSession> {
    const effectiveModel = model || this.defaultModel;
    const cwd = workspacePath || process.cwd();

    const agent = await Agent.resume(sdkAgentId, {
      apiKey: this.apiKey,
      model: { id: effectiveModel },
      local: {
        cwd,
        // Avoid loading ambient user IDE settings. 'project' loads
        // .cursorrules / .cursor/rules from the workspace cwd.
        settingSources: ['project'],
      },
    });

    const session: AgentSession = {
      id: sessionId,
      agent,
      sdkAgentId: agent.agentId,
      model: effectiveModel,
      workspacePath: cwd,
      activity: 'idle',
      outputBuffer: '',
      createdAt: new Date(),
      currentRun: null,
      runStartedAt: null,
      currentStep: null,
      touchedFiles: [],
    };

    this.sessions.set(sessionId, session);
    logger.info({ sessionId, sdkAgentId: agent.agentId, cwd }, 'Agent session resumed');
    return session;
  }

  async sendPrompt(sessionId: string, prompt: AgentPrompt): Promise<AgentRunResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found', text: '' };
    }

    session.activity = 'running';
    session.outputBuffer = '';
    session.runStartedAt = new Date();
    session.currentStep = null;
    session.currentRun = null;
    session.touchedFiles = [];

    try {
      let followUpPrompt: AgentPrompt | undefined = prompt;

      while (followUpPrompt) {
        const currentPrompt = followUpPrompt;
        followUpPrompt = undefined;

        const run = await this.sendPromptToAgent(session, currentPrompt);
        session.currentRun = run;
        if (this.pendingCancels.has(sessionId)) {
          this.pendingCancels.delete(sessionId);
          if (run.supports('cancel')) {
            await run.cancel();
          }
        }
        logger.info(
          { sessionId, agentId: session.sdkAgentId, runId: run.id },
          'Agent run started'
        );

        const pendingAnswer = await this.consumeRunStream(sessionId, session, run);
        const result = await run.wait();
        session.currentRun = null;

        if (pendingAnswer) {
          followUpPrompt = pendingAnswer;
          continue;
        }

        if (result.status === 'error') {
          session.activity = 'error';
          session.currentStep = null;
          logger.error({ sessionId, runId: result.id }, 'Agent run failed');
          return {
            success: false,
            error: `Agent run failed: ${result.id}`,
            text: this.finalText(session, result.result),
          };
        }

        if (result.status === 'cancelled') {
          session.activity = 'idle';
          session.currentStep = null;
          session.runStartedAt = null;
          return {
            success: false,
            error: `Agent run cancelled: ${result.id}`,
            text: this.finalText(session, result.result),
          };
        }

        session.activity = 'idle';
        session.currentStep = null;
        session.runStartedAt = null;
        logger.info(
          { sessionId, runId: result.id, textLength: this.finalText(session, result.result).length },
          'Agent run completed'
        );
        return {
          success: true,
          text: this.finalText(session, result.result),
        };
      }

      session.activity = 'idle';
      session.currentRun = null;
      session.currentStep = null;
      return { success: true, text: session.outputBuffer };
    } catch (err) {
      this.pendingCancels.delete(sessionId);
      session.activity = 'error';
      session.currentRun = null;
      logger.error({ err, sessionId }, 'Agent sendPrompt failed');

      if (err instanceof AgentBusyError || isWedgedActiveRunError(err)) {
        return {
          success: false,
          error:
            'Agent is busy with a previous run. Send /stop to cancel it, or wait for the current run to finish.',
          text: session.outputBuffer,
        };
      }

      if (err instanceof CursorAgentError) {
        return {
          success: false,
          error: `Startup failed: ${err.message} (retryable: ${err.isRetryable})`,
          text: session.outputBuffer,
        };
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        text: session.outputBuffer,
      };
    }
  }

  /**
   * Send a prompt, retrying once with local.force when the SDK store has a wedged run
   * (common after SIGTERM/restart mid-agent-run).
   */
  private async sendPromptToAgent(session: AgentSession, prompt: AgentPrompt): Promise<Run> {
    try {
      return await session.agent.send(prompt);
    } catch (err) {
      if (!isWedgedActiveRunError(err)) {
        throw err;
      }
      logger.warn(
        { agentId: session.sdkAgentId, sessionId: session.id },
        'Agent has wedged active run; retrying with local.force'
      );
      return await session.agent.send(prompt, { local: { force: true } });
    }
  }

  private finalText(session: AgentSession, runResult?: string): string {
    return session.outputBuffer || runResult || '';
  }

  private emitChunk(sessionId: string, session: AgentSession, chunk: StreamChunk): void {
    if (chunk.type === 'text') {
      session.outputBuffer += chunk.text;
    }
    this.onStreamCallback?.(sessionId, chunk);
  }

  private lastAssistantText(session: AgentSession): string {
    const lines = session.outputBuffer.trim().split('\n');
    return lines.at(-1)?.trim() || session.outputBuffer.trim();
  }

  private async consumeRunStream(
    sessionId: string,
    session: AgentSession,
    run: Run
  ): Promise<string | undefined> {
    let pendingAnswer: string | undefined;
    let stopStream = false;

    for await (const event of run.stream()) {
      if (stopStream) break;
      switch (event.type) {
        case 'assistant': {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              this.emitChunk(sessionId, session, { text: block.text, type: 'text' });
            }
          }
          break;
        }

        case 'thinking':
          break;

        case 'tool_call': {
          const step = extractStepFromToolCall(event.name, event.args, event.status);
          session.currentStep = step;
          this.rememberTouchedFile(session, step.file);
          const label = [event.name, step.file, step.command].filter(Boolean).join(' · ');
          this.emitChunk(sessionId, session, {
            text: label || event.name || 'tool',
            type: 'tool',
          });
          break;
        }

        case 'status': {
          if (event.message) {
            session.currentStep = {
              tool: session.currentStep?.tool ?? null,
              file: session.currentStep?.file ?? null,
              command: session.currentStep?.command ?? null,
              status: event.message,
              startedAt: session.currentStep?.startedAt ?? new Date().toISOString(),
            };
          }
          this.emitChunk(sessionId, session, {
            text: event.message || event.status,
            type: 'status',
          });
          break;
        }

        case 'task': {
          if (event.text) {
            this.emitChunk(sessionId, session, { text: `${event.text}\n`, type: 'text' });
          }
          break;
        }

        case 'request': {
          const questionText =
            this.lastAssistantText(session) ||
            'The agent needs your input to continue.';

          this.emitChunk(sessionId, session, {
            text: `\n**Input needed:** ${questionText}\n`,
            type: 'text',
          });

          if (this.onQuestionCallback) {
            try {
              const answer = await this.onQuestionCallback(sessionId, {
                question: questionText,
                options: ['Continue'],
                requestId: event.request_id,
              });
              if (isQuestionCancelled(answer)) {
                if (run.supports('cancel')) {
                  await run.cancel();
                }
                pendingAnswer = undefined;
                stopStream = true;
                this.emitChunk(sessionId, session, {
                  text: '\nQuestion cancelled.\n',
                  type: 'text',
                });
                break;
              }
              pendingAnswer = answer;
              this.emitChunk(sessionId, session, { text: `> ${answer}\n`, type: 'text' });
            } catch (err) {
              logger.error({ err, sessionId }, 'Failed to get answer for SDK request event');
            }
          }
          break;
        }

        case 'system':
        case 'user':
          break;

        default: {
          logger.debug({ event }, 'Unhandled SDK event type');
        }
      }
    }

    return pendingAnswer;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    this.pendingCancels.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      await session.agent[Symbol.asyncDispose]();
    } catch (err) {
      logger.error({ err, sessionId }, 'Error disposing agent for session');
    }

    this.sessions.delete(sessionId);
    return true;
  }

  async closeAllSessions(): Promise<number> {
    const count = this.sessions.size;

    for (const [id, session] of this.sessions) {
      try {
        await session.agent[Symbol.asyncDispose]();
      } catch (err) {
        logger.error({ err, sessionId: id }, 'Error disposing agent for session');
      }
    }

    this.sessions.clear();
    return count;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getRunProgress(sessionId: string): AgentRunProgress | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const started = session.runStartedAt?.getTime() ?? null;
    return {
      activity: session.activity,
      runStartedAt: session.runStartedAt?.toISOString() ?? null,
      elapsedMs: started ? Math.max(0, Date.now() - started) : 0,
      step: session.currentStep,
    };
  }

  getTouchedFiles(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.touchedFiles.slice() ?? [];
  }

  private rememberTouchedFile(session: AgentSession, file: string | null): void {
    if (!file) return;
    if (!session.touchedFiles.includes(file)) {
      session.touchedFiles.push(file);
    }
  }

  /**
   * Cancel the in-flight SDK run. Does not dispose the agent or close the session.
   * Safe to call while sendPrompt() is awaiting the stream.
   */
  async cancelCurrentRun(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (!session.currentRun) {
      if (
        session.activity === 'running' ||
        session.activity === 'waiting_user' ||
        session.activity === 'connecting'
      ) {
        this.pendingCancels.add(sessionId);
        session.activity = 'idle';
        session.currentStep = null;
        session.runStartedAt = null;
        return true;
      }
      return false;
    }

    try {
      if (session.currentRun.supports('cancel')) {
        await session.currentRun.cancel();
      } else {
        logger.warn({ sessionId }, 'SDK run does not support cancel');
        return false;
      }
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to cancel agent run');
      return false;
    }

    session.activity = 'idle';
    session.currentStep = null;
    session.runStartedAt = null;
    return true;
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  async listAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const models = await Cursor.models.list({ apiKey: this.apiKey });
      return models.map((m) => ({ id: m.id, name: m.displayName || m.id }));
    } catch (err) {
      logger.error({ err }, 'Failed to list models');
      return [
        { id: this.defaultModel, name: this.defaultModel },
        { id: 'auto', name: 'Auto' },
      ];
    }
  }
}
