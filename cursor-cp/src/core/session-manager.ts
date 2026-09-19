/**
 * Session Manager
 * Orchestrates sessions, database, and agent service
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { Session, IncomingMessage, SessionMode } from '../models/types.js';
import type { SessionRepository, MessageRepository, ParticipantRepository, SettingsRepository } from '../db/repositories.js';
import { AgentService } from './agent-service.js';
import { EventBus } from './events.js';
import type { Channel, ChannelRegistry } from '../channels/base.js';
import { isCancelledRunError } from '../util/agent-errors.js';
import { logger } from '../util/logger.js';
import {
  DEFAULT_SESSION_MODE,
  modeAllowsWrites,
  parseSessionMode,
  promptWithSessionMode,
  summarizeUserCommand,
} from './session-mode.js';
import type { AgentRunProgress, StopRunResult } from './run-progress.js';
import { extraRulesPromptPrefix } from './workspace-rules.js';
import { listDirtyFiles, revertNewWrites, writesToRevert } from './workspace-review.js';
import { isQuestionCancelled, QUESTION_CANCELLED } from './agent-question.js';
import { formatWritesReverted, withAgentReplyPrefix } from './session-copy.js';

export class SessionLimitError extends Error {
  constructor(max: number) {
    super(`Maximum ${max} sessions reached. Close one before creating a new session.`);
    this.name = 'SessionLimitError';
  }
}

interface SessionManagerOptions {
  repositories: {
    sessions: SessionRepository;
    messages: MessageRepository;
    participants: ParticipantRepository;
    settings: SettingsRepository;
  };
  agentService: AgentService;
  eventBus: EventBus;
  registry: ChannelRegistry;
  maxSessions: number;
  defaultModel: string;
}

interface ManagedSession extends Session {
  channelInstance?: Channel;
}

export class SessionManager {
  private sessions: SessionRepository;
  private messages: MessageRepository;
  private participants: ParticipantRepository;
  private settings: SettingsRepository;
  private agentService: AgentService;
  private eventBus: EventBus;
  private registry: ChannelRegistry;
  private maxSessions: number;
  private defaultModel: string;
  private managedSessions: Map<string, ManagedSession> = new Map();
  /** Serializes agent sends per session to avoid concurrent SDK runs. */
  private sessionLocks = new Map<string, Promise<void>>();
  private extraRules = new Map<string, string>();
  private lastPlans = new Map<string, string>();

  constructor(options: SessionManagerOptions) {
    this.sessions = options.repositories.sessions;
    this.messages = options.repositories.messages;
    this.participants = options.repositories.participants;
    this.settings = options.repositories.settings;
    this.agentService = options.agentService;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
    this.maxSessions = options.maxSessions;
    this.defaultModel = options.defaultModel;

    this.agentService.onStream((sessionId, chunk) => {
      if (chunk.type === 'text') {
        this.handleStreamChunk(sessionId, chunk.text);
        return;
      }
      if (chunk.type === 'tool' || chunk.type === 'status') {
        this.handleProgressChunk(sessionId, chunk.type, chunk.text);
      }
    });

    // Set up question handler - CRITICAL FIX: Pass full question context
    this.agentService.onQuestion(async (sessionId, question) => {
      return this.handleAgentQuestion(sessionId, question);
    });
  }

  /**
   * Handle agent questions with full context - THIS IS THE BUG FIX
   * Ensures users see the full question text, not just an "OK" button
   */
  private async handleAgentQuestion(
    sessionId: string,
    question: { question: string; options: string[] }
  ): Promise<string> {
    const session = this.managedSessions.get(sessionId);
    if (!session) {
      // No session found, return first option as default
      return question.options[0] || 'OK';
    }

    // Store in session that we're waiting for user input
    session.activity = 'waiting_user';
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    // Get all participants for this session
    const participants = await this.participants.listBySession(sessionId);

    // Ask question on all channels with FULL CONTEXT
    // This is the fix - we pass the complete question text, not just "OK"
    const answerPromises: Promise<string>[] = [];

    for (const participant of participants) {
      const channel = this.registry.get(participant.channel);
      if (!channel) continue;

      // Create proper question text with context
      const fullQuestionText = question.question;

      // Ask the question - this will show the full question text to users
      const answerPromise = channel.askQuestion(
        participant.conversationId,
        fullQuestionText,
        question.options,
        { sessionId, conversationId: participant.conversationId }
      );

      answerPromises.push(answerPromise);
    }

    // Wait for first answer (first-answer-wins strategy)
    if (answerPromises.length > 0) {
      try {
        const answers = await Promise.allSettled(answerPromises);

        // Find first successful answer
        for (const result of answers) {
          if (result.status === 'fulfilled' && result.value) {
            if (isQuestionCancelled(result.value)) {
              session.activity = 'idle';
              await this.eventBus.emit({
                type: 'session_updated',
                session: this.toPublicSession(session),
              });
              return QUESTION_CANCELLED;
            }

            // Broadcast the answer to all participants
            for (const participant of participants) {
              const channel = this.registry.get(participant.channel);
              if (channel) {
                await channel.sendMessage(
                  participant.conversationId,
                  `✅ Answered: ${result.value}`
                );
              }
            }

            // Update session back to running
            session.activity = 'running';
            await this.eventBus.emit({
              type: 'session_updated',
              session: this.toPublicSession(session),
            });

            return result.value;
          }
        }
      } catch (err) {
        logger.error({ err, sessionId }, 'Error handling agent question');
      }
    }

    // Fallback: return first option
    session.activity = 'running';
    return question.options[0] || 'OK';
  }

  private handleProgressChunk(sessionId: string, type: 'tool' | 'status', text: string): void {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    const progress = this.agentService.getRunProgress(sessionId);
    if (progress?.step?.file) {
      session.lastFile = progress.step.file;
      this.sessions.updateLastActivity(sessionId, { lastFile: progress.step.file });
    }

    void this.eventBus.emit({
      type: 'agent_progress',
      session_id: sessionId,
      chunk_type: type,
      text,
      progress,
    });
  }

  getRunProgress(sessionId: string): AgentRunProgress | undefined {
    const managed = this.managedSessions.get(sessionId);
    const fromAgent = this.agentService.getRunProgress(sessionId);
    if (fromAgent) {
      if (managed && managed.activity !== fromAgent.activity && fromAgent.activity !== 'idle') {
        return { ...fromAgent, activity: managed.activity };
      }
      return fromAgent;
    }
    if (!managed) return undefined;
    return {
      activity: managed.activity,
      runStartedAt: null,
      elapsedMs: 0,
      step: null,
    };
  }

  /**
   * Cancel the current agent run. Keeps the session. Must not take the session
   * send lock — /stop has to work while sendSessionMessage is in flight.
   */
  async stopCurrentRun(sessionId: string): Promise<StopRunResult> {
    const session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
    if (!session) {
      return { stopped: false, reason: 'Session not found' };
    }

    let cancelledQuestions = 0;
    for (const channel of this.registry.list()) {
      cancelledQuestions += channel.cancelPendingQuestions?.(sessionId) ?? 0;
    }

    const cancelled = await this.agentService.cancelCurrentRun(sessionId);
    if (!cancelled && cancelledQuestions === 0) {
      return { stopped: false, reason: 'No run in progress' };
    }

    session.activity = 'idle';
    session.errorMessage = 'cancelled';
    this.sessions.touch(sessionId);
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    return { stopped: true };
  }

  private async handleStreamChunk(sessionId: string, text: string): Promise<void> {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    // Update output buffer
    session.outputPreview = (session.outputPreview + text).slice(-4000);

    // Emit to event bus for real-time streaming
    await this.eventBus.emit({
      type: 'agent_stream',
      session_id: sessionId,
      text,
    });

    // Update session in DB
    this.sessions.touch(sessionId);
  }

  /**
   * Send assistant output to non-web participants (Telegram, etc.).
   * Web clients receive real-time chunks via agent_stream on the event bus.
   */
  private async deliverToParticipants(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const participants = this.participants.listBySession(sessionId);
    for (const participant of participants) {
      if (participant.channel === 'web') continue;

      const channel = this.registry.get(participant.channel);
      if (!channel) {
        logger.warn(
          { sessionId, channel: participant.channel },
          'No channel registered for participant delivery'
        );
        continue;
      }

      try {
        const managed =
          this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
        const body = managed ? withAgentReplyPrefix(managed, trimmed) : trimmed;
        await channel.sendMessage(participant.conversationId, body);
        logger.info(
          {
            sessionId,
            channel: participant.channel,
            conversationId: participant.conversationId,
            chars: body.length,
          },
          'Delivered assistant response to participant'
        );
      } catch (err) {
        logger.error(
          { err, sessionId, channel: participant.channel, conversationId: participant.conversationId },
          'Failed to deliver assistant response to participant'
        );
      }
    }
  }

  /**
   * Ensure the Cursor SDK agent exists in memory (resume after restart, or create).
   */
  private async ensureAgentReady(session: Session): Promise<Session> {
    let managed = this.managedSessions.get(session.id);
    if (!managed) {
      managed = { ...session };
      this.managedSessions.set(session.id, managed);
    } else {
      managed.sdkAgentId = session.sdkAgentId ?? managed.sdkAgentId;
      managed.repoPath = session.repoPath || managed.repoPath;
      managed.model = session.model ?? managed.model;
      managed.mode = parseSessionMode(session.mode ?? managed.mode);
      managed.lastCommand = session.lastCommand ?? managed.lastCommand ?? null;
      managed.lastFile = session.lastFile ?? managed.lastFile ?? null;
    }

    if (this.agentService.getSession(session.id)) {
      return managed;
    }

    const workspacePath = managed.repoPath || process.cwd();
    managed.activity = 'connecting';
    managed.errorMessage = null;

    try {
      if (managed.sdkAgentId) {
        try {
          const agentSession = await this.agentService.resumeSession(
            session.id,
            managed.sdkAgentId,
            workspacePath,
            managed.model
          );
          managed.sdkAgentId = agentSession.sdkAgentId;
          this.sessions.updateSdkAgentId(session.id, agentSession.sdkAgentId);
          managed.activity = 'idle';
          return managed;
        } catch (err) {
          logger.warn(
            { err, sessionId: session.id, sdkAgentId: managed.sdkAgentId },
            'Agent resume failed, creating new SDK agent'
          );
        }
      }

      const agentSession = await this.agentService.createSession(
        session.id,
        workspacePath,
        managed.model
      );
      managed.sdkAgentId = agentSession.sdkAgentId;
      this.sessions.updateSdkAgentId(session.id, agentSession.sdkAgentId);
      managed.activity = 'idle';
      return managed;
    } catch (err) {
      managed.activity = 'error';
      managed.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId: session.id }, 'Failed to ensure agent session');
      throw err;
    }
  }

  async createSession(
    channel: string,
    channelKey: string,
    repoPath: string,
    title: string,
    model?: string | null
  ): Promise<Session> {
    // Check session limit
    const count = this.sessions.count();
    if (count >= this.maxSessions) {
      throw new SessionLimitError(this.maxSessions);
    }

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const effectiveModel = model || this.getDefaultModel();

    const session: Session = {
      id: sessionId,
      channel,
      channelKey,
      repoPath: repoPath || '',
      repoName: basename(repoPath || 'no-repo'),
      title: title || basename(repoPath || 'Session'),
      status: 'open',
      activity: 'idle',
      mode: DEFAULT_SESSION_MODE,
      model: effectiveModel,
      sdkAgentId: null,
      lastCommand: null,
      lastFile: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      errorMessage: null,
      outputPreview: '',
    };

    this.sessions.insert(session);
    this.managedSessions.set(sessionId, session);

    logger.info(
      { sessionId, channel, channelKey, repoPath: repoPath || process.cwd(), model: effectiveModel },
      'Session created'
    );

    // Add creator as participant
    this.participants.ensure({
      sessionId,
      channel,
      conversationId: channelKey,
      joinedAt: now,
    });

    // Create agent session
    try {
      session.activity = 'connecting';
      const agentSession = await this.agentService.createSession(
        sessionId,
        repoPath || process.cwd(),
        effectiveModel
      );
      session.sdkAgentId = agentSession.sdkAgentId;
      this.sessions.updateSdkAgentId(sessionId, agentSession.sdkAgentId);
      session.activity = 'idle';
    } catch (err) {
      session.activity = 'error';
      session.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId }, 'Failed to create agent session');
    }

    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    return session;
  }

  async sendSessionMessage(
    sessionId: string,
    text: string,
    participantChannel?: string,
    participantConversationId?: string,
    options?: { images?: Array<{ data: string; mimeType: string } | { url: string }> }
  ): Promise<Session> {
    return this.withSessionLock(sessionId, async () => {
      let session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      // Ensure participant
      if (participantChannel && participantConversationId) {
        this.participants.ensure({
          sessionId,
          channel: participantChannel,
          conversationId: participantConversationId,
          joinedAt: new Date().toISOString(),
        });
      }

      // Reopen if closed
      if (session.status === 'closed') {
        session.status = 'open';
        session.closedAt = null;
        session.errorMessage = null;
        this.sessions.updateStatus(sessionId, 'open');
      }

      session = await this.ensureAgentReady(session);

      // Store user message
      this.messages.insert(sessionId, 'user', text);
      session.lastCommand = summarizeUserCommand(text);
      this.sessions.updateLastActivity(sessionId, { lastCommand: session.lastCommand });
      this.sessions.touch(sessionId);

      logger.info(
        { sessionId, channel: participantChannel, textLength: text.length, mode: session.mode },
        'Sending user message to agent'
      );

      // Send to agent
      session.activity = 'running';
      session.outputPreview = '';

      await this.eventBus.emit({
        type: 'session_updated',
        session: this.toPublicSession(session),
      });

      try {
        const mode = parseSessionMode(session.mode);
        const snapshot = !modeAllowsWrites(mode) && session.repoPath
          ? await listDirtyFiles(session.repoPath)
          : null;
        const promptText =
          extraRulesPromptPrefix(this.extraRules.get(sessionId)) +
          promptWithSessionMode(mode, text);
        const result = await this.agentService.sendPrompt(
          sessionId,
          options?.images?.length
            ? { text: promptText, images: options.images }
            : promptText
        );

        if (result.success) {
          const streamed = session.outputPreview.trim();
          const resultText = result.text.trim();
          let summary = streamed || resultText;

          if (mode === 'plan' && summary) {
            this.lastPlans.set(sessionId, summary);
          }

          if (snapshot?.ok && session.repoPath && !modeAllowsWrites(mode)) {
            const after = await listDirtyFiles(session.repoPath);
            if (after.ok) {
              const reverted = await revertNewWrites(
                session.repoPath,
                writesToRevert(snapshot, after)
              );
              if (reverted.length > 0) {
                const notice = formatWritesReverted(reverted);
                summary = summary ? `${summary}\n\n${notice}` : notice;
              }
            }
          }

          if (summary) {
            this.messages.insert(sessionId, 'assistant', summary.slice(0, 20000));
          }
          session.errorMessage = null;

          // Non-web channels do not receive agent_stream — deliver the full reply here.
          if (summary) {
            await this.deliverToParticipants(sessionId, summary);
          }
        } else if (isCancelledRunError(result.error)) {
          session.errorMessage = result.error ?? 'cancelled';
          session.activity = 'idle';
        } else {
          session.errorMessage = result.error ?? null;
          session.activity = 'error';
          logger.warn({ sessionId, error: result.error }, 'Agent returned error');
          if (result.error) {
            await this.deliverToParticipants(sessionId, `Agent error: ${result.error}`);
          }
        }
      } catch (err) {
        session.errorMessage = err instanceof Error ? err.message : String(err);
        session.activity = 'error';
        logger.error({ err, sessionId }, 'sendSessionMessage failed');
        await this.deliverToParticipants(
          sessionId,
          `Agent error: ${session.errorMessage}`
        );
      } finally {
        if (session.activity === 'running') {
          session.activity = 'idle';
        }
      }

      this.sessions.touch(sessionId);
      await this.eventBus.emit({
        type: 'session_updated',
        session: this.toPublicSession(session),
      });

      return session;
    });
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.sessionLocks.set(sessionId, current);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  async submitIncoming(message: IncomingMessage): Promise<Session | null> {
    // Find or create session
    let session = this.sessions.findOpenByChannel(
      message.channel,
      message.conversationId,
      message.repoPath || ''
    );

    if (!session) {
      try {
        session = await this.createSession(
          message.channel,
          message.conversationId,
          message.repoPath || '',
          '',
          null
        );
      } catch (err) {
        if (err instanceof SessionLimitError) {
          return null;
        }
        throw err;
      }
    }

    await this.sendSessionMessage(
      session.id,
      message.text,
      message.channel,
      message.conversationId
    );

    return session;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
    if (!session) {
      return false;
    }

    // Close agent session
    await this.agentService.closeSession(sessionId);

    // Notify participants
    const participants = this.participants.listBySession(sessionId);
    for (const p of participants) {
      await this.eventBus.emit({
        type: 'channel_message',
        channel: p.channel,
        conversation_id: p.conversationId,
        text: 'Session closed. The agent process was stopped.',
      });
    }

    // Delete from DB
    this.messages.deleteBySession(sessionId);
    this.participants.deleteBySession(sessionId);
    this.sessions.delete(sessionId);
    this.managedSessions.delete(sessionId);
    this.extraRules.delete(sessionId);
    this.lastPlans.delete(sessionId);

    await this.eventBus.emit({
      type: 'session_removed',
      session_id: sessionId,
    });

    return true;
  }

  async closeAllSessions(): Promise<number> {
    const sessions = this.sessions.listAll(true, 1000);

    // Close all agent sessions
    await this.agentService.closeAllSessions();

    // Delete all from DB
    for (const session of sessions) {
      this.messages.deleteBySession(session.id);
      this.participants.deleteBySession(session.id);
      this.sessions.delete(session.id);
    }

    this.managedSessions.clear();
    this.extraRules.clear();
    this.lastPlans.clear();

    await this.eventBus.emit({
      type: 'sessions_purged',
    });

    return sessions.length;
  }

  async joinSession(sessionId: string, channel: string, conversationId: string): Promise<Session | null> {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      return null;
    }

    this.participants.ensure({
      sessionId,
      channel,
      conversationId,
      joinedAt: new Date().toISOString(),
    });

    const ready = await this.ensureAgentReady(session);
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(ready),
    });

    return ready;
  }

  listSessions(channel: string, channelKey: string, includeClosed = false): Session[] {
    return this.sessions.listByChannel(channel, channelKey, includeClosed);
  }

  listAllSessions(includeClosed = false): Session[] {
    return this.sessions.listAll(includeClosed);
  }

  getSession(sessionId: string): Session | undefined {
    const managed = this.managedSessions.get(sessionId);
    if (managed) return managed;
    return this.sessions.findById(sessionId);
  }

  getSessionMessages(sessionId: string): ReturnType<MessageRepository['listBySession']> {
    return this.messages.listBySession(sessionId);
  }

  countSessionMessages(sessionId: string): number {
    return this.messages.countBySession(sessionId);
  }

  getDefaultModel(): string {
    return this.settings.get('default_model') || this.defaultModel;
  }

  setDefaultModel(model: string | null): void {
    if (model) {
      this.settings.set('default_model', model);
    } else {
      this.settings.delete('default_model');
    }
  }

  setExtraRules(sessionId: string, text: string | null): string {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) {
      this.extraRules.delete(sessionId);
      return '';
    }
    this.extraRules.set(sessionId, trimmed);
    return trimmed;
  }

  getExtraRules(sessionId: string): string {
    return this.extraRules.get(sessionId) ?? '';
  }

  getLastPlan(sessionId: string): string | undefined {
    return this.lastPlans.get(sessionId);
  }

  clearLastPlan(sessionId: string): void {
    this.lastPlans.delete(sessionId);
  }

  setSessionMode(sessionId: string, mode: SessionMode): Session | undefined {
    const session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
    if (!session) {
      return undefined;
    }

    session.mode = mode;
    this.sessions.updateMode(sessionId, mode);
    this.managedSessions.set(sessionId, { ...session, mode });
    void this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });
    return session;
  }

  recordLastFile(sessionId: string, lastFile: string | null): void {
    const session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
    if (!session) {
      return;
    }
    session.lastFile = lastFile;
    this.sessions.updateLastActivity(sessionId, { lastFile });
    this.managedSessions.set(sessionId, session);
  }

  getTouchedFiles(sessionId: string): string[] {
    return this.agentService.getTouchedFiles(sessionId);
  }

  getAgentService(): AgentService {
    return this.agentService;
  }

  private toPublicSession(session: Session): Record<string, unknown> {
    return {
      id: session.id,
      channel: session.channel,
      channel_key: session.channelKey,
      repo_path: session.repoPath,
      repo_name: session.repoName,
      title: session.title,
      status: session.status,
      activity: session.activity,
      mode: session.mode,
      model: session.model,
      last_command: session.lastCommand,
      last_file: session.lastFile,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      closed_at: session.closedAt,
      error_message: session.errorMessage,
      output_preview: session.outputPreview,
    };
  }
}
