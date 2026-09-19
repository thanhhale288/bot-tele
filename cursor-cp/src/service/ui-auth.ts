/**
 * Dashboard / API token for /ui tunnels (Phase 6.6).
 * Localhost stays open; remote requests need the token.
 */

import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const UI_TOKEN_COOKIE = 'cp_ui_token';
export const UI_TOKEN_HEADER = 'x-ui-token';

export function generateUiToken(): string {
  return randomBytes(16).toString('hex');
}

export function resolveUiToken(configured?: string | null): string {
  const fromConfig = configured?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.CURSOR_CP_UI_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return generateUiToken();
}

export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const trimmed = ip.trim().toLowerCase();
  return (
    trimmed === '127.0.0.1' ||
    trimmed === '::1' ||
    trimmed === '::ffff:127.0.0.1' ||
    trimmed.endsWith('127.0.0.1')
  );
}

export function parseCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.split('=');
    if (rawName?.trim() === name) {
      return decodeURIComponent(rest.join('=').trim());
    }
  }
  return '';
}

export function extractUiToken(req: {
  query?: unknown;
  headers: { [key: string]: string | string[] | undefined };
}): string {
  const query = req.query as { token?: unknown } | undefined;
  if (typeof query?.token === 'string' && query.token.trim()) {
    return query.token.trim();
  }

  const header = req.headers[UI_TOKEN_HEADER];
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return parseCookieValue(
    typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
    UI_TOKEN_COOKIE
  );
}

export function withUiToken(url: string, token: string): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('token', token);
    return parsed.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }
}

function requestPath(req: FastifyRequest): string {
  const url = req.url || '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isPublicUiPath(path: string): boolean {
  return path === '/api/health' || path === '/health';
}

export function registerUiGuard(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(req);
    if (isPublicUiPath(path)) return;
    if (isLoopbackIp(req.ip)) return;

    const provided = extractUiToken(req);
    if (provided && provided === token) {
      if (typeof (req.query as { token?: string } | undefined)?.token === 'string') {
        reply.header(
          'Set-Cookie',
          `${UI_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; HttpOnly`
        );
      }
      return;
    }

    return reply.code(401).send({
      error: 'Dashboard token required. Open the /ui link from Telegram.',
    });
  });
}
