/**
 * Classify destructive commands so Telegram can require an explicit Yes.
 */

export type DangerousCommandKind =
  | 'rm-rf'
  | 'drop-db'
  | 'migrate'
  | 'force-push'
  | 'reset-hard';

const DROP_DB =
  /\bdrop\s+(database|schema|table)\b|\bprisma\s+migrate\s+reset\b|\bknex\s+migrate:rollback\b|\bsequelize\s+db:drop\b|\btypeorm\s+schema:drop\b/i;

const MIGRATE =
  /\b(prisma\s+migrate\s+(dev|deploy|reset)|alembic\s+upgrade|flyway\s+migrate|rails\s+db:migrate|npm\s+run\s+migrate|yarn\s+migrate|pnpm\s+migrate|npx\s+.*migrate)\b/i;

const RM_RF = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)\b/;

export function classifyDangerousCommand(input: string): DangerousCommandKind | null {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/\b(git\s+)?push\b/i.test(text) && /(--force|-f)\b/.test(text)) {
    return 'force-push';
  }
  if (/\b(git\s+)?reset\b/i.test(text) && /--hard\b/.test(text)) {
    return 'reset-hard';
  }
  if (RM_RF.test(text) || /\brm\s+-rf\b/i.test(text) || /\brm\s+-fr\b/i.test(text)) {
    return 'rm-rf';
  }
  if (DROP_DB.test(text)) {
    return 'drop-db';
  }
  if (MIGRATE.test(text)) {
    return 'migrate';
  }
  return null;
}

export function dangerousCommandLabel(kind: DangerousCommandKind): string {
  switch (kind) {
    case 'rm-rf':
      return 'rm -rf (recursive delete)';
    case 'drop-db':
      return 'drop database / schema reset';
    case 'migrate':
      return 'database migrate';
    case 'force-push':
      return 'git push --force';
    case 'reset-hard':
      return 'git reset --hard';
  }
}

export function formatDangerousCommandWarning(kind: DangerousCommandKind): string {
  return (
    `⚠️ Dangerous command: ${dangerousCommandLabel(kind)}.\n` +
    'Confirm with Yes, or tap Stop / send /stop to cancel.'
  );
}
