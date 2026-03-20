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

export type RuleManifestEntry = {
  filename: string;
  hash: string;
  size: number;
  mtime: number;
};

export type RuleDiff = {
  added: string[];
  changed: string[];
  removed: string[];
};

type SyncResult = {
  ok: boolean;
  host: string;
  pushed: number;
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

const RULES_DIR = path.join(os.homedir(), ".claude", "rules");
const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "cc-bridge.db");

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_rules_sync (
      filename   TEXT NOT NULL,
      hash       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime      INTEGER NOT NULL,
      device     TEXT NOT NULL DEFAULT 'local',
      synced_at  INTEGER NOT NULL,
      PRIMARY KEY (filename, device)
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
 * Build a manifest of all .md rule files with content hashes.
 */
export async function getRulesManifest(): Promise<RuleManifestEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(RULES_DIR);
  } catch {
    console.warn(`[cc-bridge/rules] Rules directory not found: ${RULES_DIR}`);
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const manifest: RuleManifestEntry[] = [];

  for (const filename of mdFiles) {
    const filePath = path.join(RULES_DIR, filename);
    try {
      const [stat, content] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
      manifest.push({
        filename,
        hash: md5(content),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
      });
    } catch (err) {
      console.warn(`[cc-bridge/rules] Failed to read ${filename}: ${err}`);
    }
  }

  return manifest;
}

/**
 * Compare local manifest against a remote manifest and return differences.
 */
export function diffRules(local: RuleManifestEntry[], remote: RuleManifestEntry[]): RuleDiff {
  const remoteMap = new Map(remote.map((r) => [r.filename, r]));
  const localMap = new Map(local.map((l) => [l.filename, l]));

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const entry of local) {
    const remoteEntry = remoteMap.get(entry.filename);
    if (!remoteEntry) {
      added.push(entry.filename);
    } else if (remoteEntry.hash !== entry.hash) {
      changed.push(entry.filename);
    }
  }

  for (const entry of remote) {
    if (!localMap.has(entry.filename)) {
      removed.push(entry.filename);
    }
  }

  return { added, changed, removed };
}

/**
 * Sync rules to a target device via rsync over SSH.
 * Brain VPS is source of truth — one-way push.
 */
export async function syncRules(targetHost: string): Promise<SyncResult> {
  const host = resolveHost(targetHost);
  const result: SyncResult = { ok: false, host, pushed: 0, errors: [] };

  try {
    await fs.access(RULES_DIR);
  } catch {
    result.errors.push(`Local rules directory does not exist: ${RULES_DIR}`);
    return result;
  }

  const manifest = await getRulesManifest();
  if (manifest.length === 0) {
    result.errors.push("No rule files found to sync");
    return result;
  }

  console.log(`[cc-bridge/rules] Syncing ${manifest.length} rules to ${targetHost} (${host})`);

  // rsync with SSH — trailing slash on source syncs contents into target dir
  const rsyncArgs = [
    "-avz",
    "--delete",
    "-e",
    "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
    `${RULES_DIR}/`,
    `${host}:~/.claude/rules/`,
  ];

  const { code, stderr } = await runCommand("rsync", rsyncArgs, 30_000);

  if (code !== 0) {
    result.errors.push(`rsync failed (code ${code}): ${stderr.trim()}`);
    console.error(`[cc-bridge/rules] Sync to ${targetHost} failed: ${stderr.trim()}`);
    return result;
  }

  result.ok = true;
  result.pushed = manifest.length;

  // Persist sync record in SQLite
  try {
    const db = openDb();
    ensureSchema(db);

    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cc_rules_sync (filename, hash, size, mtime, device, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const entry of manifest) {
      stmt.run(entry.filename, entry.hash, entry.size, entry.mtime, targetHost, now);
    }

    db.close();
  } catch (err) {
    // Non-fatal — rsync already succeeded
    console.warn(`[cc-bridge/rules] Failed to persist sync record: ${err}`);
  }

  console.log(`[cc-bridge/rules] Successfully synced ${manifest.length} rules to ${targetHost}`);
  return result;
}
