import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = "active" | "stale" | "stopped" | "unknown";

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  scope: string;
  containerId: string;
  status: AgentStatus;
  lastHeartbeat: string;
  vps: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without heartbeat = STALE
const DB_DIR = join(homedir(), ".rex-memory");
const DB_PATH = join(DB_DIR, "fleet.db");

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (_db) {
    return _db;
  }

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      scope TEXT NOT NULL,
      container_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_heartbeat TEXT NOT NULL,
      vps TEXT NOT NULL
    );
  `);

  return _db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  name: string;
  model: string;
  scope: string;
  container_id: string;
  status: string;
  last_heartbeat: string;
  vps: string;
}

function rowToAgentInfo(row: AgentRow): AgentInfo {
  let status: AgentStatus = (row.status as AgentStatus) || "unknown";

  // Check staleness based on heartbeat
  if (status === "active") {
    const lastBeat = new Date(row.last_heartbeat).getTime();
    if (!Number.isNaN(lastBeat) && Date.now() - lastBeat > STALE_THRESHOLD_MS) {
      status = "stale";
    }
  }

  return {
    id: row.id,
    name: row.name,
    model: row.model,
    scope: row.scope,
    containerId: row.container_id,
    status,
    lastHeartbeat: row.last_heartbeat,
    vps: row.vps,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new agent in the registry.
 * If an agent with the same ID already exists, it is updated.
 */
export function registerAgent(agent: AgentInfo): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_registry (id, name, model, scope, container_id, status, last_heartbeat, vps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       model = excluded.model,
       scope = excluded.scope,
       container_id = excluded.container_id,
       status = excluded.status,
       last_heartbeat = excluded.last_heartbeat,
       vps = excluded.vps`,
  ).run(
    agent.id,
    agent.name,
    agent.model,
    agent.scope,
    agent.containerId,
    agent.status,
    agent.lastHeartbeat,
    agent.vps,
  );
}

/**
 * Get all registered agents with staleness check applied.
 */
export function getAgents(): AgentInfo[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_registry ORDER BY name ASC").all() as AgentRow[];
  return rows.map(rowToAgentInfo);
}

/**
 * Get a specific agent by ID. Returns null if not found.
 */
export function getAgent(id: string): AgentInfo | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_registry WHERE id = ?").get(id) as
    | AgentRow
    | undefined;

  if (!row) {
    return null;
  }
  return rowToAgentInfo(row);
}

/**
 * Update heartbeat timestamp for an agent, marking it as alive.
 * Also sets status to "active" if it was stale/unknown.
 */
export function updateHeartbeat(id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE agent_registry SET last_heartbeat = ?, status = 'active' WHERE id = ?")
    .run(now, id);
  return result.changes > 0;
}

/**
 * Set the status of an agent explicitly.
 */
export function setAgentStatus(id: string, status: AgentStatus): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE agent_registry SET status = ? WHERE id = ?").run(status, id);
  return result.changes > 0;
}

/**
 * Remove an agent from the registry.
 */
export function unregisterAgent(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM agent_registry WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Get all agents that haven't sent a heartbeat within the threshold.
 */
export function getStaleAgents(): AgentInfo[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM agent_registry WHERE status = 'active'")
    .all() as AgentRow[];

  const stale: AgentInfo[] = [];
  const cutoff = Date.now() - STALE_THRESHOLD_MS;

  for (const row of rows) {
    const lastBeat = new Date(row.last_heartbeat).getTime();
    if (!Number.isNaN(lastBeat) && lastBeat < cutoff) {
      stale.push(rowToAgentInfo(row));
    }
  }

  return stale;
}

/**
 * Mark all stale agents in the database.
 * Returns the number of agents marked as stale.
 */
export function markStaleAgents(): number {
  const db = getDb();
  const cutoffDate = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const result = db
    .prepare(
      "UPDATE agent_registry SET status = 'stale' WHERE status = 'active' AND last_heartbeat < ?",
    )
    .run(cutoffDate);
  return result.changes;
}

/**
 * Get a summary of the registry for display.
 */
export function getRegistrySummary(): {
  total: number;
  active: number;
  stale: number;
  stopped: number;
} {
  const agents = getAgents();
  return {
    total: agents.length,
    active: agents.filter((a) => a.status === "active").length,
    stale: agents.filter((a) => a.status === "stale").length,
    stopped: agents.filter((a) => a.status === "stopped").length,
  };
}
