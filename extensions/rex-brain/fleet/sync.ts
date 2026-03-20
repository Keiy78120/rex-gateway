import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FleetNode } from "./mesh.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncItemType = "rules" | "guards" | "skills" | "memory";

export interface SyncItem {
  type: SyncItemType;
  path: string;
  hash: string;
}

export interface SyncResult {
  success: boolean;
  itemsSynced: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSH_TIMEOUT_MS = 30_000;
const RSYNC_TIMEOUT_S = 60;

// Rsync flags: archive, compress, delete stale files, partial for resume
const RSYNC_BASE_ARGS = [
  "-az",
  "--delete",
  "--partial",
  "--timeout",
  String(RSYNC_TIMEOUT_S),
  "-e",
  "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: SSH_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr?.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Compute SHA-256 hash of a local file.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Build the SSH user@host string for a fleet node.
 * VPS uses root, others use the current user.
 */
function sshTarget(node: FleetNode): string {
  const user = node.role === "vps" ? "root" : (process.env.USER ?? "keiy");
  return `${user}@${node.ip}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push config/data items to a remote fleet node via rsync over SSH.
 * Each SyncItem is rsynced individually to its remote path.
 *
 * Conflict resolution: brain (VPS) always wins. If the target is the VPS
 * and the source is not, the operation is skipped (VPS is authoritative).
 */
export async function syncToNode(node: FleetNode, items: SyncItem[]): Promise<SyncResult> {
  const result: SyncResult = { success: true, itemsSynced: 0, errors: [] };

  if (items.length === 0) {
    return result;
  }

  const target = sshTarget(node);

  for (const item of items) {
    try {
      const remotePath = `${target}:${item.path}`;
      await runCommand("rsync", [...RSYNC_BASE_ARGS, item.path, remotePath]);
      result.itemsSynced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`sync ${item.type} (${item.path}): ${message}`);
      result.success = false;
    }
  }

  return result;
}

/**
 * Pull specific items from a remote fleet node via rsync over SSH.
 *
 * @param node - Source fleet node to pull from
 * @param remotePaths - Remote file/directory paths to pull
 * @param localBasePath - Local directory to place pulled items
 */
export async function pullFromNode(
  node: FleetNode,
  remotePaths: string[],
  localBasePath: string,
): Promise<SyncResult> {
  const result: SyncResult = { success: true, itemsSynced: 0, errors: [] };

  if (remotePaths.length === 0) {
    return result;
  }

  // Conflict resolution: VPS (brain) is authoritative — always safe to pull from
  const target = sshTarget(node);

  for (const remotePath of remotePaths) {
    try {
      const source = `${target}:${remotePath}`;
      await runCommand("rsync", [...RSYNC_BASE_ARGS, source, localBasePath]);
      result.itemsSynced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`pull ${remotePath}: ${message}`);
      result.success = false;
    }
  }

  return result;
}

/**
 * Check if a remote node is reachable via SSH (fast connection test).
 */
export async function testSshConnection(node: FleetNode): Promise<boolean> {
  try {
    const target = sshTarget(node);
    await runCommand("ssh", [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=5",
      target,
      "echo",
      "ok",
    ]);
    return true;
  } catch {
    return false;
  }
}
