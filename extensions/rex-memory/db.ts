import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

// ============================================================================
// Types
// ============================================================================

export type MemoryRow = {
  id: string;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  embedding: Buffer | null;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export type PendingIngestRow = {
  id: number;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  source: string | null;
  created_at: string;
};

export type AuditLogRow = {
  id: number;
  action: string;
  memory_id: string | null;
  agent_id: string | null;
  details: string | null;
  created_at: string;
};

export type CategoryRow = {
  name: string;
  description: string | null;
  created_at: string;
};

export type SyncStateRow = {
  agent_id: string;
  last_sync_id: string | null;
  last_sync_at: string | null;
};

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    agent_id TEXT,
    category TEXT,
    embedding BLOB,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_ingest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    agent_id TEXT,
    category TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    memory_id TEXT,
    agent_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    agent_id TEXT PRIMARY KEY,
    last_sync_id TEXT,
    last_sync_at TEXT
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
  CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_ingest_created_at ON pending_ingest(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_log_memory_id ON audit_log(memory_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
`;

const DEFAULT_CATEGORIES_SQL = `
  INSERT OR IGNORE INTO categories (name, description) VALUES
    ('code', 'Code snippets, implementations, and technical solutions'),
    ('architecture', 'System design, architecture decisions, and patterns'),
    ('debugging', 'Bug fixes, troubleshooting steps, and error resolutions'),
    ('personal', 'Personal preferences, contacts, and private information'),
    ('project', 'Project-specific context, requirements, and status'),
    ('reference', 'Documentation, links, API references, and external resources'),
    ('decision', 'Technical and business decisions with rationale'),
    ('pattern', 'Recurring patterns, best practices, and conventions');
`;

// ============================================================================
// Database singleton
// ============================================================================

let dbInstance: Database.Database | null = null;
let dbPath: string | null = null;

function resolveDefaultDbPath(): string {
  const home = homedir();
  const rexMemoryDir = join(home, ".rex-memory");
  return join(rexMemoryDir, "rex-memory.db");
}

function ensureDirectoryExists(filePath: string): void {
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runMigrations(db: Database.Database): void {
  const versionRow = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;

  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}

export function initDb(path?: string): Database.Database {
  const resolvedPath = path ?? resolveDefaultDbPath();
  ensureDirectoryExists(resolvedPath);

  const db = new Database(resolvedPath);

  // Enable WAL mode for concurrent reads
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Create schema
  db.exec(SCHEMA_SQL);
  db.exec(DEFAULT_CATEGORIES_SQL);

  // Run migrations
  runMigrations(db);

  // Store singleton
  dbInstance = db;
  dbPath = resolvedPath;

  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error("rex-memory: database not initialized. Call initDb() first.");
  }
  return dbInstance;
}

export function getDbPath(): string {
  return dbPath ?? resolveDefaultDbPath();
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPath = null;
  }
}
