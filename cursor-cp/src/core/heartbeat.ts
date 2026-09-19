/**
 * Daemon heartbeat file + stale-restart detection (Phase 7.2).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../util/logger.js';
import { dataDir } from '../paths.js';
import { resolve } from 'path';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const STALE_HEARTBEAT_MS = 3 * 60_000;

export interface HeartbeatRecord {
  pid: number;
  at: string;
  uptimeSec: number;
}

export function heartbeatPath(): string {
  return resolve(dataDir(), 'heartbeat.json');
}

export function readHeartbeat(path = heartbeatPath()): HeartbeatRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as HeartbeatRecord;
    if (!parsed?.at || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeHeartbeat(
  path = heartbeatPath(),
  now = new Date(),
  uptimeSec = process.uptime()
): HeartbeatRecord {
  const record: HeartbeatRecord = {
    pid: process.pid,
    at: now.toISOString(),
    uptimeSec: Math.floor(uptimeSec),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  return record;
}

export function heartbeatAgeMs(
  record: HeartbeatRecord | null,
  now = Date.now()
): number | null {
  if (!record?.at) return null;
  const then = Date.parse(record.at);
  if (Number.isNaN(then)) return null;
  return Math.max(0, now - then);
}

export function isStaleHeartbeat(
  record: HeartbeatRecord | null,
  now = Date.now(),
  staleMs = STALE_HEARTBEAT_MS
): boolean {
  const age = heartbeatAgeMs(record, now);
  if (age === null) return false;
  return age >= staleMs && record?.pid !== process.pid;
}

export function formatHeartbeatGap(gapMs: number): string {
  const minutes = Math.max(1, Math.round(gapMs / 60_000));
  return (
    `⚠️ cursor-cp restarted after ~${minutes} min without a heartbeat. ` +
    'The daemon was down or the machine slept. Send /machine for status.'
  );
}

export function startHeartbeat(options?: {
  path?: string;
  intervalMs?: number;
  staleMs?: number;
  onStale?: (gapMs: number) => void | Promise<void>;
}): { stop: () => void; record: HeartbeatRecord } {
  const path = options?.path ?? heartbeatPath();
  const intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleMs = options?.staleMs ?? STALE_HEARTBEAT_MS;

  const previous = readHeartbeat(path);
  const age = heartbeatAgeMs(previous);
  if (previous && age !== null && age >= staleMs && previous.pid !== process.pid) {
    logger.warn({ ageMs: age, previous }, 'Stale heartbeat — process was down or machine slept');
    void Promise.resolve(options?.onStale?.(age)).catch((err) => {
      logger.warn({ err }, 'Heartbeat stale callback failed');
    });
  }

  const record = writeHeartbeat(path);
  const timer = setInterval(() => {
    try {
      writeHeartbeat(path);
    } catch (err) {
      logger.warn({ err }, 'Failed to write heartbeat');
    }
  }, intervalMs);
  timer.unref?.();

  return {
    record,
    stop: () => {
      clearInterval(timer);
    },
  };
}
