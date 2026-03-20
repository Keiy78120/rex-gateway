// ============================================================================
// Two-phase memory ingestion with lockfile protection
// ============================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { getDb, getDbPath, type MemoryRow } from "./db.js";
import { embeddingToBuffer, generateEmbedding } from "./embed.js";

// ============================================================================
// Types
// ============================================================================

export type IngestMeta = {
  scope: string;
  agentId?: string;
  category?: string;
  source: string;
};

// ============================================================================
// Constants
// ============================================================================

const LOCKFILE_NAME = ".rex-memory-ingest.lock";
const LOCKFILE_STALE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_BATCH_SIZE = 30;
const EMBED_DELAY_MS = 500;

// ============================================================================
// Lockfile management
// ============================================================================

function getLockfilePath(): string {
  return join(dirname(getDbPath()), LOCKFILE_NAME);
}

function acquireLock(): boolean {
  const lockPath = getLockfilePath();

  // Check for stale lock
  if (fs.existsSync(lockPath)) {
    try {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > LOCKFILE_STALE_MS) {
        // Stale lock — remove it
        fs.unlinkSync(lockPath);
      } else {
        // Active lock — skip
        return false;
      }
    } catch {
      // Ignore stat errors
    }
  }

  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), {
      flag: "wx",
    });
    return true;
  } catch {
    // Another process got the lock
    return false;
  }
}

function releaseLock(): void {
  const lockPath = getLockfilePath();
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already released
  }
}

// ============================================================================
// Phase 1: Add to pending queue (instant, no embedding)
// ============================================================================

export function addPending(content: string, metadata: IngestMeta): number {
  const db = getDb();

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("rex-memory: cannot ingest empty content");
  }

  const stmt = db.prepare(`
    INSERT INTO pending_ingest (content, scope, agent_id, category, source)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    trimmed,
    metadata.scope,
    metadata.agentId ?? null,
    metadata.category ?? null,
    metadata.source,
  );

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (action, agent_id, details)
    VALUES ('pending_add', ?, ?)
  `).run(metadata.agentId ?? null, `source=${metadata.source}, scope=${metadata.scope}`);

  return Number(result.lastInsertRowid);
}

// ============================================================================
// Phase 2: Process pending — embed and move to memories
// ============================================================================

export async function processPending(
  batchSize: number = DEFAULT_BATCH_SIZE,
  embeddingOptions?: { ollamaUrl?: string; model?: string },
): Promise<{ processed: number; errors: number }> {
  if (!acquireLock()) {
    return { processed: 0, errors: 0 };
  }

  let processed = 0;
  let errors = 0;

  try {
    const db = getDb();

    const pending = db
      .prepare(
        `
      SELECT id, content, scope, agent_id, category, source, created_at
      FROM pending_ingest
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(batchSize) as Array<{
      id: number;
      content: string;
      scope: string;
      agent_id: string | null;
      category: string | null;
      source: string | null;
      created_at: string;
    }>;

    if (pending.length === 0) {
      return { processed: 0, errors: 0 };
    }

    const insertMemory = db.prepare(`
      INSERT INTO memories (id, content, scope, agent_id, category, embedding, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const deletePending = db.prepare(`
      DELETE FROM pending_ingest WHERE id = ?
    `);

    const auditInsert = db.prepare(`
      INSERT INTO audit_log (action, memory_id, agent_id, details)
      VALUES ('ingest', ?, ?, ?)
    `);

    for (const row of pending) {
      try {
        const embedding = await generateEmbedding(row.content, embeddingOptions);
        const embeddingBuf = embeddingToBuffer(embedding);
        const memoryId = randomUUID();

        const transaction = db.transaction(() => {
          insertMemory.run(
            memoryId,
            row.content,
            row.scope,
            row.agent_id,
            row.category,
            embeddingBuf,
            row.source,
            row.created_at,
          );
          deletePending.run(row.id);
          auditInsert.run(memoryId, row.agent_id, `source=${row.source ?? "unknown"}`);
        });

        transaction();
        processed++;

        // Throttle between embeddings
        if (processed < pending.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, EMBED_DELAY_MS));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`rex-memory: failed to process pending entry ${row.id}: ${message}`);
        errors++;
      }
    }
  } finally {
    releaseLock();
  }

  return { processed, errors };
}

// ============================================================================
// Direct ingest (skip pending, embed immediately)
// ============================================================================

export async function ingestDirect(
  content: string,
  metadata: IngestMeta,
  embeddingOptions?: { ollamaUrl?: string; model?: string },
): Promise<MemoryRow> {
  const db = getDb();

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("rex-memory: cannot ingest empty content");
  }

  const embedding = await generateEmbedding(trimmed, embeddingOptions);
  const embeddingBuf = embeddingToBuffer(embedding);
  const memoryId = randomUUID();

  const stmt = db.prepare(`
    INSERT INTO memories (id, content, scope, agent_id, category, embedding, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    memoryId,
    trimmed,
    metadata.scope,
    metadata.agentId ?? null,
    metadata.category ?? null,
    embeddingBuf,
    metadata.source,
  );

  // Audit log
  db.prepare(`
    INSERT INTO audit_log (action, memory_id, agent_id, details)
    VALUES ('ingest_direct', ?, ?, ?)
  `).run(memoryId, metadata.agentId ?? null, `source=${metadata.source}`);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow;
}

// ============================================================================
// Stats
// ============================================================================

export function getPendingCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM pending_ingest").get() as {
    count: number;
  };
  return row.count;
}

export function getMemoryCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
  return row.count;
}
