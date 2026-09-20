/**
 * Telegram Bot Channel using Telegraf
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { Channel } from './base.js';
import type { MessageTarget, AppConfig, Session, SessionMode } from '../models/types.js';
import { EventBus } from '../core/events.js';
import { SessionLimitError, type SessionManager } from '../core/session-manager.js';
import { listLocalWorkspaceItems } from '../core/repo-picker.js';
import { splitPlainText, markdownToTelegram, markdownToTelegramHtml } from '../format/telegram-format.js';
import { createHash } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { logger } from '../util/logger.js';
import { getVersion } from '../cli/help.js';
import {
  TELEGRAM_HANDLER_TIMEOUT_MS,
  wrapTelegramHandler,
  formatTelegramError,
  replySafe,
} from './telegram-resilience.js';
import { getUiTunnel } from '../service/ui-tunnel.js';
import { resolveUiToken, withUiToken } from '../service/ui-auth.js';
import { sendWakeOnLan } from '../service/wol.js';
import { listTelegramBotCommands, telegramStartHelp } from './telegram-commands.js';
import {
  APPLY_PLAN_PROMPT,
  QUESTION_CANCELLED,
  formatAgentQuestion,
  formatQuestionCancelled,
  formatQuestionTimedOut,
  questionTimeoutMs,
  timeoutFallbackAnswer,
} from '../core/agent-question.js';
import { formatRulesUsage, summarizeWorkspaceRules } from '../core/workspace-rules.js';
import { collectMachineStatus, formatMachineReport } from '../core/machine-status.js';
import { heartbeatAgeMs, readHeartbeat } from '../core/heartbeat.js';
import { modeAllowsWrites } from '../core/session-mode.js';
import {
  formatAgentBusy,
  formatBranchList,
  formatCloseAllWarning,
  formatCloseWarning,
  formatCommitConfirm,
  formatCurrentSession,
  formatDangerousGitBlocked,
  formatFileKept,
  formatLogUsage,
  formatApplyPlanPrompt,
  formatModeChanged,
  formatUiStarted,
  formatWritesBlocked,
  formatNoActiveSession,
  formatNoNpmScript,
  formatNothingToCommit,
  formatNothingToUndo,
  formatOpenUsage,
  formatPrConfirm,
  formatPushConfirm,
  formatReviewExpired,
  formatRunStopFailed,
  formatRunStopped,
  formatSearchUsage,
  formatSessionCreatedNotice,
  formatShotUsage,
  formatUndoCancelled,
  formatUndoConfirm,
  formatHeardVoice,
  formatAttachedFiles,
  formatMissingFileRefs,
  formatSessionsList,
  formatNearSessionLimit,
  formatSessionLimitReached,
} from '../core/session-copy.js';
import { formatRunProgress } from '../core/run-progress.js';
import { isCancelledRunError } from '../util/agent-errors.js';
import {
  runWorkspaceCommand,
  telegramPayloadForCommand,
  validateWorkspaceCwd,
  type TelegramCommandPayload,
} from '../core/workspace-shell.js';
import {
  MAX_DIFF_FILE_MESSAGES,
  buildWorkspaceDiff,
  fileLabel,
  formatDiffSummary,
  formatFilesList,
  formatSearchResults,
  listDirtyFiles,
  listWorkspaceTree,
  openWorkspaceFile,
  parseGitStatusPorcelain,
  patchPayload,
  restoreWorkspaceFiles,
  revertWorkspaceFile,
  searchWorkspace,
} from '../core/workspace-review.js';
import {
  checkoutGitBranch,
  classifyDangerousGit,
  commitWorkspaceFiles,
  createPullRequest,
  formatGitLog,
  formatGitStatus,
  getGitLog,
  getGitStatus,
  isSafeGitRef,
  listGitBranches,
  parsePushForceFlag,
  pushCurrentBranch,
  suggestCommitMessage,
} from '../core/workspace-git.js';
import {
  capturePageScreenshot,
  detectNpmScript,
  formatLastCommandLog,
  getLastCommandLog,
  lintScriptCandidates,
  parseDevArg,
  parsePreviewArg,
  parseRunCodeArg,
  readPackageScripts,
  runCodeAndPreview,
  runNpmScript,
  startAppPreview,
  startDevServer,
  stopAppPreview,
  stopDevServer,
  stopRunCode,
  testScriptCandidates,
} from '../core/workspace-run.js';
import {
  DEFAULT_FILE_PROMPT,
  DEFAULT_PHOTO_PROMPT,
  DEFAULT_VOICE_PROMPT,
  MAX_ATTACH_TEXT_BYTES,
  encodeImageForAgent,
  expandAtFileRefs,
  formatInboxSaved,
  formatQuotedReply,
  formatTranscribedVoice,
  guessMimeType,
  isAudioMime,
  isImageMime,
  isTextLikeFile,
  quotedTextFromTelegramShape,
  saveInboxFile,
  transcribeAudioFile,
} from '../core/workspace-inbox.js';

const PROGRESS_EDIT_INTERVAL_MS = 2500;
const STOP_CALLBACK = 'run:stop';

function stopRunKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('Stop', STOP_CALLBACK)]]);
}

function telegramCommandArg(ctx: Context<Update>, command: string): string {
  const raw = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`^/${escaped}(?:@\\S+)?\\s*([\\s\\S]*)$`));
  return match?.[1]?.trim() ?? '';
}

function isBusyErrorMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /busy|\/stop/i.test(message);
}

function isTelegramMessageNotModified(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return /message is not modified/i.test(String(err));
  }
  const record = err as {
    message?: string;
    description?: string;
    response?: { description?: string };
  };
  const text = [record.message, record.description, record.response?.description]
    .filter(Boolean)
    .join(' ');
  return /message is not modified/i.test(text);
}

interface PendingQuestion {
  resolve: (answer: string) => void;
  options: string[];
  sessionId: string;
  conversationId: string;
  timeout: ReturnType<typeof setTimeout>;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private bot: Telegraf<Context<Update>>;
  private sessionManager: SessionManager;
  private allowedUserIds: Set<number>;
  private config: AppConfig;

  // Pending questions by callback token
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  // GitHub repo selection pending
  private pendingGitHubRepos: Map<string, string[]> = new Map();
  // Workspace selection pending
  private pendingWorkspaces: Map<string, string[]> = new Map();
  // Model IDs for callbacks
  private modelIds: Map<string, string[]> = new Map();

  // Track active sessions per chat
  private activeSessions: Map<string, string> = new Map();
  private pendingClose: Map<string, 'one' | 'all'> = new Map();
  /** Workspace create waiting for slot confirmation / close-old (Phase 8.4). */
  private pendingWorkspaceCreate = new Map<string, { path: string; name: string }>();
  private pendingReviewFiles: Map<string, string[]> = new Map();
  private pendingUndo: Map<string, string[]> = new Map();
  private pendingCommit = new Map<string, { message: string; files: string[] }>();
  private pendingPush = new Map<string, { force: boolean }>();
  private pendingPr = new Map<string, { title: string }>();
  private pendingBranches = new Map<string, string[]>();
  private progressWatches = new Map<string, { chatId: string; messageId: number }>();
  private unsubscribeProgress?: () => void;
  /** Session ids with a Telegram send already in flight (covers the gap before activity=running). */
  private inflightSessionMessages = new Set<string>();

  constructor(
    token: string,
    sessionManager: SessionManager,
    allowedUserIds: Set<number>,
    config: AppConfig,
    eventBus?: EventBus
  ) {
    this.bot = new Telegraf(token, { handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS });
    this.sessionManager = sessionManager;
    this.allowedUserIds = allowedUserIds;
    this.config = config;

    this.unsubscribeProgress = eventBus?.on('agent_progress', (event) => {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
      const watch = this.progressWatches.get(sessionId);
      if (watch) {
        void this.editProgressMessage(watch.chatId, watch.messageId, sessionId);
      }
    });

    this.setupHandlers();
    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    // Allowlist middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUserIds.has(userId)) {
        logger.warn(
          { userId, username: ctx.from?.username, updateType: ctx.updateType },
          'Telegram access denied'
        );
        return;
      }
      return next();
    });
  }

  private botCommands(): Array<{ command: string; description: string }> {
    return listTelegramBotCommands();
  }

  /** Register slash commands for allowed users (Telegram autocomplete menu). */
  private async syncBotCommands(): Promise<void> {
    try {
      await this.bot.telegram.deleteMyCommands();
    } catch (err) {
      logger.warn({ err }, 'Could not clear default Telegram command list');
    }

    if (this.allowedUserIds.size === 0) {
      logger.warn(
        'Telegram is enabled but TELEGRAM_ALLOWED_USER_IDS is empty — slash commands will not appear'
      );
      return;
    }

    for (const userId of this.allowedUserIds) {
      await this.syncBotCommandsForUser(userId);
    }
  }

  private async syncBotCommandsForUser(userId: number): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(this.botCommands(), {
        scope: { type: 'chat', chat_id: userId },
      });
      logger.info({ userId }, 'Telegram slash commands registered');
    } catch (err) {
      logger.warn(
        { err, userId },
        'Could not set Telegram commands for user (send /start to the bot first)'
      );
    }
  }

  private setupHandlers(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) {
        await this.syncBotCommandsForUser(userId);
      }

      await ctx.reply(telegramStartHelp(), { parse_mode: 'Markdown' });
    });

    // Version
    this.bot.command('version', async (ctx) => {
      await ctx.reply(`Cursor Control Plane v${getVersion()}`);
    });

    // Sessions list
    this.bot.command('sessions', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const sessions = this.sessionManager.listAllSessions(false);
      const currentId = this.activeSessions.get(chatId) ?? null;

      if (sessions.length === 0) {
        await ctx.reply(formatSessionsList({ sessions: [], currentId }));
        return;
      }

      const enriched = sessions.map((s) => ({
        session: s,
        messageCount: this.sessionManager.countSessionMessages(s.id),
      }));

      const buttons = sessions.map((s) => {
        const mark = s.id === currentId ? '★ ' : '';
        const status = s.activity === 'running' ? '🟡' : s.status === 'open' ? '🟢' : '⚫';
        const model = s.model ? ` [${s.model}]` : '';
        const label = `${mark}${status} ${s.title || s.repoName}${model}`.slice(0, 60);
        return [Markup.button.callback(label, `session:${s.id}`)];
      });

      await ctx.reply(
        formatSessionsList({ sessions: enriched, currentId }),
        Markup.inlineKeyboard(buttons)
      );
    });

    // Models list
    this.bot.command('models', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const models = await this.sessionManager.getAgentService().listAvailableModels();

      if (models.length === 0) {
        await ctx.reply('No models available.');
        return;
      }

      const buttons = models.map((m, i) => {
        return [Markup.button.callback(m.name, `model:${i}`)];
      });

      this.modelIds.set(
        chatId,
        models.map((m) => m.id)
      );

      await ctx.reply(
        'Available models — tap to set as default:\n' +
        `(Current: ${this.sessionManager.getDefaultModel() || 'Auto'})`,
        Markup.inlineKeyboard(buttons)
      );
    });

    // Current session
    this.bot.command('current', async (ctx) => {
      const session = this.getCurrentSession(String(ctx.chat?.id));
      if (!session) {
        await ctx.reply('No active session. Use /sessions to connect to one.');
        return;
      }

      let branch: string | null = null;
      if (session.repoPath) {
        const git = await runWorkspaceCommand({
          cwd: session.repoPath,
          command: 'git',
          args: ['rev-parse', '--abbrev-ref', 'HEAD'],
          timeoutMs: 5_000,
          maxOutputChars: 200,
        });
        if (git.ok) {
          branch = git.combined.trim();
        }
      }

      await ctx.reply(formatCurrentSession(session, { branch }));
    });

    this.bot.command('ask', async (ctx) => {
      await this.setCurrentMode(ctx, 'ask');
    });
    this.bot.command('agent', async (ctx) => {
      await this.setCurrentMode(ctx, 'agent');
    });
    this.bot.command('plan', async (ctx) => {
      await this.setCurrentMode(ctx, 'plan');
    });

    this.bot.command('machine', async (ctx) => {
      await this.handleMachine(ctx, telegramCommandArg(ctx, 'machine'));
    });

    this.bot.command('rules', async (ctx) => {
      await this.handleRules(ctx, telegramCommandArg(ctx, 'rules'));
    });

    this.bot.action('plan:apply', async (ctx) => {
      await this.handleApplyPlan(ctx);
    });
    this.bot.action('plan:keep', async (ctx) => {
      await ctx.answerCbQuery('Kept plan mode');
      await ctx.reply('Still in plan mode. Send /agent when you want writes.');
    });

    this.bot.command('progress', async (ctx) => {
      const session = this.getCurrentSession(String(ctx.chat?.id));
      if (!session) {
        await ctx.reply(formatNoActiveSession());
        return;
      }
      await ctx.reply(formatRunProgress(this.sessionManager.getRunProgress(session.id)));
    });

    this.bot.command('stop', async (ctx) => {
      await ctx.reply(await this.stopCurrentRunForChat(String(ctx.chat?.id)));
    });

    this.bot.action(STOP_CALLBACK, async (ctx) => {
      const text = await this.stopCurrentRunForChat(String(ctx.chat?.id));
      await ctx.answerCbQuery();
      await ctx.reply(text);
    });

    this.bot.command('diff', async (ctx) => {
      await this.handleDiff(ctx);
    });
    this.bot.command('files', async (ctx) => {
      await this.handleFiles(ctx);
    });
    this.bot.command('open', async (ctx) => {
      await this.handleOpen(ctx, telegramCommandArg(ctx, 'open'));
    });
    this.bot.command('search', async (ctx) => {
      await this.handleSearch(ctx, telegramCommandArg(ctx, 'search'));
    });
    this.bot.command('tree', async (ctx) => {
      await this.handleTree(ctx, telegramCommandArg(ctx, 'tree'));
    });
    this.bot.command('undo', async (ctx) => {
      await this.handleUndo(ctx);
    });

    this.bot.action(/^rev:([kr]):(\d+)$/, async (ctx) => {
      await this.handleReviewAction(ctx, ctx.match[1] as 'k' | 'r', Number(ctx.match[2]));
    });
    this.bot.action('undo:yes', async (ctx) => {
      await this.handleUndoConfirm(ctx, true);
    });
    this.bot.action('undo:no', async (ctx) => {
      await this.handleUndoConfirm(ctx, false);
    });

    this.bot.command('status', async (ctx) => {
      await this.handleGitStatus(ctx);
    });
    this.bot.command('log', async (ctx) => {
      await this.handleGitLog(ctx, telegramCommandArg(ctx, 'log'));
    });
    this.bot.command('branch', async (ctx) => {
      await this.handleBranch(ctx, telegramCommandArg(ctx, 'branch'));
    });
    this.bot.command('commit', async (ctx) => {
      await this.handleCommit(ctx, telegramCommandArg(ctx, 'commit'));
    });
    this.bot.command('push', async (ctx) => {
      await this.handlePush(ctx, telegramCommandArg(ctx, 'push'));
    });
    this.bot.command('pr', async (ctx) => {
      await this.handlePr(ctx, telegramCommandArg(ctx, 'pr'));
    });
    this.bot.action(/^br:(\d+)$/, async (ctx) => {
      await this.handleBranchCheckout(ctx, Number(ctx.match[1]));
    });
    this.bot.action('commit:yes', async (ctx) => {
      await this.handleCommitConfirm(ctx, true);
    });
    this.bot.action('commit:no', async (ctx) => {
      await this.handleCommitConfirm(ctx, false);
    });
    this.bot.action('push:yes', async (ctx) => {
      await this.handlePushConfirm(ctx, true);
    });
    this.bot.action('push:no', async (ctx) => {
      await this.handlePushConfirm(ctx, false);
    });
    this.bot.action('pr:yes', async (ctx) => {
      await this.handlePrConfirm(ctx, true);
    });
    this.bot.action('pr:no', async (ctx) => {
      await this.handlePrConfirm(ctx, false);
    });

    this.bot.command('test', async (ctx) => {
      await this.handleVerifyScript(ctx, 'test');
    });
    this.bot.command('lint', async (ctx) => {
      await this.handleVerifyScript(ctx, 'lint');
    });
    this.bot.command('dev', async (ctx) => {
      await this.handleDev(ctx, telegramCommandArg(ctx, 'dev'));
    });
    this.bot.command('preview', async (ctx) => {
      await this.handlePreview(ctx, telegramCommandArg(ctx, 'preview'));
    });
    this.bot.command('runcode', async (ctx) => {
      await this.handleRunCode(ctx, telegramCommandArg(ctx, 'runcode'));
    });
    this.bot.command('shot', async (ctx) => {
      await this.handleShot(ctx, telegramCommandArg(ctx, 'shot'));
    });
    this.bot.command('logs', async (ctx) => {
      await this.handleLogs(ctx);
    });

    // Close current session (confirmation required — deletes history)
    this.bot.command('close', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const session = this.getCurrentSession(chatId);

      if (!session) {
        await ctx.reply('No active session to close.');
        return;
      }

      this.pendingClose.set(chatId, 'one');
      await ctx.reply(
        formatCloseWarning(session),
        Markup.inlineKeyboard([
          [Markup.button.callback('Delete session', 'close:confirm')],
          [Markup.button.callback('Keep it', 'close:cancel')],
        ])
      );
    });

    // Close all sessions (confirmation required)
    this.bot.command('closeall', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const count = this.sessionManager.listAllSessions(false).length;
      if (count === 0) {
        await ctx.reply('No sessions to close.');
        return;
      }

      this.pendingClose.set(chatId, 'all');
      await ctx.reply(
        formatCloseAllWarning(count),
        Markup.inlineKeyboard([
          [Markup.button.callback(`Delete all ${count}`, 'closeall:confirm')],
          [Markup.button.callback('Keep them', 'closeall:cancel')],
        ])
      );
    });

    this.bot.action('close:confirm', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      if (this.pendingClose.get(chatId) !== 'one') {
        await ctx.answerCbQuery('Nothing pending');
        return;
      }
      this.pendingClose.delete(chatId);
      const sessionId = this.activeSessions.get(chatId);
      if (!sessionId) {
        await ctx.answerCbQuery();
        await ctx.reply('No active session to close.');
        return;
      }
      await this.sessionManager.closeSession(sessionId);
      this.activeSessions.delete(chatId);
      await ctx.answerCbQuery('Session deleted');
      await ctx.reply('✅ Session deleted (history removed).');
    });

    this.bot.action('close:cancel', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      this.pendingClose.delete(chatId);
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Kept the session. Use /sessions or /workspaces to switch without deleting.');
    });

    this.bot.action('closeall:confirm', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      if (this.pendingClose.get(chatId) !== 'all') {
        await ctx.answerCbQuery('Nothing pending');
        return;
      }
      this.pendingClose.delete(chatId);
      const count = await this.sessionManager.closeAllSessions();
      this.activeSessions.clear();
      await ctx.answerCbQuery('All sessions deleted');
      await ctx.reply(`✅ Deleted ${count} session(s).`);
    });

    this.bot.action('closeall:cancel', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      this.pendingClose.delete(chatId);
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Kept all sessions.');
    });

    this.bot.action('slot:continue', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const pending = this.pendingWorkspaceCreate.get(chatId);
      if (!pending) {
        await ctx.answerCbQuery('Nothing pending');
        return;
      }
      this.pendingWorkspaceCreate.delete(chatId);
      await ctx.answerCbQuery('Creating…');
      await this.createWorkspaceSessionNow(ctx, chatId, pending.path, pending.name);
    });

    this.bot.action('slot:cancel', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      this.pendingWorkspaceCreate.delete(chatId);
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Cancelled. Existing sessions unchanged.');
    });

    this.bot.action(/slot:close:(.+)/, async (ctx) => {
      const sessionId = ctx.match[1];
      const chatId = String(ctx.chat?.id);
      const pending = this.pendingWorkspaceCreate.get(chatId);
      await ctx.answerCbQuery('Closing…');
      await this.sessionManager.closeSession(sessionId);
      if (this.activeSessions.get(chatId) === sessionId) {
        this.activeSessions.delete(chatId);
      }
      if (!pending) {
        await ctx.reply('✅ Session deleted. Use /workspaces or /repos to create a new one.');
        return;
      }
      this.pendingWorkspaceCreate.delete(chatId);
      await this.createWorkspaceSessionNow(ctx, chatId, pending.path, pending.name);
    });

    // GitHub repos
    this.bot.command('repos', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const { execa } = await import('execa');
        const { stdout } = await execa('gh', ['repo', 'list', '--limit', '20', '--json', 'nameWithOwner']);
        const repos = JSON.parse(stdout) as Array<{ nameWithOwner: string }>;

        if (repos.length === 0) {
          await ctx.reply('No GitHub repos found. Make sure `gh` is installed and authenticated.');
          return;
        }

        const owners = repos.map((r) => r.nameWithOwner);
        this.pendingGitHubRepos.set(chatId, owners);

        const buttons = owners.map((nwo, i) => {
          return [Markup.button.callback(nwo, `gh:${i}`)];
        });

        await ctx.reply('GitHub repos — tap to clone:', Markup.inlineKeyboard(buttons));
      } catch {
        await ctx.reply('Could not list GitHub repos. Is `gh` installed and logged in?');
      }
    });

    // Workspaces (same local folders as the web repo picker)
    this.bot.command('workspaces', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const items = await listLocalWorkspaceItems(this.config);

        if (items.length === 0) {
          await ctx.reply(
            `No workspace folders yet under:\n${this.config.workspaceRoot}\n\n` +
            'Clone a repo with /repos or add folders there.'
          );
          return;
        }

        const paths = items.map((item) => item.path);
        this.pendingWorkspaces.set(chatId, paths);

        const buttons = items.map((item, i) => {
          const name = item.path.split(/[/\\]/).pop() || item.label.replace(/^local-/, '');
          const label = name.slice(0, 60);
          return [Markup.button.callback(label, `ws:${i}`)];
        });

        await ctx.reply(
          `Local workspaces under ${this.config.workspaceRoot} — tap to use:`,
          Markup.inlineKeyboard(buttons)
        );
      } catch (err) {
        logger.error({ err, workspaceRoot: this.config.workspaceRoot }, 'Failed to list workspaces');
        await ctx.reply('Could not list workspaces.');
      }
    });

    this.bot.command('ui', async (ctx) => {
      const raw = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
      const arg = raw.split(/\s+/)[1]?.toLowerCase() ?? '';
      const localUrl = `http://127.0.0.1:${this.config.server.port}`;
      const named = Boolean(this.config.server.tunnelHostname || this.config.server.tunnelToken);
      const tunnel = getUiTunnel(localUrl, {
        namedToken: this.config.server.tunnelToken,
        namedHostname: this.config.server.tunnelHostname,
      });

      if (arg === 'stop') {
        tunnel.stop();
        await ctx.reply('Dashboard tunnel stopped. Local UI is still at ' + localUrl);
        return;
      }

      await ctx.reply('Opening dashboard tunnel…');
      try {
        const url = await tunnel.start();
        const token = resolveUiToken(this.config.server.uiToken);
        this.config.server.uiToken = token;
        await ctx.reply(formatUiStarted(withUiToken(url, token), named));
      } catch (err) {
        await ctx.reply(
          `Could not start tunnel: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // Handle session selection callback
    this.bot.action(/session:(.+)/, async (ctx) => {
      const sessionId = ctx.match[1];
      const chatId = String(ctx.chat?.id);

      await this.sessionManager.joinSession(sessionId, 'telegram', chatId);
      this.activeSessions.set(chatId, sessionId);

      await ctx.answerCbQuery('Connected to session');
      await ctx.reply('✅ Connected to session. You can now send messages.');
    });

    // Handle model selection callback
    this.bot.action(/model:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const _chatId = String(ctx.chat?.id);
      const models = this.modelIds.get(_chatId);

      if (models) {
        const model = models[index];
        if (model) {
          this.sessionManager.setDefaultModel(model);
          await ctx.answerCbQuery(`Default model set to ${model}`);
          await ctx.reply(`✅ Default model set to: ${model}`);
        }
      }
    });

    // Handle GitHub repo selection
    this.bot.action(/gh:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const repos = this.pendingGitHubRepos.get(chatId);

      if (!repos || !repos[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const nwo = repos[index];
      await ctx.answerCbQuery(`Cloning ${nwo}...`);

      try {
        const { execa } = await import('execa');
        const { mkdir } = await import('fs/promises');
        const { resolve } = await import('path');

        const workspaceRoot = this.config.workspaceRoot;
        await mkdir(workspaceRoot, { recursive: true });

        const repoName = nwo.split('/')[1];
        const targetPath = resolve(workspaceRoot, repoName);

        // Check if already exists
        const { existsSync } = await import('fs');
        if (existsSync(targetPath)) {
          await ctx.reply(`📁 ${repoName} already exists. Using existing.`);
        } else {
          await execa('gh', ['repo', 'clone', nwo], { cwd: workspaceRoot });
          await ctx.reply(`✅ Cloned ${nwo}`);
        }

        await this.announceNewWorkspaceSession(ctx, chatId, targetPath, repoName);
      } catch (err) {
        await ctx.reply(`❌ Failed to clone: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle workspace selection
    this.bot.action(/ws:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const paths = this.pendingWorkspaces.get(chatId);

      if (!paths || !paths[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const path = paths[index];
      const name = path.split(/[/\\]/).pop() || 'workspace';

      await ctx.answerCbQuery(`Using workspace: ${name}`);

      try {
        await this.announceNewWorkspaceSession(ctx, chatId, path, name);
      } catch (err) {
        await ctx.reply(`❌ ${formatTelegramError(err)}`);
      }
    });

    // Ack quickly; run agent work in background so Telegraf handlerTimeout is not hit.
    this.bot.on(
      'text',
      wrapTelegramHandler('text', async (ctx) => {
        const message = ctx.message;
        if (!message || !('text' in message) || typeof message.text !== 'string') {
          return;
        }
        const text = message.text;
        if (text.startsWith('/')) return;
        logger.info({ chatId: String(ctx.chat?.id), textLength: text.length }, 'Telegram text message received');
        await this.beginUserTurn(ctx, text);
      })
    );

    this.bot.on(
      'photo',
      wrapTelegramHandler('photo', async (ctx) => {
        await this.handlePhotoMessage(ctx);
      })
    );
    this.bot.on(
      'document',
      wrapTelegramHandler('document', async (ctx) => {
        await this.handleDocumentMessage(ctx);
      })
    );
    this.bot.on(
      'voice',
      wrapTelegramHandler('voice', async (ctx) => {
        await this.handleVoiceMessage(ctx);
      })
    );
    this.bot.on(
      'audio',
      wrapTelegramHandler('audio', async (ctx) => {
        await this.handleAudioMessage(ctx);
      })
    );
  }

  private async resolveOrCreateSession(
    chatId: string,
    ctx: Context<Update>
  ): Promise<string | null> {
    let sessionId = this.activeSessions.get(chatId);

    if (!sessionId) {
      const sessions = this.sessionManager.listAllSessions(false);
      const existing = sessions.find((s) => s.channel === 'telegram' && s.channelKey === chatId);

      if (existing) {
        sessionId = existing.id;
        this.activeSessions.set(chatId, sessionId);
        logger.info({ chatId, sessionId }, 'Reconnected to existing Telegram session');
      } else {
        const open = this.sessionManager.listAllSessions(false);
        const max = this.config.sdk.maxSessions;
        if (open.length >= max) {
          await ctx.reply(
            formatSessionLimitReached(open.length, max),
            Markup.inlineKeyboard(this.sessionCloseButtons(open))
          );
          return null;
        }
        try {
          const session = await this.sessionManager.createSession(
            'telegram',
            chatId,
            '',
            'Telegram Session'
          );
          sessionId = session.id;
          this.activeSessions.set(chatId, sessionId);
          logger.info({ chatId, sessionId }, 'Created new Telegram session');
          await ctx.reply('✅ Created new session. Processing your message…');
        } catch (err) {
          if (err instanceof SessionLimitError) {
            const stillOpen = this.sessionManager.listAllSessions(false);
            await ctx.reply(
              formatSessionLimitReached(stillOpen.length, max),
              Markup.inlineKeyboard(this.sessionCloseButtons(stillOpen))
            );
            return null;
          }
          throw err;
        }
      }
    }

    return sessionId;
  }

  private telegramReplyQuote(ctx: Context<Update>): string {
    const msg = ctx.message;
    if (!msg || !('reply_to_message' in msg) || !msg.reply_to_message) {
      return '';
    }
    return quotedTextFromTelegramShape(
      msg.reply_to_message as {
        text?: string;
        caption?: string;
        photo?: unknown;
        document?: { file_name?: string };
        voice?: unknown;
        audio?: { title?: string; file_name?: string };
      }
    );
  }

  private async downloadTelegramFile(
    fileId: string
  ): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
    try {
      const link = await this.bot.telegram.getFileLink(fileId);
      const res = await fetch(link.toString());
      if (!res.ok) {
        return { ok: false, error: `Could not download Telegram file (${res.status}).` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        return { ok: false, error: 'Downloaded file is empty.' };
      }
      return { ok: true, buf };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async beginUserTurn(
    ctx: Context<Update>,
    rawText: string,
    extras?: {
      images?: Array<{ data: string; mimeType: string }>;
      notices?: string[];
    }
  ): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const sessionId = await this.resolveOrCreateSession(chatId, ctx);
    if (!sessionId) return;
    if (
      this.getCurrentSession(chatId)?.activity === 'running' ||
      this.inflightSessionMessages.has(sessionId)
    ) {
      await ctx.reply(formatAgentBusy(), stopRunKeyboard());
      return;
    }

    let text = formatQuotedReply(this.telegramReplyQuote(ctx), rawText);
    const notices = [...(extras?.notices ?? [])];
    const session = this.sessionManager.getSession(sessionId);
    const repoPath = session?.repoPath || '';
    if (repoPath && !validateWorkspaceCwd(repoPath)) {
      const expanded = await expandAtFileRefs(repoPath, text);
      text = expanded.prompt;
      const attached = formatAttachedFiles(expanded.attached);
      if (attached) notices.push(attached);
      const missing = formatMissingFileRefs(expanded.missing);
      if (missing) notices.push(missing);
    }

    for (const notice of notices) {
      await ctx.reply(notice);
    }

    await ctx.sendChatAction('typing');
    const status = await ctx.reply('⏳ Processing…', stopRunKeyboard());
    void this.processSessionMessage(
      sessionId,
      text,
      chatId,
      status.message_id,
      extras?.images
    );
  }

  private async handlePhotoMessage(ctx: Context<Update>): Promise<void> {
    const message = ctx.message;
    if (!message || !('photo' in message) || !message.photo?.length) {
      return;
    }

    const best = message.photo[message.photo.length - 1];
    if (!best?.file_id) {
      await ctx.reply('Could not read that photo.');
      return;
    }

    await ctx.sendChatAction('upload_photo');
    const downloaded = await this.downloadTelegramFile(best.file_id);
    if (!downloaded.ok) {
      await ctx.reply(downloaded.error);
      return;
    }

    const encoded = encodeImageForAgent(downloaded.buf, 'image/jpeg');
    if (!encoded.ok) {
      await ctx.reply(encoded.error);
      return;
    }

    const caption =
      'caption' in message && typeof message.caption === 'string' && message.caption.trim()
        ? message.caption.trim()
        : DEFAULT_PHOTO_PROMPT;
    await this.beginUserTurn(ctx, caption, {
      images: [{ data: encoded.data, mimeType: encoded.mimeType }],
    });
  }

  private async handleDocumentMessage(ctx: Context<Update>): Promise<void> {
    const message = ctx.message;
    if (!message || !('document' in message) || !message.document) {
      return;
    }

    const doc = message.document;
    const filename = doc.file_name?.trim() || 'upload.bin';
    const mime = guessMimeType(filename, doc.mime_type || undefined);
    const caption =
      'caption' in message && typeof message.caption === 'string' && message.caption.trim()
        ? message.caption.trim()
        : isImageMime(mime)
          ? DEFAULT_PHOTO_PROMPT
          : DEFAULT_FILE_PROMPT;

    await ctx.sendChatAction('upload_document');
    const downloaded = await this.downloadTelegramFile(doc.file_id);
    if (!downloaded.ok) {
      await ctx.reply(downloaded.error);
      return;
    }

    if (isImageMime(mime)) {
      const encoded = encodeImageForAgent(downloaded.buf, mime);
      if (!encoded.ok) {
        await ctx.reply(encoded.error);
        return;
      }
      await this.beginUserTurn(ctx, caption, {
        images: [{ data: encoded.data, mimeType: encoded.mimeType }],
      });
      return;
    }

    if (isAudioMime(mime)) {
      await this.dispatchAudioBuffer(ctx, downloaded.buf, filename, caption);
      return;
    }

    const chatId = String(ctx.chat?.id);
    const sessionId = await this.resolveOrCreateSession(chatId, ctx);
    if (!sessionId) return;
    const session = this.sessionManager.getSession(sessionId);
    const repoPath = session?.repoPath || '';
    const canSave = repoPath && !validateWorkspaceCwd(repoPath);
    const notices: string[] = [];
    let prompt = caption;

    if (isTextLikeFile(filename, mime) && downloaded.buf.length <= MAX_ATTACH_TEXT_BYTES && !downloaded.buf.includes(0)) {
      prompt = `${caption}\n\n<file path="${filename}">\n${downloaded.buf.toString('utf8')}\n</file>`;
      if (canSave) {
        const saved = await saveInboxFile(repoPath, filename, downloaded.buf);
        if (saved.ok) notices.push(formatInboxSaved(saved.relative));
      }
    } else if (canSave) {
      const saved = await saveInboxFile(repoPath, filename, downloaded.buf);
      if (!saved.ok) {
        await ctx.reply(saved.error);
        return;
      }
      notices.push(formatInboxSaved(saved.relative));
      prompt = `${caption}\n\nThe user uploaded a file saved at ${saved.relative}. Use it.`;
    } else {
      await ctx.reply(
        'Pick a workspace with /workspaces or /repos so I can save this file, or send a text/code file.'
      );
      return;
    }

    await this.beginUserTurn(ctx, prompt, { notices });
  }

  private async handleVoiceMessage(ctx: Context<Update>): Promise<void> {
    const message = ctx.message;
    if (!message || !('voice' in message) || !message.voice) {
      return;
    }
    const downloaded = await this.downloadTelegramFile(message.voice.file_id);
    if (!downloaded.ok) {
      await ctx.reply(downloaded.error);
      return;
    }
    await this.dispatchAudioBuffer(ctx, downloaded.buf, 'voice.ogg', DEFAULT_VOICE_PROMPT);
  }

  private async handleAudioMessage(ctx: Context<Update>): Promise<void> {
    const message = ctx.message;
    if (!message || !('audio' in message) || !message.audio) {
      return;
    }
    const filename = message.audio.file_name?.trim() || 'audio.mp3';
    const downloaded = await this.downloadTelegramFile(message.audio.file_id);
    if (!downloaded.ok) {
      await ctx.reply(downloaded.error);
      return;
    }
    const caption =
      'caption' in message && typeof message.caption === 'string' && message.caption.trim()
        ? message.caption.trim()
        : DEFAULT_VOICE_PROMPT;
    await this.dispatchAudioBuffer(ctx, downloaded.buf, filename, caption);
  }

  private async dispatchAudioBuffer(
    ctx: Context<Update>,
    buf: Buffer,
    filename: string,
    fallbackPrompt: string
  ): Promise<void> {
    await ctx.reply('Transcribing voice…');
    const chatId = String(ctx.chat?.id);
    const sessionId = await this.resolveOrCreateSession(chatId, ctx);
    if (!sessionId) return;
    const session = this.sessionManager.getSession(sessionId);
    const repoPath = session?.repoPath || '';
    const canSave = Boolean(repoPath && !validateWorkspaceCwd(repoPath));

    let audioPath: string | undefined;
    let relative: string | undefined;
    if (canSave) {
      const saved = await saveInboxFile(repoPath, filename, buf);
      if (!saved.ok) {
        await ctx.reply(saved.error);
        return;
      }
      audioPath = saved.absolute;
      relative = saved.relative;
    } else {
      const dir = await mkdtemp(join(tmpdir(), 'cursor-cp-voice-'));
      const ext = extname(filename).toLowerCase();
      const safeExt = ['.ogg', '.mp3', '.wav', '.m4a', '.webm'].includes(ext) ? ext : '.ogg';
      audioPath = join(dir, `voice${safeExt}`);
      await writeFile(audioPath, buf);
    }

    const transcribed = await transcribeAudioFile(audioPath);
    if (transcribed.ok && transcribed.text.trim()) {
      await this.beginUserTurn(ctx, formatTranscribedVoice(transcribed.text), {
        notices: [formatHeardVoice(transcribed.text)],
      });
      return;
    }

    const savedNote = relative
      ? `Saved to ${relative}.`
      : 'Voice note downloaded.';
    const agentPrompt = relative
      ? `${fallbackPrompt}\n\nThe user sent a voice message saved at ${relative}. Transcribe it and follow the instructions.\n\n${transcribed.error || ''}`
      : `${fallbackPrompt}\n\nThe user sent a voice message. Could not transcribe locally: ${transcribed.error || 'unknown error'}`;
    await this.beginUserTurn(ctx, agentPrompt.trim(), {
      notices: [`${transcribed.error || 'Could not transcribe.'} ${savedNote}`.trim()],
    });
  }

  private async processSessionMessage(
    sessionId: string,
    text: string,
    chatId: string,
    progressMessageId?: number,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    this.inflightSessionMessages.add(sessionId);
    const stopEdits =
      progressMessageId !== undefined
        ? this.startProgressEdits(chatId, progressMessageId, sessionId)
        : () => {};

    try {
      const session = await this.sessionManager.sendSessionMessage(
        sessionId,
        text,
        'telegram',
        chatId,
        images?.length ? { images } : undefined
      );
      logger.info({ chatId, sessionId }, 'Telegram message dispatched to agent');

      if (isBusyErrorMessage(session.errorMessage)) {
        await this.bot.telegram.sendMessage(chatId, formatAgentBusy(), stopRunKeyboard());
      } else if (
        session.mode === 'plan' &&
        !session.errorMessage &&
        this.sessionManager.getLastPlan(sessionId)
      ) {
        await this.bot.telegram.sendMessage(
          chatId,
          formatApplyPlanPrompt(),
          Markup.inlineKeyboard([
            [Markup.button.callback('Apply plan', 'plan:apply')],
            [Markup.button.callback('Keep planning', 'plan:keep')],
          ])
        );
      }
    } catch (err) {
      logger.error({ err, chatId, sessionId }, 'Telegram session message failed');
      await this.sendMessage(chatId, `❌ ${formatTelegramError(err)}`);
    } finally {
      this.inflightSessionMessages.delete(sessionId);
      stopEdits();
      if (progressMessageId !== undefined) {
        const session = this.sessionManager.getSession(sessionId);
        const err = session?.errorMessage;
        const finalText = isBusyErrorMessage(err)
          ? formatAgentBusy()
          : isCancelledRunError(err)
            ? formatRunStopped()
            : err
              ? `❌ ${err}`
              : '✅ Done';
        try {
          await this.bot.telegram.editMessageText(
            chatId,
            progressMessageId,
            undefined,
            finalText,
            Markup.inlineKeyboard([])
          );
        } catch (editErr) {
          if (!isTelegramMessageNotModified(editErr)) {
            logger.debug({ err: editErr, chatId, progressMessageId }, 'Could not finalize progress message');
          }
        }
      }
    }
  }

  private startProgressEdits(chatId: string, messageId: number, sessionId: string): () => void {
    this.progressWatches.set(sessionId, { chatId, messageId });
    void this.editProgressMessage(chatId, messageId, sessionId);
    const timer = setInterval(() => {
      void this.editProgressMessage(chatId, messageId, sessionId);
    }, PROGRESS_EDIT_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      this.progressWatches.delete(sessionId);
    };
  }

  private async editProgressMessage(
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const text = formatRunProgress(this.sessionManager.getRunProgress(sessionId));
    try {
      await this.bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        stopRunKeyboard()
      );
    } catch (err) {
      if (isTelegramMessageNotModified(err)) return;
      logger.debug({ err, chatId, messageId }, 'Could not edit Telegram progress message');
    }
  }

  private async stopCurrentRunForChat(chatId: string): Promise<string> {
    const session = this.getCurrentSession(chatId);
    if (!session) {
      return formatNoActiveSession();
    }

    const result = await this.sessionManager.stopCurrentRun(session.id);
    return result.stopped ? formatRunStopped() : formatRunStopFailed(result.reason);
  }

  private async requireWriteMode(
    ctx: Context<Update>
  ): Promise<{ chatId: string; session: Session; repoPath: string } | null> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return null;
    if (!modeAllowsWrites(current.session.mode)) {
      await ctx.reply(formatWritesBlocked(current.session.mode));
      return null;
    }
    return current;
  }

  private async requireCurrentWorkspace(
    ctx: Context<Update>
  ): Promise<{ chatId: string; session: Session; repoPath: string } | null> {
    const chatId = String(ctx.chat?.id);
    const session = this.getCurrentSession(chatId);
    if (!session) {
      await ctx.reply(formatNoActiveSession());
      return null;
    }
    const invalid = validateWorkspaceCwd(session.repoPath || '');
    if (invalid) {
      await ctx.reply(invalid);
      return null;
    }
    return { chatId, session, repoPath: session.repoPath };
  }

  private async handleDiff(ctx: Context<Update>): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const review = await buildWorkspaceDiff(current.repoPath);
    if (!review.ok) {
      await ctx.reply(review.error || 'Could not read git diff.');
      return;
    }
    if (review.clean) {
      await ctx.reply(formatDiffSummary([]));
      return;
    }

    this.pendingReviewFiles.set(
      current.chatId,
      review.files.map((file) => file.path)
    );
    await ctx.reply(formatDiffSummary(review.files));

    for (const [index, file] of review.files.slice(0, MAX_DIFF_FILE_MESSAGES).entries()) {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`Keep ${fileLabel(file.path)}`, `rev:k:${index}`),
          Markup.button.callback(`Revert ${fileLabel(file.path)}`, `rev:r:${index}`),
        ],
      ]);
      await this.sendPlainOrDocument(current.chatId, patchPayload(file), keyboard);
    }

    if (review.files.length > MAX_DIFF_FILE_MESSAGES) {
      await ctx.reply(
        `Showing first ${MAX_DIFF_FILE_MESSAGES} files. Use /open <path> or /undo for the rest.`
      );
    }
  }

  private async handleFiles(ctx: Context<Update>): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const touched = this.sessionManager.getTouchedFiles(current.session.id);
    const status = await runWorkspaceCommand({
      cwd: current.repoPath,
      command: 'git',
      args: ['status', '--porcelain'],
      timeoutMs: 10_000,
      maxOutputChars: 20_000,
    });
    const dirty = status.ok || status.exitCode === 0
      ? parseGitStatusPorcelain(status.stdout || status.combined)
      : [];
    await ctx.reply(formatFilesList(touched, dirty));
  }

  private async handleOpen(ctx: Context<Update>, pathArg: string): Promise<void> {
    if (!pathArg) {
      await ctx.reply(formatOpenUsage());
      return;
    }
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const opened = await openWorkspaceFile(current.repoPath, pathArg);
    if (!opened.ok || !opened.payload) {
      await ctx.reply(opened.error || 'Could not open file.');
      return;
    }
    await this.sendPlainOrDocument(current.chatId, opened.payload);
  }

  private async handleSearch(ctx: Context<Update>, query: string): Promise<void> {
    if (!query) {
      await ctx.reply(formatSearchUsage());
      return;
    }
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const result = await searchWorkspace(current.repoPath, query);
    if (!result.ok) {
      await ctx.reply(result.error || 'Search failed.');
      return;
    }
    const text = formatSearchResults(query, result.hits, result.tool || 'rg');
    await this.sendPlainOrDocument(
      current.chatId,
      { text, asDocument: text.length > 3500, filename: 'search.txt', body: text }
    );
  }

  private async handleTree(ctx: Context<Update>, pathArg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const tree = await listWorkspaceTree(current.repoPath, pathArg);
    if (!tree.ok) {
      await ctx.reply(tree.error || 'Could not list tree.');
      return;
    }
    await ctx.reply(tree.text.slice(0, 4096));
  }

  private async handleUndo(ctx: Context<Update>): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const dirty = await listDirtyFiles(current.repoPath);
    if (!dirty.ok) {
      await ctx.reply(dirty.error || 'Could not read git status.');
      return;
    }
    if (dirty.tracked.length === 0) {
      const extra = dirty.untracked.length
        ? `\nUntracked files are still there (${dirty.untracked.slice(0, 8).join(', ')}). Revert them from /diff.`
        : '';
      await ctx.reply(formatNothingToUndo() + extra);
      return;
    }

    this.pendingUndo.set(current.chatId, dirty.tracked);
    await ctx.reply(
      formatUndoConfirm(dirty.tracked),
      Markup.inlineKeyboard([
        [Markup.button.callback('Restore files', 'undo:yes')],
        [Markup.button.callback('Keep changes', 'undo:no')],
      ])
    );
  }

  private async handleReviewAction(
    ctx: Context<Update>,
    action: 'k' | 'r',
    index: number
  ): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const files = this.pendingReviewFiles.get(chatId);
    const path = files?.[index];
    if (!path) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    if (action === 'k') {
      await ctx.answerCbQuery('Kept');
      await ctx.reply(formatFileKept(path));
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const reverted = await revertWorkspaceFile(current.repoPath, path);
    await ctx.answerCbQuery(reverted.ok ? 'Reverted' : 'Failed');
    await ctx.reply(reverted.message);
  }

  private async handleUndoConfirm(ctx: Context<Update>, confirm: boolean): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const files = this.pendingUndo.get(chatId);
    this.pendingUndo.delete(chatId);

    if (!confirm) {
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply(formatUndoCancelled());
      return;
    }
    if (!files?.length) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const restored = await restoreWorkspaceFiles(current.repoPath, files);
    await ctx.answerCbQuery(restored.ok ? 'Restored' : 'Failed');
    await ctx.reply(
      restored.ok
        ? `Restored ${files.length} file(s) to HEAD.`
        : restored.combined || 'Could not restore files.'
    );
  }

  private async handleGitStatus(ctx: Context<Update>): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;
    const status = await getGitStatus(current.repoPath);
    const text = formatGitStatus(status);
    await this.sendPlainOrDocument(current.chatId, {
      text,
      asDocument: text.length > 3500,
      filename: 'status.txt',
      body: text,
    });
  }

  private async handleGitLog(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    let count: number | undefined;
    if (arg) {
      if (!/^\d+$/.test(arg)) {
        await ctx.reply(formatLogUsage());
        return;
      }
      count = Number(arg);
    }

    const log = await getGitLog(current.repoPath, count);
    if (!log.ok) {
      await ctx.reply(log.error || 'Could not read git log.');
      return;
    }
    const text = formatGitLog(log.text, log.count);
    await this.sendPlainOrDocument(current.chatId, {
      text,
      asDocument: text.length > 3500,
      filename: 'git-log.txt',
      body: text,
    });
  }

  private async handleBranch(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    if (arg) {
      if (!isSafeGitRef(arg)) {
        await ctx.reply(`Unsafe git ref: ${arg}`);
        return;
      }
      const danger = classifyDangerousGit(`branch ${arg}`);
      if (danger === 'delete-remote-branch' || danger === 'reset-hard') {
        await ctx.reply(formatDangerousGitBlocked(danger));
        return;
      }
      const switched = await checkoutGitBranch(current.repoPath, arg);
      await ctx.reply(switched.message);
      return;
    }

    const listed = await listGitBranches(current.repoPath);
    if (!listed.ok) {
      await ctx.reply(listed.error || 'Could not list branches.');
      return;
    }

    const others = listed.branches.filter((branch) => branch !== listed.current);
    this.pendingBranches.set(current.chatId, others);
    const buttons = others.slice(0, 12).map((branch, index) => [
      Markup.button.callback(`Checkout ${branch.slice(0, 28)}`, `br:${index}`),
    ]);
    await ctx.reply(
      formatBranchList(listed.current, listed.branches),
      buttons.length ? Markup.inlineKeyboard(buttons) : undefined
    );
  }

  private async handleBranchCheckout(ctx: Context<Update>, index: number): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const name = this.pendingBranches.get(chatId)?.[index];
    if (!name) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const switched = await checkoutGitBranch(current.repoPath, name);
    await ctx.answerCbQuery(switched.ok ? 'Switched' : 'Failed');
    await ctx.reply(switched.message);
  }

  private async handleCommit(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireWriteMode(ctx);
    if (!current) return;

    const dirty = await listDirtyFiles(current.repoPath);
    if (!dirty.ok) {
      await ctx.reply(dirty.error || 'Could not read git status.');
      return;
    }
    const files = [...dirty.tracked, ...dirty.untracked];
    if (files.length === 0) {
      await ctx.reply(formatNothingToCommit());
      return;
    }

    const message = arg.trim() || suggestCommitMessage(files);
    this.pendingCommit.set(current.chatId, { message, files });
    await ctx.reply(
      formatCommitConfirm(message, files),
      Markup.inlineKeyboard([
        [Markup.button.callback('Create commit', 'commit:yes')],
        [Markup.button.callback('Cancel', 'commit:no')],
      ])
    );
  }

  private async handleCommitConfirm(ctx: Context<Update>, confirm: boolean): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const pending = this.pendingCommit.get(chatId);
    this.pendingCommit.delete(chatId);

    if (!confirm) {
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Commit cancelled.');
      return;
    }
    if (!pending) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const committed = await commitWorkspaceFiles(current.repoPath, pending.message, pending.files);
    await ctx.answerCbQuery(committed.ok ? 'Committed' : 'Failed');
    await ctx.reply(committed.message);
  }

  private async handlePush(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireWriteMode(ctx);
    if (!current) return;

    const danger = classifyDangerousGit(`push ${arg}`);
    if (danger === 'reset-hard' || danger === 'delete-remote-branch') {
      await ctx.reply(formatDangerousGitBlocked(danger));
      return;
    }

    const tokens = arg.trim().split(/\s+/).filter(Boolean);
    const force =
      tokens.some((token) => parsePushForceFlag(token) || token === '--force-with-lease') ||
      classifyDangerousGit(`push ${arg}`) === 'force-push';
    const status = await getGitStatus(current.repoPath);
    const branch = status.branch || 'HEAD';
    this.pendingPush.set(current.chatId, { force });
    await ctx.reply(
      formatPushConfirm(branch, force),
      Markup.inlineKeyboard([
        [Markup.button.callback(force ? 'Force-push' : 'Push', 'push:yes')],
        [Markup.button.callback('Cancel', 'push:no')],
      ])
    );
  }

  private async handlePushConfirm(ctx: Context<Update>, confirm: boolean): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const pending = this.pendingPush.get(chatId);
    this.pendingPush.delete(chatId);

    if (!confirm) {
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Push cancelled.');
      return;
    }
    if (!pending) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const pushed = await pushCurrentBranch(current.repoPath, { force: pending.force });
    await ctx.answerCbQuery(pushed.ok ? 'Pushed' : 'Failed');
    await this.sendPlainOrDocument(current.chatId, {
      text: pushed.message,
      asDocument: pushed.message.length > 3500,
      filename: 'push.txt',
      body: pushed.message,
    });
  }

  private async handlePr(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireWriteMode(ctx);
    if (!current) return;

    const status = await getGitStatus(current.repoPath);
    const branch = status.branch || 'HEAD';
    const title = arg.trim() || `Updates from ${branch}`;
    this.pendingPr.set(current.chatId, { title });
    await ctx.reply(
      formatPrConfirm(title, branch),
      Markup.inlineKeyboard([
        [Markup.button.callback('Open PR', 'pr:yes')],
        [Markup.button.callback('Cancel', 'pr:no')],
      ])
    );
  }

  private async handlePrConfirm(ctx: Context<Update>, confirm: boolean): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const pending = this.pendingPr.get(chatId);
    this.pendingPr.delete(chatId);

    if (!confirm) {
      await ctx.answerCbQuery('Cancelled');
      await ctx.reply('Pull request cancelled.');
      return;
    }
    if (!pending) {
      await ctx.answerCbQuery('Expired');
      await ctx.reply(formatReviewExpired());
      return;
    }

    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) {
      await ctx.answerCbQuery();
      return;
    }
    const created = await createPullRequest(current.repoPath, pending.title);
    await ctx.answerCbQuery(created.ok ? 'Opened' : 'Failed');
    await ctx.reply(created.message);
  }

  private async handleVerifyScript(ctx: Context<Update>, kind: 'test' | 'lint'): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const scripts = await readPackageScripts(current.repoPath);
    const candidates = kind === 'test' ? testScriptCandidates() : lintScriptCandidates();
    const script = detectNpmScript(scripts, candidates);
    if (!script) {
      await ctx.reply(formatNoNpmScript(kind));
      return;
    }

    await ctx.reply(`Running npm ${script === 'test' ? 'test' : `run ${script}`}…`);
    const ran = await runNpmScript(current.repoPath, script, current.session.id);
    await this.sendPlainOrDocument(current.chatId, ran.payload);
  }

  private async handleDev(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const parsed = parseDevArg(arg);
    if (parsed.stop) {
      const stopped = await stopDevServer(current.session.id);
      await ctx.reply(stopped.message);
      return;
    }

    const started = await startDevServer(current.repoPath, current.session.id, parsed.script);
    await ctx.reply(started.message);
  }

  private async handlePreview(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const parsed = parsePreviewArg(arg);
    if (parsed.stop) {
      const stopped = await stopAppPreview(current.session.id);
      await ctx.reply(stopped.message);
      return;
    }

    if (arg && parsed.port === undefined && arg !== 'start') {
      await ctx.reply('Usage: /preview [port]\nExample: /preview 5173 · /preview stop');
      return;
    }

    const port = parsed.port ?? 3000;
    await ctx.reply(`Opening app preview on port ${port}…`);
    const preview = await startAppPreview(current.session.id, port);
    await ctx.reply(preview.message);
  }

  private async handleRunCode(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const parsed = parseRunCodeArg(arg);
    if (parsed.stop) {
      const stopped = await stopRunCode(current.session.id);
      await ctx.reply(stopped.message);
      return;
    }

    if (arg && parsed.port === undefined && arg !== 'start') {
      await ctx.reply('Usage: /runcode [port]\nExample: /runcode · /runcode 8000 · /runcode stop');
      return;
    }

    await ctx.reply(
      parsed.port
        ? `Running project and opening Cloudflare on :${parsed.port}…`
        : 'Detecting how to run this project, starting it, then opening Cloudflare…'
    );
    const result = await runCodeAndPreview(current.repoPath, current.session.id, {
      port: parsed.port,
    });
    await ctx.reply(result.message);
  }

  private async handleShot(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    if (!arg) {
      await ctx.reply(formatShotUsage());
      return;
    }

    await ctx.reply('Capturing screenshot…');
    const shot = await capturePageScreenshot(current.session.id, arg);
    if (!shot.ok || !shot.png) {
      await ctx.reply(shot.message);
      return;
    }

    try {
      await this.bot.telegram.sendPhoto(
        current.chatId,
        { source: shot.png, filename: shot.filename || 'shot.png' },
        { caption: shot.message.slice(0, 1024) }
      );
    } catch (err) {
      logger.warn({ err, chatId: current.chatId }, 'Failed to send screenshot');
      await ctx.reply(shot.message);
    }
  }

  private async handleLogs(ctx: Context<Update>): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const log = getLastCommandLog(current.session.id);
    const text = formatLastCommandLog(log);
    await this.sendPlainOrDocument(current.chatId, {
      text,
      asDocument: text.length > 3500,
      filename: 'last-command.log',
      body: text,
    });
  }

  private async sendPlainOrDocument(
    conversationId: string,
    payload: TelegramCommandPayload,
    extra?: ReturnType<typeof Markup.inlineKeyboard>
  ): Promise<void> {
    if (!payload.asDocument) {
      await this.bot.telegram.sendMessage(conversationId, payload.text.slice(0, 4096), extra);
      return;
    }

    try {
      await this.bot.telegram.sendDocument(
        conversationId,
        {
          source: Buffer.from(payload.body, 'utf8'),
          filename: payload.filename,
        },
        { caption: payload.text.slice(0, 1024), ...extra }
      );
    } catch (err) {
      logger.warn({ err, conversationId }, 'Failed to send review document, falling back to text');
      await this.bot.telegram.sendMessage(conversationId, payload.text.slice(0, 4096), extra);
    }
  }

  async start(): Promise<void> {
    this.bot.catch((err, ctx) => {
      logger.error({ err, updateType: ctx?.updateType }, 'Telegraf polling error');
      if (ctx) {
        void replySafe(ctx, `❌ ${formatTelegramError(err)}`);
      }
    });

    await this.bot.launch();
    await this.syncBotCommands();
    logger.info('Telegram bot polling started');
  }

  async stop(): Promise<void> {
    this.unsubscribeProgress?.();
    for (const [token, pending] of this.pendingQuestions) {
      clearTimeout(pending.timeout);
      pending.resolve(QUESTION_CANCELLED);
      this.pendingQuestions.delete(token);
    }
    this.bot.stop();
    logger.info('Telegram bot stopped');
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!text) return;

    logger.debug({ conversationId, textLength: text.length }, 'Sending Telegram message');

    if (text.length <= 4096) {
      await this.sendMarkdownMessage(conversationId, text);
      return;
    }

    for (const chunk of splitPlainText(text, 4096)) {
      await this.sendMarkdownMessage(conversationId, chunk);
    }
  }

  /** Send markdown with HTML formatting (matches web bold/italic); plain text on failure. */
  private async sendMarkdownMessage(conversationId: string, markdown: string): Promise<void> {
    const html = markdownToTelegramHtml(markdown);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, { parse_mode: 'HTML' });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected HTML message, sending plain');
      }
    }

    const plain = markdownToTelegram(markdown);
    try {
      await this.bot.telegram.sendMessage(conversationId, plain.text.slice(0, 4096));
    } catch (err) {
      logger.error({ err, conversationId }, 'Failed to send Telegram message chunk');
      throw err;
    }
  }

  private async sendFormattedWithKeyboard(
    conversationId: string,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>
  ): Promise<void> {
    const html = markdownToTelegramHtml(text);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, {
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected formatted question, sending plain');
      }
    }

    const plain = markdownToTelegram(text);
    await this.bot.telegram.sendMessage(
      conversationId,
      plain.text.slice(0, 4096),
      keyboard
    );
  }

  async askQuestion(
    conversationId: string,
    question: string,
    options: string[],
    target: MessageTarget
  ): Promise<string> {
    const token = this.createQuestionToken(target.sessionId, conversationId);
    const timeoutMs = questionTimeoutMs(this.config.sdk.questionTimeoutMs);
    const buttons = [
      ...options.map((opt, i) => [Markup.button.callback(opt.slice(0, 64), `q:${token}:${i}`)]),
      [Markup.button.callback('Stop', `qstop:${token}`)],
    ];

    await this.sendFormattedWithKeyboard(
      conversationId,
      formatAgentQuestion(question, { timeoutMs }),
      Markup.inlineKeyboard(buttons)
    );

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingQuestions.get(token);
        if (!pending) return;
        this.pendingQuestions.delete(token);
        const chosen = timeoutFallbackAnswer(question, pending.options);
        pending.resolve(chosen);
        void this.sendMessage(conversationId, formatQuestionTimedOut(chosen));
      }, timeoutMs);

      this.pendingQuestions.set(token, {
        resolve,
        options,
        sessionId: target.sessionId,
        conversationId,
        timeout,
      });

      this.bot.action(new RegExp(`q:${token}:(\\d+)`), async (ctx) => {
        const index = parseInt(ctx.match[1], 10);
        const pending = this.pendingQuestions.get(token);

        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(pending.options[index] || '');
          this.pendingQuestions.delete(token);
          await ctx.answerCbQuery();
          await ctx.reply(`✅ Selected: ${pending.options[index]}`);
        }
      });

      this.bot.action(`qstop:${token}`, async (ctx) => {
        const pending = this.pendingQuestions.get(token);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(QUESTION_CANCELLED);
          this.pendingQuestions.delete(token);
        }
        await ctx.answerCbQuery('Stopped');
        await ctx.reply(formatQuestionCancelled());
      });
    });
  }

  cancelPendingQuestions(sessionId: string): number {
    let count = 0;
    for (const [token, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      pending.resolve(QUESTION_CANCELLED);
      this.pendingQuestions.delete(token);
      count += 1;
      void this.sendMessage(pending.conversationId, formatQuestionCancelled());
    }
    return count;
  }

  async notifyOperators(text: string): Promise<void> {
    const chatIds = new Set<string>([
      ...this.activeSessions.keys(),
      ...[...this.allowedUserIds].map(String),
    ]);
    for (const chatId of chatIds) {
      try {
        await this.sendMessage(chatId, text);
      } catch (err) {
        logger.warn({ err, chatId }, 'Failed to notify Telegram operator');
      }
    }
  }

  private createQuestionToken(sessionId: string, conversationId: string): string {
    return createHash('sha256')
      .update(`${sessionId}:${conversationId}`)
      .digest('hex')
      .slice(0, 12);
  }

  private async handleMachine(ctx: Context<Update>, arg: string): Promise<void> {
    const chatId = String(ctx.chat?.id);
    if (arg.trim().toLowerCase() === 'wake') {
      const mac = this.config.machine?.wolMac?.trim();
      if (!mac) {
        await ctx.reply('Wake-on-LAN is not configured. Set machine.wol_mac or WOL_MAC.');
        return;
      }
      const sent = await sendWakeOnLan(mac);
      await ctx.reply(sent.message);
      return;
    }

    const current = this.getCurrentSession(chatId);
    const report = collectMachineStatus({
      version: getVersion(),
      port: this.config.server.port,
      workspaceRoot: this.config.workspaceRoot,
      sessionCount: this.sessionManager.listAllSessions(false).length,
      maxSessions: this.config.sdk.maxSessions,
      currentTitle: current?.title || current?.repoName,
      heartbeatAgeMs: heartbeatAgeMs(readHeartbeat()),
      wolMac: this.config.machine?.wolMac,
      localUrl: `http://127.0.0.1:${this.config.server.port}`,
    });
    await ctx.reply(formatMachineReport(report));
  }

  private async handleRules(ctx: Context<Update>, arg: string): Promise<void> {
    const current = await this.requireCurrentWorkspace(ctx);
    if (!current) return;

    const trimmed = arg.trim();
    if (trimmed.toLowerCase().startsWith('extra')) {
      const extra = trimmed.slice(5).trim();
      const saved = this.sessionManager.setExtraRules(current.session.id, extra || null);
      await ctx.reply(
        saved
          ? `Session extra rules set:\n${saved}`
          : 'Cleared session extra rules. Workspace files still apply.'
      );
      return;
    }
    if (trimmed && trimmed !== 'extra') {
      await ctx.reply(formatRulesUsage());
      return;
    }

    await ctx.reply(
      await summarizeWorkspaceRules(
        current.repoPath,
        this.sessionManager.getExtraRules(current.session.id)
      )
    );
  }

  private async handleApplyPlan(ctx: Context<Update>): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const session = this.getCurrentSession(chatId);
    if (!session) {
      await ctx.answerCbQuery('No session');
      await ctx.reply(formatNoActiveSession());
      return;
    }

    const plan = this.sessionManager.getLastPlan(session.id);
    this.sessionManager.setSessionMode(session.id, 'agent');
    this.sessionManager.clearLastPlan(session.id);
    await ctx.answerCbQuery('Applying plan');
    await ctx.reply('Switched to agent. Implementing the plan…');

    const prompt = plan ? `${APPLY_PLAN_PROMPT}\n\n${plan}` : APPLY_PLAN_PROMPT;
    if (
      session.activity === 'running' ||
      this.inflightSessionMessages.has(session.id)
    ) {
      await ctx.reply(formatAgentBusy(), stopRunKeyboard());
      return;
    }
    const status = await ctx.reply('⏳ Applying plan…', stopRunKeyboard());
    void this.processSessionMessage(session.id, prompt, chatId, status.message_id);
  }

  private getCurrentSession(chatId: string): Session | undefined {
    const sessionId = this.activeSessions.get(chatId);
    if (!sessionId) {
      return undefined;
    }
    return this.sessionManager.getSession(sessionId);
  }

  private async setCurrentMode(ctx: Context<Update>, mode: SessionMode): Promise<void> {
    const chatId = String(ctx.chat?.id);
    let session = this.getCurrentSession(chatId);
    if (!session) {
      const sessionId = await this.resolveOrCreateSession(chatId, ctx);
      if (!sessionId) return;
      session = this.sessionManager.getSession(sessionId);
    }
    if (!session) {
      await ctx.reply('No active session. Send text or pick /workspaces first.');
      return;
    }

    this.sessionManager.setSessionMode(session.id, mode);
    await ctx.reply(formatModeChanged(mode));
  }

  private async announceNewWorkspaceSession(
    ctx: Context<Update>,
    chatId: string,
    path: string,
    name: string
  ): Promise<void> {
    const open = this.sessionManager.listAllSessions(false);
    const max = this.config.sdk.maxSessions;

    if (open.length >= max) {
      this.pendingWorkspaceCreate.set(chatId, { path, name });
      await ctx.reply(
        formatSessionLimitReached(open.length, max),
        Markup.inlineKeyboard(this.sessionCloseButtons(open))
      );
      return;
    }

    if (open.length >= max - 1) {
      this.pendingWorkspaceCreate.set(chatId, { path, name });
      const rows = [
        [Markup.button.callback('Continue (use last slot)', 'slot:continue')],
        ...this.sessionCloseButtons(open),
        [Markup.button.callback('Cancel', 'slot:cancel')],
      ];
      await ctx.reply(formatNearSessionLimit(open.length, max), Markup.inlineKeyboard(rows));
      return;
    }

    await this.createWorkspaceSessionNow(ctx, chatId, path, name);
  }

  private sessionCloseButtons(sessions: Session[]): ReturnType<typeof Markup.button.callback>[][] {
    return sessions.map((s) => {
      const label = `Close ${s.title || s.repoName}`.slice(0, 60);
      return [Markup.button.callback(label, `slot:close:${s.id}`)];
    });
  }

  private async createWorkspaceSessionNow(
    ctx: Context<Update>,
    chatId: string,
    path: string,
    name: string
  ): Promise<void> {
    const previousOpenCount = this.sessionManager.listAllSessions(false).length;
    try {
      const session = await this.sessionManager.createSession('telegram', chatId, path, name);
      this.activeSessions.set(chatId, session.id);
      await ctx.reply(
        formatSessionCreatedNotice({
          title: name,
          previousOpenCount,
        })
      );
    } catch (err) {
      if (err instanceof SessionLimitError) {
        const open = this.sessionManager.listAllSessions(false);
        this.pendingWorkspaceCreate.set(chatId, { path, name });
        await ctx.reply(
          formatSessionLimitReached(open.length, this.config.sdk.maxSessions),
          Markup.inlineKeyboard(this.sessionCloseButtons(open))
        );
        return;
      }
      throw err;
    }
  }

  /** Send command output as a message, or as a .txt document when it exceeds Telegram limits. */
  async sendWorkspaceOutput(conversationId: string, result: Parameters<typeof telegramPayloadForCommand>[0]): Promise<void> {
    const payload = telegramPayloadForCommand(result);
    if (!payload.asDocument) {
      await this.sendMessage(conversationId, payload.text);
      return;
    }

    try {
      await this.bot.telegram.sendDocument(
        conversationId,
        {
          source: Buffer.from(payload.body, 'utf8'),
          filename: payload.filename,
        },
        { caption: payload.text.slice(0, 1024) }
      );
    } catch (err) {
      logger.warn({ err, conversationId }, 'Failed to send command output as document, falling back to text');
      await this.sendMessage(conversationId, payload.text);
    }
  }
}
