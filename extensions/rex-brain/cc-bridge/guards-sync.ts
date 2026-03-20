import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db-helper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardManifestEntry = {
  filename: string;
  hash: string;
  size: number;
  mtime: number;
};

type GuardSyncResult = {
  ok: boolean;
  host: string;
  pushed: number;
  lastSyncedAt: number | null;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Fleet hosts
// ---------------------------------------------------------------------------

const FLEET_HOSTS: Record<string, string> = {
  "rex-mac": "100.112.24.122",
  "rex-pc": "100.91.130.59",
  "rex-vps": "109.176.197.27",
};

const GUARDS_DIR = path.join(os.homedir(), ".claude", "rex-guards");
const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "cc-bridge.db");

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_guards_sync (
      filename   TEXT NOT NULL,
      hash       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime      INTEGER NOT NULL,
      device     TEXT NOT NULL DEFAULT 'local',
      synced_at  INTEGER NOT NULL,
      PRIMARY KEY (filename, device)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_guards_devices (
      device         TEXT PRIMARY KEY,
      last_synced_at INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function md5(content: Buffer): string {
  return createHash("md5").update(content).digest("hex");
}

function resolveHost(targetHost: string): string {
  return FLEET_HOSTS[targetHost] ?? targetHost;
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const exitCode =
        error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({
        code: exitCode,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs + 1000);
    proc.on("close", () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a manifest of all guard scripts in rex-guards/.
 */
export async function getGuardsManifest(): Promise<GuardManifestEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(GUARDS_DIR);
  } catch {
    console.warn(`[cc-bridge/guards] Guards directory not found: ${GUARDS_DIR}`);
    return [];
  }

  const manifest: GuardManifestEntry[] = [];

  for (const filename of entries) {
    const filePath = path.join(GUARDS_DIR, filename);
    try {
      const [stat, content] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
      // Skip directories
      if (!stat.isFile()) continue;
      manifest.push({
        filename,
        hash: md5(content),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
      });
    } catch (err) {
      console.warn(`[cc-bridge/guards] Failed to read ${filename}: ${err}`);
    }
  }

  return manifest;
}

/**
 * Get last sync timestamp for a given device, or null if never synced.
 */
export function getLastSyncTimestamp(device: string): number | null {
  try {
    const db = openDb();
    ensureSchema(db);
    const row = db
      .prepare("SELECT last_synced_at FROM cc_guards_devices WHERE device = ?")
      .get(device) as { last_synced_at: number } | undefined;
    db.close();
    return row?.last_synced_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Sync guards to a target device via rsync over SSH.
 * Brain VPS is source of truth — one-way push.
 */
export async function syncGuards(targetHost: string): Promise<GuardSyncResult> {
  const host = resolveHost(targetHost);
  const result: GuardSyncResult = {
    ok: false,
    host,
    pushed: 0,
    lastSyncedAt: getLastSyncTimestamp(targetHost),
    errors: [],
  };

  try {
    await fs.access(GUARDS_DIR);
  } catch {
    result.errors.push(`Local guards directory does not exist: ${GUARDS_DIR}`);
    return result;
  }

  const manifest = await getGuardsManifest();
  if (manifest.length === 0) {
    result.errors.push("No guard files found to sync");
    return result;
  }

  console.log(`[cc-bridge/guards] Syncing ${manifest.length} guards to ${targetHost} (${host})`);

  // rsync with SSH — trailing slash on source syncs contents into target dir
  const rsyncArgs = [
    "-avz",
    "--delete",
    "-e",
    "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
    `${GUARDS_DIR}/`,
    `${host}:~/.claude/rex-guards/`,
  ];

  const { code, stderr } = await runCommand("rsync", rsyncArgs, 30_000);

  if (code !== 0) {
    result.errors.push(`rsync failed (code ${code}): ${stderr.trim()}`);
    console.error(`[cc-bridge/guards] Sync to ${targetHost} failed: ${stderr.trim()}`);
    return result;
  }

  result.ok = true;
  result.pushed = manifest.length;

  // Persist sync records + device timestamp
  const now = Date.now();
  result.lastSyncedAt = now;

  try {
    const db = openDb();
    ensureSchema(db);

    const fileStmt = db.prepare(`
      INSERT OR REPLACE INTO cc_guards_sync (filename, hash, size, mtime, device, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const entry of manifest) {
      fileStmt.run(entry.filename, entry.hash, entry.size, entry.mtime, targetHost, now);
    }

    db.prepare(`
      INSERT OR REPLACE INTO cc_guards_devices (device, last_synced_at) VALUES (?, ?)
    `).run(targetHost, now);

    db.close();
  } catch (err) {
    console.warn(`[cc-bridge/guards] Failed to persist sync record: ${err}`);
  }

  console.log(`[cc-bridge/guards] Successfully synced ${manifest.length} guards to ${targetHost}`);
  return result;
}
