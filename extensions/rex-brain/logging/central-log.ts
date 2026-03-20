import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db-helper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RexEventType =
  | "message_in"
  | "message_out"
  | "tool_call"
  | "routing_decision"
  | "agent_deploy"
  | "fleet_sync"
  | "error"
  | "health_check";

export type RexEvent = {
  timestamp: number;
  type: RexEventType;
  source: string;
  agentId?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type EventFilter = {
  type?: RexEventType;
  agentId?: string;
  since?: number;
  until?: number;
  limit?: number;
};

type StoredEvent = {
  id: number;
  timestamp: number;
  type: string;
  source: string;
  agent_id: string | null;
  message: string;
  metadata_json: string | null;
};

// ---------------------------------------------------------------------------
// Database path
// ---------------------------------------------------------------------------

const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "audit.db");

// ---------------------------------------------------------------------------
// Schema + connection
// ---------------------------------------------------------------------------

async function ensureDbDir(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      INTEGER NOT NULL,
      type           TEXT NOT NULL,
      source         TEXT NOT NULL,
      agent_id       TEXT,
      message        TEXT NOT NULL,
      metadata_json  TEXT
    );
  `);
  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log (type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log (agent_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (timestamp);`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a structured event to the central audit_log table.
 */
export async function logEvent(event: RexEvent): Promise<void> {
  try {
    await ensureDbDir();
    const db = openDb();
    ensureSchema(db);

    const stmt = db.prepare(`
      INSERT INTO audit_log (timestamp, type, source, agent_id, message, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.timestamp,
      event.type,
      event.source,
      event.agentId ?? null,
      event.message,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );

    db.close();
  } catch (err) {
    console.error(`[central-log] Failed to log event: ${err}`);
  }
}

/**
 * Query events from the audit_log with optional filters.
 */
export async function queryEvents(filter: EventFilter): Promise<RexEvent[]> {
  try {
    await ensureDbDir();
    const db = openDb();
    ensureSchema(db);

    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter.type) {
      clauses.push("type = ?");
      params.push(filter.type);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.since !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push("timestamp <= ?");
      params.push(filter.until);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;

    const stmt = db.prepare(
      `SELECT id, timestamp, type, source, agent_id, message, metadata_json
       FROM audit_log ${where}
       ORDER BY timestamp DESC
       LIMIT ?`,
    );

    const rows = stmt.all(...params, limit) as StoredEvent[];
    db.close();

    return rows.map((row) => ({
      timestamp: row.timestamp,
      type: row.type as RexEventType,
      source: row.source,
      agentId: row.agent_id ?? undefined,
      message: row.message,
      metadata: row.metadata_json
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : undefined,
    }));
  } catch (err) {
    console.error(`[central-log] Failed to query events: ${err}`);
    return [];
  }
}
