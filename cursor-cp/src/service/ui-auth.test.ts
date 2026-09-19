import { describe, expect, it } from 'vitest';
import {
  extractUiToken,
  generateUiToken,
  isLoopbackIp,
  isPublicUiPath,
  parseCookieValue,
  resolveUiToken,
  withUiToken,
} from './ui-auth.js';

describe('ui-auth', () => {
  it('generates and prefers configured tokens', () => {
    expect(generateUiToken()).toHaveLength(32);
    expect(resolveUiToken('  abc  ')).toBe('abc');
  });

  it('treats loopback and health as open', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('1.2.3.4')).toBe(false);
    expect(isPublicUiPath('/api/health')).toBe(true);
    expect(isPublicUiPath('/api/sessions')).toBe(false);
  });

  it('extracts token from query, header, bearer, or cookie', () => {
    expect(extractUiToken({ query: { token: 'q' }, headers: {} })).toBe('q');
    expect(extractUiToken({ headers: { 'x-ui-token': 'h' } })).toBe('h');
    expect(extractUiToken({ headers: { authorization: 'Bearer b' } })).toBe('b');
    expect(parseCookieValue('a=1; cp_ui_token=c', 'cp_ui_token')).toBe('c');
    expect(extractUiToken({ headers: { cookie: 'cp_ui_token=c' } })).toBe('c');
  });

  it('appends token to a dashboard URL', () => {
    expect(withUiToken('https://x.trycloudflare.com', 'tok')).toBe(
      'https://x.trycloudflare.com/?token=tok'
    );
  });
});
