// ============================================================================
// Sync memory between agents (brain VPS = source of truth)
// ============================================================================

import { getDb, type MemoryRow, type SyncStateRow } from "./db.js";
import { embeddingToBuffer } from "./embed.js";

// ============================================================================
// Types
// ============================================================================

type SyncPayload = {
  memories: Array<{
    id: string;
    content: string;
    scope: string;
    agent_id: string | null;
    category: string | null;
    embedding: string | null; // base64-encoded Float32Array
    source: string | null;
    created_at: string;
    updated_at: string;
  }>;
  syncId: string;
  timestamp: string;
};

type SyncResult = {
  pushed: number;
  pulled: number;
  conflicts: number;
};

// ============================================================================
// Sync state management
// ============================================================================

function getSyncState(agentId: string): SyncStateRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM sync_state WHERE agent_id = ?").get(agentId) as
      | SyncStateRow
      | undefined) ?? null
  );
}

function updateSyncState(agentId: string, syncId: string): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO sync_state (agent_id, last_sync_id, last_sync_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      last_sync_id = excluded.last_sync_id,
      last_sync_at = excluded.last_sync_at
  `,
  ).run(agentId, syncId);
}

// ============================================================================
// Push scoped memories to an agent
// ============================================================================

export function getMemoriesForAgent(agentId: string, scope: string, sinceId?: string): MemoryRow[] {
  const db = getDb();

  if (sinceId) {
    // Get memories created after the given sync point
    const sinceRow = db.prepare("SELECT created_at FROM memories WHERE id = ?").get(sinceId) as
      | { created_at: string }
      | undefined;

    if (sinceRow) {
      return db
        .prepare(
          `
        SELECT * FROM memories
        WHERE (scope = 'global' OR scope = ?)
        AND created_at > ?
        ORDER BY created_at ASC
      `,
        )
        .all(scope, sinceRow.created_at) as MemoryRow[];
    }
  }

  return db
    .prepare(
      `
    SELECT * FROM memories
    WHERE scope = 'global' OR scope = ?
    ORDER BY created_at ASC
  `,
    )
    .all(scope) as MemoryRow[];
}

export async function syncToAgent(
  agentId: string,
  scope: string,
  targetUrl?: string,
): Promise<SyncResult> {
  const syncState = getSyncState(agentId);
  const memories = getMemoriesForAgent(agentId, scope, syncState?.last_sync_id ?? undefined);

  if (memories.length === 0) {
    return { pushed: 0, pulled: 0, conflicts: 0 };
  }

  const payload: SyncPayload = {
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      scope: m.scope,
      agent_id: m.agent_id,
      category: m.category,
      embedding: m.embedding ? m.embedding.toString("base64") : null,
      source: m.source,
      created_at: m.created_at,
      updated_at: m.updated_at,
    })),
    syncId: memories[memories.length - 1].id,
    timestamp: new Date().toISOString(),
  };

  if (targetUrl) {
    try {
      const response = await fetch(`${targetUrl}/api/memory/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(`Sync push failed (${response.status}): ${errorText}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`rex-memory: sync to ${agentId} failed: ${message}`);
      return { pushed: 0, pulled: 0, conflicts: 0 };
    }
  }

  // Update sync state
  updateSyncState(agentId, payload.syncId);

  // Audit
  const db = getDb();
  db.prepare(
    `
    INSERT INTO audit_log (action, agent_id, details)
    VALUES ('sync_push', ?, ?)
  `,
  ).run(agentId, `pushed=${memories.length}, scope=${scope}`);

  return { pushed: memories.length, pulled: 0, conflicts: 0 };
}

// ============================================================================
// Pull from brain VPS (source of truth)
// ============================================================================

export async function syncFromBrain(brainUrl: string): Promise<SyncResult> {
  const db = getDb();

  // Get our last sync state for the brain
  const syncState = getSyncState("brain");
  const sinceParam = syncState?.last_sync_id ? `?since=${syncState.last_sync_id}` : "";

  let payload: SyncPayload;
  try {
    const response = await fetch(`${brainUrl}/api/memory/export${sinceParam}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`Sync pull failed (${response.status}): ${errorText}`);
    }

    payload = (await response.json()) as SyncPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`rex-memory: sync from brain failed: ${message}`);
    return { pushed: 0, pulled: 0, conflicts: 0 };
  }

  if (!payload.memories || payload.memories.length === 0) {
    return { pushed: 0, pulled: 0, conflicts: 0 };
  }

  let pulled = 0;
  let conflicts = 0;

  const upsertStmt = db.prepare(`
    INSERT INTO memories (id, content, scope, agent_id, category, embedding, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      scope = excluded.scope,
      agent_id = excluded.agent_id,
      category = excluded.category,
      embedding = excluded.embedding,
      source = excluded.source,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > memories.updated_at
  `);

  const transaction = db.transaction(() => {
    for (const mem of payload.memories) {
      let embeddingBuf: Buffer | null = null;
      if (mem.embedding) {
        try {
          const decoded = Buffer.from(mem.embedding, "base64");
          // Validate it's a valid Float32Array size (multiple of 4)
          if (decoded.length % 4 === 0) {
            embeddingBuf = decoded;
          }
        } catch {
          // Invalid base64 — skip embedding
        }
      }

      // Check for conflicts (local memory newer than brain)
      const existing = db.prepare("SELECT updated_at FROM memories WHERE id = ?").get(mem.id) as
        | { updated_at: string }
        | undefined;

      if (existing && existing.updated_at > mem.updated_at) {
        // Brain VPS is source of truth — overwrite anyway
        conflicts++;
      }

      const result = upsertStmt.run(
        mem.id,
        mem.content,
        mem.scope,
        mem.agent_id,
        mem.category,
        embeddingBuf,
        mem.source,
        mem.created_at,
        mem.updated_at,
      );

      if (result.changes > 0) {
        pulled++;
      }
    }
  });

  transaction();

  // Update sync state
  updateSyncState("brain", payload.syncId);

  // Audit
  db.prepare(
    `
    INSERT INTO audit_log (action, agent_id, details)
    VALUES ('sync_pull', 'brain', ?)
  `,
  ).run(`pulled=${pulled}, conflicts=${conflicts}`);

  return { pushed: 0, pulled, conflicts };
}

// ============================================================================
// Import memories from sync payload (for receiving pushes)
// ============================================================================

export function importSyncPayload(payload: SyncPayload): { imported: number; skipped: number } {
  const db = getDb();
  let imported = 0;
  let skipped = 0;

  const upsertStmt = db.prepare(`
    INSERT INTO memories (id, content, scope, agent_id, category, embedding, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      scope = excluded.scope,
      category = excluded.category,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > memories.updated_at
  `);

  const transaction = db.transaction(() => {
    for (const mem of payload.memories) {
      let embeddingBuf: Buffer | null = null;
      if (mem.embedding) {
        try {
          embeddingBuf = Buffer.from(mem.embedding, "base64");
        } catch {
          // skip
        }
      }

      const result = upsertStmt.run(
        mem.id,
        mem.content,
        mem.scope,
        mem.agent_id,
        mem.category,
        embeddingBuf,
        mem.source,
        mem.created_at,
        mem.updated_at,
      );

      if (result.changes > 0) {
        imported++;
      } else {
        skipped++;
      }
    }
  });

  transaction();
  return { imported, skipped };
}
