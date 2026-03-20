import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  hostname: string;
  os: string;
  cpu: string;
  gpu: string;
  ram: string;
  tailscaleIp: string;
}

export interface PairingResult {
  success: boolean;
  deviceId: string;
  message: string;
}

interface InviteRow {
  code: string;
  created_at: string;
  expires_at: string;
  used: number;
}

interface DeviceRow {
  id: string;
  hostname: string;
  os: string;
  cpu: string;
  gpu: string;
  ram: string;
  tailscale_ip: string;
  invite_code: string;
  paired_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVITE_CODE_LENGTH = 8;
const INVITE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
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
    CREATE TABLE IF NOT EXISTS fleet_invite_codes (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS fleet_devices (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      os TEXT NOT NULL,
      cpu TEXT NOT NULL,
      gpu TEXT NOT NULL,
      ram TEXT NOT NULL,
      tailscale_ip TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      FOREIGN KEY (invite_code) REFERENCES fleet_invite_codes(code)
    );
  `);

  return _db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a short alphanumeric invite code for `rex join`.
 * Code is valid for 15 minutes.
 */
export function generateInviteCode(): string {
  const db = getDb();
  const code = randomBytes(INVITE_CODE_LENGTH)
    .toString("base64url")
    .slice(0, INVITE_CODE_LENGTH)
    .toUpperCase();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_EXPIRY_MS);

  db.prepare(
    "INSERT INTO fleet_invite_codes (code, created_at, expires_at, used) VALUES (?, ?, ?, 0)",
  ).run(code, now.toISOString(), expiresAt.toISOString());

  return code;
}

/**
 * Validate an invite code: must exist, not expired, not already used.
 */
export function validateInviteCode(code: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM fleet_invite_codes WHERE code = ?")
    .get(code.toUpperCase()) as InviteRow | undefined;

  if (!row) {
    return false;
  }
  if (row.used !== 0) {
    return false;
  }
  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    return false;
  }
  return true;
}

/**
 * Pair a device using a valid invite code.
 * On success: marks invite as used, stores device in fleet_devices,
 * and returns a pairing result with next steps.
 */
export function pairDevice(code: string, deviceInfo: DeviceInfo): PairingResult {
  const upperCode = code.toUpperCase();

  if (!validateInviteCode(upperCode)) {
    return {
      success: false,
      deviceId: "",
      message: "Invalid or expired invite code.",
    };
  }

  const db = getDb();
  const deviceId = randomBytes(16).toString("hex");
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    // Mark invite as used
    db.prepare("UPDATE fleet_invite_codes SET used = 1 WHERE code = ?").run(upperCode);

    // Insert device
    db.prepare(
      `INSERT INTO fleet_devices (id, hostname, os, cpu, gpu, ram, tailscale_ip, invite_code, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deviceId,
      deviceInfo.hostname,
      deviceInfo.os,
      deviceInfo.cpu,
      deviceInfo.gpu,
      deviceInfo.ram,
      deviceInfo.tailscaleIp,
      upperCode,
      now,
    );
  });

  txn();

  return {
    success: true,
    deviceId,
    message: `Device ${deviceInfo.hostname} paired successfully. Rules, guards, and skills will be synced.`,
  };
}

/**
 * List all paired devices from the fleet.
 */
export function listPairedDevices(): DeviceRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM fleet_devices ORDER BY paired_at DESC").all() as DeviceRow[];
}

/**
 * Remove a paired device by its ID.
 */
export function unpairDevice(deviceId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM fleet_devices WHERE id = ?").run(deviceId);
  return result.changes > 0;
}

/**
 * Clean up expired invite codes (housekeeping).
 */
export function cleanupExpiredInvites(): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM fleet_invite_codes WHERE used = 0 AND expires_at < ?")
    .run(new Date().toISOString());
  return result.changes;
}
