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

export type SkillManifestEntry = {
  skillName: string;
  skillDir: string;
  hash: string;
  size: number;
  mtime: number;
};

type SkillSyncResult = {
  ok: boolean;
  host: string;
  pushed: number;
  errors: string[];
};

type SingleSkillDeployResult = {
  ok: boolean;
  host: string;
  skillName: string;
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

const SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "cc-bridge.db");

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_skills_sync (
      skill_name TEXT NOT NULL,
      hash       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      device     TEXT NOT NULL DEFAULT 'local',
      synced_at  INTEGER NOT NULL,
      PRIMARY KEY (skill_name, device)
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
 * Build a manifest of all skills by finding SKILL.md files in subdirectories.
 * Each skill is a directory under ~/.claude/skills/ containing a SKILL.md.
 */
export async function getSkillsManifest(): Promise<SkillManifestEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch {
    console.warn(`[cc-bridge/skills] Skills directory not found: ${SKILLS_DIR}`);
    return [];
  }

  const manifest: SkillManifestEntry[] = [];

  for (const dirName of entries) {
    const skillDir = path.join(SKILLS_DIR, dirName);
    const skillMd = path.join(skillDir, "SKILL.md");

    try {
      const dirStat = await fs.stat(skillDir);
      if (!dirStat.isDirectory()) continue;

      const [stat, content] = await Promise.all([fs.stat(skillMd), fs.readFile(skillMd)]);
      manifest.push({
        skillName: dirName,
        skillDir: dirName,
        hash: md5(content),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
      });
    } catch {
      // No SKILL.md in this dir — skip silently
    }
  }

  return manifest;
}

/**
 * Sync all skills to a target device via rsync over SSH.
 * Brain VPS is source of truth — one-way push.
 */
export async function syncSkills(targetHost: string): Promise<SkillSyncResult> {
  const host = resolveHost(targetHost);
  const result: SkillSyncResult = { ok: false, host, pushed: 0, errors: [] };

  try {
    await fs.access(SKILLS_DIR);
  } catch {
    result.errors.push(`Local skills directory does not exist: ${SKILLS_DIR}`);
    return result;
  }

  const manifest = await getSkillsManifest();
  if (manifest.length === 0) {
    result.errors.push("No skills found to sync");
    return result;
  }

  console.log(`[cc-bridge/skills] Syncing ${manifest.length} skills to ${targetHost} (${host})`);

  // rsync entire skills/ tree — trailing slash on source syncs contents
  const rsyncArgs = [
    "-avz",
    "--delete",
    "-e",
    "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
    `${SKILLS_DIR}/`,
    `${host}:~/.claude/skills/`,
  ];

  const { code, stderr } = await runCommand("rsync", rsyncArgs, 60_000);

  if (code !== 0) {
    result.errors.push(`rsync failed (code ${code}): ${stderr.trim()}`);
    console.error(`[cc-bridge/skills] Sync to ${targetHost} failed: ${stderr.trim()}`);
    return result;
  }

  result.ok = true;
  result.pushed = manifest.length;

  // Persist sync records
  try {
    const db = openDb();
    ensureSchema(db);

    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO cc_skills_sync (skill_name, hash, size, device, synced_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const entry of manifest) {
      stmt.run(entry.skillName, entry.hash, entry.size, targetHost, now);
    }

    db.close();
  } catch (err) {
    console.warn(`[cc-bridge/skills] Failed to persist sync record: ${err}`);
  }

  console.log(`[cc-bridge/skills] Successfully synced ${manifest.length} skills to ${targetHost}`);
  return result;
}

/**
 * Deploy a single skill to a target device via scp over SSH.
 */
export async function deploySkill(
  skillName: string,
  targetHost: string,
): Promise<SingleSkillDeployResult> {
  const host = resolveHost(targetHost);
  const result: SingleSkillDeployResult = { ok: false, host, skillName, errors: [] };

  const skillDir = path.join(SKILLS_DIR, skillName);
  const skillMd = path.join(skillDir, "SKILL.md");

  try {
    await fs.access(skillMd);
  } catch {
    result.errors.push(`Skill not found: ${skillName} (expected ${skillMd})`);
    return result;
  }

  console.log(`[cc-bridge/skills] Deploying skill "${skillName}" to ${targetHost} (${host})`);

  // Ensure remote skill dir exists, then rsync just this skill
  const rsyncArgs = [
    "-avz",
    "-e",
    "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
    `${skillDir}/`,
    `${host}:~/.claude/skills/${skillName}/`,
  ];

  const { code, stderr } = await runCommand("rsync", rsyncArgs, 30_000);

  if (code !== 0) {
    result.errors.push(`rsync failed (code ${code}): ${stderr.trim()}`);
    console.error(
      `[cc-bridge/skills] Deploy "${skillName}" to ${targetHost} failed: ${stderr.trim()}`,
    );
    return result;
  }

  result.ok = true;

  // Persist sync record for this single skill
  try {
    const db = openDb();
    ensureSchema(db);

    const content = await fs.readFile(skillMd);
    const stat = await fs.stat(skillMd);

    db.prepare(`
      INSERT OR REPLACE INTO cc_skills_sync (skill_name, hash, size, device, synced_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(skillName, md5(content), stat.size, targetHost, Date.now());

    db.close();
  } catch (err) {
    console.warn(`[cc-bridge/skills] Failed to persist deploy record: ${err}`);
  }

  console.log(`[cc-bridge/skills] Successfully deployed skill "${skillName}" to ${targetHost}`);
  return result;
}
