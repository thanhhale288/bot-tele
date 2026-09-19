import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  formatHeartbeatGap,
  heartbeatAgeMs,
  isStaleHeartbeat,
  readHeartbeat,
  writeHeartbeat,
} from './heartbeat.js';

describe('heartbeat', () => {
  it('writes and reads a heartbeat record', () => {
    const path = resolve(mkdtempSync(resolve(tmpdir(), 'hb-')), 'heartbeat.json');
    const record = writeHeartbeat(path, new Date('2026-01-01T00:00:00.000Z'), 12);
    expect(record.pid).toBe(process.pid);
    expect(readHeartbeat(path)?.uptimeSec).toBe(12);
  });

  it('detects stale heartbeats from another pid', () => {
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const stale = {
      pid: process.pid + 1,
      at: '2026-01-01T00:00:00.000Z',
      uptimeSec: 1,
    };
    expect(heartbeatAgeMs(stale, now)).toBe(10 * 60_000);
    expect(isStaleHeartbeat(stale, now, 3 * 60_000)).toBe(true);
    expect(isStaleHeartbeat({ ...stale, pid: process.pid }, now, 3 * 60_000)).toBe(false);
    expect(formatHeartbeatGap(10 * 60_000)).toMatch(/10 min/);
  });
});
