/**
 * Core domain types for Cursor Control Plane
 */

export type SessionStatus = 'open' | 'closed';
export type AgentActivity = 'idle' | 'connecting' | 'running' | 'waiting_user' | 'error';
export type SessionMode = 'ask' | 'agent' | 'plan';

export interface Session {
  id: string;
  channel: string;
  channelKey: string;
  repoPath: string;
  repoName: string;
  title: string;
  status: SessionStatus;
  activity: AgentActivity;
  mode: SessionMode;
  model: string | null;
  /** Cursor SDK agent id (`agent-…` local, `bc-…` cloud) for Agent.resume after restart */
  sdkAgentId: string | null;
  lastCommand: string | null;
  lastFile: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  errorMessage: string | null;
  outputPreview: string;
}

export interface SessionMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface SessionParticipant {
  sessionId: string;
  channel: string;
  conversationId: string;
  joinedAt: string;
}

export interface MessageTarget {
  sessionId: string;
  conversationId: string;
}

export interface IncomingMessage {
  conversationId: string;
  channel: string;
  text: string;
  repoPath?: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  description: string;
}

export interface ChannelConfig {
  enabled: boolean;
}

export interface TelegramChannelConfig extends ChannelConfig {
  botToken: string;
  allowedUserIds: number[];
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Empty = generate an ephemeral token at startup. Required for remote /ui. */
  uiToken?: string;
  /** Cloudflare named-tunnel token. Empty = trycloudflare quick tunnel. */
  tunnelToken?: string;
  /** Stable hostname for a named tunnel, e.g. https://cp.example.com */
  tunnelHostname?: string;
}

export interface SdkConfig {
  defaultModel: string;
  maxSessions: number;
  /** Agent question timeout. Default 1 hour. */
  questionTimeoutMs?: number;
}

export interface MachineConfig {
  /** 0 = no periodic Telegram ping. */
  telegramHeartbeatHours?: number;
  /** Optional Wake-on-LAN MAC for /machine wake */
  wolMac?: string;
}

/** null = default daily log file; empty string = disabled; otherwise custom base path */
export type LogFileSetting = string | null;

export interface LoggingConfig {
  level: string;
  file: LogFileSetting;
}

export interface AppConfig {
  cursorApiKey: string;
  repos: RepoEntry[];
  workspaceRoot: string;
  channels: {
    telegram: TelegramChannelConfig;
    web: ChannelConfig;
  };
  server: ServerConfig;
  sdk: SdkConfig;
  logging: LoggingConfig;
  machine?: MachineConfig;
}

export type EventType =
  | 'session_updated'
  | 'session_closed'
  | 'session_removed'
  | 'sessions_purged'
  | 'agent_stream'
  | 'agent_progress'
  | 'channel_message'
  | 'question'
  | 'hello'
  | 'pong';

export interface AppEvent {
  type: EventType;
  [key: string]: unknown;
}
