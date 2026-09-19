import { describe, expect, it } from 'vitest';
import {
  buildMachineReport,
  detectSleepRisk,
  formatDuration,
  formatMachineReport,
  parseDfLine,
} from './machine-status.js';

describe('machine-status', () => {
  it('formats durations and df output', () => {
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(parseDfLine('Filesystem Size Used Avail Capacity\n/dev/disk3s1 1Ti 500Gi 400Gi 56%')).toBe(
      '56% used, 400Gi free'
    );
  });

  it('warns when macOS sleep is on and caffeinate is not running', () => {
    expect(detectSleepRisk(' sleep            10\n', false)).toMatch(/caffeinate/);
    expect(detectSleepRisk(' sleep            10\n', true)).toBeNull();
    expect(detectSleepRisk(' sleep            0\n', false)).toBeNull();
  });

  it('formats a /machine report', () => {
    const text = formatMachineReport(
      buildMachineReport({
        version: '0.4.0',
        port: 8747,
        workspaceRoot: '/tmp/ws',
        sessionCount: 1,
        maxSessions: 5,
        currentTitle: 'app',
        processUptimeSec: 120,
        osUptimeSec: 3600,
        daemon: 'running',
        disk: '40% used, 200Gi free',
        uiTunnelUrl: 'https://x.trycloudflare.com',
        previews: [{ url: 'https://app.trycloudflare.com', port: 5173 }],
        heartbeatAgeMs: 0,
        wolMac: 'aa:bb:cc:dd:ee:ff',
        host: 'home-mac',
      })
    );
    expect(text).toContain('Daemon: running');
    expect(text).toContain('Sessions: 1 / 5');
    expect(text).toContain('https://x.trycloudflare.com');
    expect(text).toContain('5173');
    expect(text).toMatch(/\/ui stop/);
    expect(text).toMatch(/Wake-on-LAN/);
  });
});
