/**
 * /machine report (Phase 7.1).
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { ServiceController } from '../service/service-control.js';
import { getUiTunnel } from '../service/ui-tunnel.js';
import { listDevServers, listOpenPreviews } from './workspace-run.js';

export interface MachineReport {
  version: string;
  host: string;
  port: number;
  workspaceRoot: string;
  sessionCount: number;
  maxSessions: number;
  currentTitle?: string;
  daemon: string;
  processUptime: string;
  osUptime: string;
  disk: string;
  uiTunnel: string;
  previews: string[];
  devServers: string[];
  sleepWarning: string | null;
  heartbeat: string;
  wolConfigured: boolean;
}

export interface MachineStatusInput {
  version: string;
  port: number;
  workspaceRoot: string;
  sessionCount: number;
  maxSessions: number;
  currentTitle?: string;
  processUptimeSec?: number;
  osUptimeSec?: number;
  daemon?: string;
  disk?: string;
  uiTunnelUrl?: string | null;
  previews?: Array<{ url: string; port: number }>;
  devServers?: Array<{ script: string; pid: number }>;
  sleepWarning?: string | null;
  heartbeatAgeMs?: number | null;
  wolMac?: string;
  host?: string;
}

export function formatDuration(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function parseDfLine(text: string): string | null {
  const lines = text.trim().split('\n').filter(Boolean);
  const data = lines[1] || lines[0];
  if (!data) return null;
  const cols = data.trim().split(/\s+/);
  if (cols.length < 5) return null;
  const avail = cols[3];
  const usedPct = cols[4];
  return `${usedPct} used, ${avail} free`;
}

export function detectSleepRisk(pmsetText: string, caffeinateRunning: boolean): string | null {
  if (caffeinateRunning) return null;
  const sleep = pmsetText.match(/^\s*sleep\s+(\d+)/m);
  const value = sleep ? Number(sleep[1]) : null;
  if (value && value > 0) {
    return `System sleep is ${value} min. Run scripts/keep-awake.sh (caffeinate) so the bot stays up.`;
  }
  return null;
}

export function describeDaemon(controller = new ServiceController()): string {
  if (!controller.isInstalled()) {
    return 'not enabled — cursor-cp daemon enable';
  }
  return controller.getStatus();
}

function readDf(workspaceRoot: string): string {
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return 'workspace path missing';
  }
  try {
    const out = execSync(`df -h "${workspaceRoot}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return parseDfLine(out) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readOsUptimeSec(): number {
  try {
    const out = execSync('sysctl -n kern.boottime', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    const sec = Number(out.match(/sec\s*=\s*(\d+)/)?.[1]);
    if (sec) return Math.max(0, Date.now() / 1000 - sec);
  } catch {
    // fall through
  }
  try {
    const out = execSync('uptime', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    const days = Number(out.match(/(\d+)\s+day/)?.[1] || 0);
    const hm = out.match(/(\d+):(\d+)/);
    const hours = Number(hm?.[1] || 0);
    const minutes = Number(hm?.[2] || 0);
    return days * 86400 + hours * 3600 + minutes * 60;
  } catch {
    return 0;
  }
}

function readSleepWarning(): string | null {
  if (process.platform !== 'darwin') return null;
  let pmset = '';
  let caffeinate = false;
  try {
    pmset = execSync('pmset -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4_000,
    });
  } catch {
    return null;
  }
  try {
    execSync('pgrep -x caffeinate', { stdio: 'ignore', timeout: 2_000 });
    caffeinate = true;
  } catch {
    caffeinate = false;
  }
  return detectSleepRisk(pmset, caffeinate);
}

export function buildMachineReport(input: MachineStatusInput): MachineReport {
  const previews = (input.previews ?? []).map((p) => `${p.url} (app :${p.port})`);
  const devServers = (input.devServers ?? []).map((d) => `${d.script} pid ${d.pid}`);
  const hb =
    input.heartbeatAgeMs == null
      ? 'now'
      : input.heartbeatAgeMs < 5_000
        ? 'now'
        : `${Math.round(input.heartbeatAgeMs / 1000)}s ago`;

  return {
    version: input.version,
    host: input.host || hostname(),
    port: input.port,
    workspaceRoot: input.workspaceRoot,
    sessionCount: input.sessionCount,
    maxSessions: input.maxSessions,
    currentTitle: input.currentTitle,
    daemon: input.daemon || 'unknown',
    processUptime: formatDuration(input.processUptimeSec ?? process.uptime()),
    osUptime: formatDuration(input.osUptimeSec ?? 0),
    disk: input.disk || 'unknown',
    uiTunnel: input.uiTunnelUrl || 'down — /ui to open',
    previews,
    devServers,
    sleepWarning: input.sleepWarning ?? null,
    heartbeat: hb,
    wolConfigured: Boolean(input.wolMac?.trim()),
  };
}

export function collectMachineStatus(input: {
  version: string;
  port: number;
  workspaceRoot: string;
  sessionCount: number;
  maxSessions: number;
  currentTitle?: string;
  heartbeatAgeMs?: number | null;
  wolMac?: string;
  localUrl?: string;
}): MachineReport {
  let uiTunnel: string | null = null;
  try {
    uiTunnel = getUiTunnel(input.localUrl || `http://127.0.0.1:${input.port}`).getCurrentUrl();
  } catch {
    uiTunnel = null;
  }

  return buildMachineReport({
    ...input,
    processUptimeSec: process.uptime(),
    osUptimeSec: readOsUptimeSec(),
    daemon: describeDaemon(),
    disk: readDf(input.workspaceRoot),
    uiTunnelUrl: uiTunnel,
    previews: listOpenPreviews(),
    devServers: listDevServers(),
    sleepWarning: readSleepWarning(),
  });
}

export function formatMachineReport(report: MachineReport): string {
  const lines = [
    `Cursor Control Plane v${report.version}`,
    `Host: ${report.host}`,
    `Daemon: ${report.daemon}`,
    `Process uptime: ${report.processUptime}`,
    `Machine uptime: ${report.osUptime}`,
    `Heartbeat: ${report.heartbeat}`,
    `Dashboard: http://127.0.0.1:${report.port}`,
    `Workspace: ${report.workspaceRoot}`,
    `Disk: ${report.disk}`,
    `Sessions: ${report.sessionCount} / ${report.maxSessions}`,
    `Current: ${report.currentTitle?.trim() || 'none'}`,
    `UI tunnel: ${report.uiTunnel}`,
  ];

  if (report.devServers.length) {
    lines.push(`Dev servers: ${report.devServers.join(', ')}`);
  }
  if (report.previews.length) {
    lines.push(`App tunnels: ${report.previews.join(', ')}`);
  }
  if (report.sleepWarning) {
    lines.push('', report.sleepWarning);
  }
  if (report.wolConfigured) {
    lines.push('', 'Wake-on-LAN is configured. /machine wake to send a magic packet.');
  }

  lines.push('', 'Send /ui for a public dashboard URL. /ui stop when done.');
  return lines.join('\n');
}
