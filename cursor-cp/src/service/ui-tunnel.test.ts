import { describe, it, expect } from 'vitest';
import { extractTunnelUrl, normalizeTunnelHostname } from './ui-tunnel.js';

describe('extractTunnelUrl', () => {
  it('parses the trycloudflare URL from cloudflared banner text', () => {
    const log = `
INF |  Your quick Tunnel has been created! Visit it at:
INF |  https://random-words-1234.trycloudflare.com
INF +--------------------------------------------------------------------------------------------+
`;
    expect(extractTunnelUrl(log)).toBe('https://random-words-1234.trycloudflare.com');
  });

  it('returns null when no URL is present', () => {
    expect(extractTunnelUrl('starting tunnel')).toBeNull();
  });

  it('normalizes a named tunnel hostname', () => {
    expect(normalizeTunnelHostname('cp.example.com')).toBe('https://cp.example.com');
    expect(normalizeTunnelHostname('https://cp.example.com/path')).toBe('https://cp.example.com');
    expect(normalizeTunnelHostname('')).toBeNull();
  });
});
