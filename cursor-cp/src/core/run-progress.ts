/**
 * In-memory snapshot of the current agent run (Phase 1).
 * Not persisted to SQLite — it only exists while a run is active.
 */

import type { AgentActivity } from '../models/types.js';

export interface AgentRunStep {
  tool: string | null;
  file: string | null;
  command: string | null;
  status: string | null;
  startedAt: string;
}

export interface AgentRunProgress {
  activity: AgentActivity;
  runStartedAt: string | null;
  elapsedMs: number;
  step: AgentRunStep | null;
}

export interface StopRunResult {
  stopped: boolean;
  reason?: string;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

export function formatRunProgress(progress: AgentRunProgress | undefined): string {
  if (!progress || progress.activity === 'idle') {
    return 'No agent run is in progress. Session is idle.';
  }

  if (progress.activity === 'waiting_user') {
    return 'Agent is waiting for your input.';
  }

  if (progress.activity === 'connecting') {
    return '⏳ Connecting to the agent…';
  }

  if (progress.activity === 'error') {
    return 'Last run ended with an error. Send a new message or /stop if it is still busy.';
  }

  const lines = [`⏳ Agent is ${progress.activity} · ${formatElapsed(progress.elapsedMs)}`];
  const step = progress.step;
  if (step) {
    if (step.tool) lines.push(`Tool: ${step.tool}`);
    if (step.file) lines.push(`File: ${step.file}`);
    if (step.command) lines.push(`Command: ${step.command}`);
    if (step.status) lines.push(`Step: ${step.status}`);
  } else {
    lines.push('No tool event yet.');
  }
  return lines.join('\n');
}

/** Pull a workspace path or shell command out of SDK tool_call args. */
export function extractStepFromToolCall(
  name: string,
  args: unknown,
  status: string | null = 'running'
): AgentRunStep {
  const record = asRecord(args);
  const file =
    pickString(record, ['path', 'file', 'file_path', 'target', 'uri', 'targetDirectory']) ??
    firstPathInArray(record?.paths) ??
    null;
  const command =
    pickString(record, ['command', 'cmd', 'script']) ??
    null;

  return {
    tool: name || null,
    file,
    command,
    status,
    startedAt: new Date().toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstPathInArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => typeof item === 'string' && item.trim());
  return typeof first === 'string' ? first.trim() : null;
}
