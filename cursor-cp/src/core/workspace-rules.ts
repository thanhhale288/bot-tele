/**
 * Summarize workspace rules for /rules (Phase 6.5).
 */

import { existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { listWorkspaceRuleFiles } from './workspace-inbox.js';
import { safeResolveWorkspacePath } from './workspace-review.js';

export const RULES_PREVIEW_CHARS = 900;
export const RULES_MAX_FILES = 8;

export async function summarizeWorkspaceRules(
  cwd: string,
  extra?: string | null
): Promise<string> {
  const files = listWorkspaceRuleFiles(cwd);
  const lines: string[] = [];

  if (files.length === 0) {
    lines.push('No workspace rules found (.cursorrules, .cursor/rules, AGENTS.md).');
  } else {
    lines.push(`Rules loaded from the workspace (${files.length}):`);
    for (const rel of files.slice(0, RULES_MAX_FILES)) {
      lines.push('', `• ${rel}`);
      const body = await previewRuleFile(cwd, rel);
      if (body) {
        lines.push(body);
      }
    }
    if (files.length > RULES_MAX_FILES) {
      lines.push('', `…and ${files.length - RULES_MAX_FILES} more file(s).`);
    }
  }

  const extraText = extra?.trim();
  if (extraText) {
    lines.push('', 'Session extra rules (prepended to prompts):', extraText);
  } else {
    lines.push('', 'No session extra rules. /rules extra <text> to add, /rules extra to clear.');
  }

  return lines.join('\n');
}

async function previewRuleFile(cwd: string, rel: string): Promise<string> {
  const resolved = safeResolveWorkspacePath(cwd, rel);
  if (!resolved.ok) return '';
  try {
    if (!existsSync(resolved.absolute) || !statSync(resolved.absolute).isFile()) {
      return '';
    }
    const raw = (await readFile(resolved.absolute, 'utf8')).trim();
    if (!raw) return '(empty)';
    if (raw.length <= RULES_PREVIEW_CHARS) return raw;
    return `${raw.slice(0, RULES_PREVIEW_CHARS)}\n…`;
  } catch {
    return '';
  }
}

export function formatRulesUsage(): string {
  return (
    'Usage:\n' +
    '/rules — show workspace rules in this session\n' +
    '/rules extra <text> — add a session-only extra rule\n' +
    '/rules extra — clear the session extra rule'
  );
}

export function extraRulesPromptPrefix(extra: string | null | undefined): string {
  const trimmed = extra?.trim();
  if (!trimmed) return '';
  return `[SESSION EXTRA RULES]\n${trimmed}\n\n`;
}
