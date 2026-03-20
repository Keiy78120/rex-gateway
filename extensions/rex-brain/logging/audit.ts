import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db-helper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditEntry = {
  timestamp: number;
  actor: string;
  action: string;
  resource: string;
  scope: string;
  result: string;
};

type StoredAuditRow = {
  id: number;
  timestamp: number;
  actor: string;
  action: string;
  resource: string;
  scope: string;
  result: string;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "audit.db");

async function ensureDbDir(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
}

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_trail (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  INTEGER NOT NULL,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource   TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'global',
      result     TEXT NOT NULL DEFAULT 'ok',
      reason     TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_trail_actor ON audit_trail (actor);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_trail_ts ON audit_trail (timestamp);`);
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function insertAudit(
  actor: string,
  action: string,
  resource: string,
  scope: string,
  result: string,
  reason: string | null,
): Promise<void> {
  try {
    await ensureDbDir();
    const db = openDb();
    ensureSchema(db);

    const stmt = db.prepare(`
      INSERT INTO audit_trail (timestamp, actor, action, resource, scope, result, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(Date.now(), actor, action, resource, scope, result, reason);
    db.close();
  } catch (err) {
    console.error(`[audit] Failed to write audit entry: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a data access event (RGPD: who accessed what, when).
 */
export async function logAccess(who: string, what: string, resource: string): Promise<void> {
  await insertAudit(who, `access:${what}`, resource, "data", "ok", null);
}

/**
 * Log a routing/decision event with justification.
 */
export async function logDecision(who: string, decision: string, reason: string): Promise<void> {
  await insertAudit(who, `decision:${decision}`, "routing", "system", "ok", reason);
}

/**
 * Retrieve audit trail for a specific agent since a given date.
 * Required for multi-tenant data separation proof.
 */
export async function getAuditTrail(agentId: string, since: Date): Promise<AuditEntry[]> {
  try {
    await ensureDbDir();
    const db = openDb();
    ensureSchema(db);

    const stmt = db.prepare(`
      SELECT id, timestamp, actor, action, resource, scope, result, reason
      FROM audit_trail
      WHERE actor = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `);

    const rows = stmt.all(agentId, since.getTime()) as StoredAuditRow[];
    db.close();

    return rows.map((row) => ({
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      resource: row.resource,
      scope: row.scope,
      result: row.result,
    }));
  } catch (err) {
    console.error(`[audit] Failed to query audit trail: ${err}`);
    return [];
  }
}
