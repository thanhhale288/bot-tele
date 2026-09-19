import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { migrateAgentSessions } from './connection.js';

describe('migrateAgentSessions', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    paths.length = 0;
  });

  it('adds mode and last-activity columns to an old agent_sessions table', () => {
    const dbPath = resolve(tmpdir(), `mig-${Date.now()}.db`);
    paths.push(dbPath);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        repo_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);

    migrateAgentSessions(db);
    const columns = db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('sdk_agent_id');
    expect(names).toContain('mode');
    expect(names).toContain('last_command');
    expect(names).toContain('last_file');
    db.close();
  });
});
