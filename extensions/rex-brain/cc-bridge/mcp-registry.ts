import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db-helper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  scope: string;
};

type McpSettingsJson = {
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
  [key: string]: unknown;
};

type DeployResult = {
  ok: boolean;
  host: string;
  serversDeployed: string[];
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

const DB_PATH = path.join(os.homedir(), ".claude", "rex-brain", "cc-bridge.db");

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  return openDatabase(DB_PATH);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_mcp_registry (
      name    TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      args    TEXT NOT NULL,
      env     TEXT NOT NULL,
      scope   TEXT NOT NULL DEFAULT 'global'
    );
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function sshExec(
  host: string,
  remoteCmd: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand(
    "ssh",
    ["-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=no", host, remoteCmd],
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an MCP server in the central registry.
 */
export function registerMcpServer(config: McpServerConfig): void {
  const db = openDb();
  ensureSchema(db);

  db.prepare(`
    INSERT OR REPLACE INTO cc_mcp_registry (name, command, args, env, scope)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    config.name,
    config.command,
    JSON.stringify(config.args),
    JSON.stringify(config.env),
    config.scope,
  );

  db.close();
  console.log(`[cc-bridge/mcp] Registered MCP server: ${config.name} (scope: ${config.scope})`);
}

/**
 * List registered MCP servers, optionally filtered by scope.
 */
export function getMcpServers(scope?: string): McpServerConfig[] {
  const db = openDb();
  ensureSchema(db);

  type Row = { name: string; command: string; args: string; env: string; scope: string };
  let rows: Row[];

  if (scope) {
    rows = db.prepare("SELECT * FROM cc_mcp_registry WHERE scope = ?").all(scope) as Row[];
  } else {
    rows = db.prepare("SELECT * FROM cc_mcp_registry").all() as Row[];
  }

  db.close();

  return rows.map((row) => ({
    name: row.name,
    command: row.command,
    args: JSON.parse(row.args) as string[],
    env: JSON.parse(row.env) as Record<string, string>,
    scope: row.scope,
  }));
}

/**
 * Build a CC-compatible mcpServers block from registry entries.
 */
function buildMcpBlock(servers: McpServerConfig[]): NonNullable<McpSettingsJson["mcpServers"]> {
  const block: NonNullable<McpSettingsJson["mcpServers"]> = {};

  for (const server of servers) {
    block[server.name] = {
      command: server.command,
      ...(server.args.length > 0 ? { args: server.args } : {}),
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }

  return block;
}

/**
 * Deploy MCP config to a target device's CC settings.json.
 * Merges with existing mcpServers — never overwrites unrelated keys.
 */
export async function deployMcpConfig(targetHost: string): Promise<DeployResult> {
  const host = resolveHost(targetHost);
  const result: DeployResult = { ok: false, host, serversDeployed: [], errors: [] };

  const servers = getMcpServers();
  if (servers.length === 0) {
    result.errors.push("No MCP servers registered in the registry");
    return result;
  }

  console.log(`[cc-bridge/mcp] Deploying ${servers.length} MCP servers to ${targetHost} (${host})`);

  // Read existing settings.json from target via SSH
  const {
    code: readCode,
    stdout: remoteContent,
    stderr: readErr,
  } = await sshExec(host, "cat ~/.claude/settings.json 2>/dev/null || echo '{}'");

  if (readCode !== 0) {
    result.errors.push(`Failed to read remote settings.json: ${readErr.trim()}`);
    return result;
  }

  let existingSettings: McpSettingsJson;
  try {
    existingSettings = JSON.parse(remoteContent.trim()) as McpSettingsJson;
  } catch {
    // If parse fails, start fresh but preserve the raw content warning
    console.warn(
      "[cc-bridge/mcp] Could not parse remote settings.json, starting with empty object",
    );
    existingSettings = {};
  }

  // Merge: keep existing mcpServers, overlay ours
  const existingMcp = existingSettings.mcpServers ?? {};
  const newMcp = buildMcpBlock(servers);
  const mergedMcp = { ...existingMcp, ...newMcp };

  const mergedSettings: McpSettingsJson = {
    ...existingSettings,
    mcpServers: mergedMcp,
  };

  const settingsJson = JSON.stringify(mergedSettings, null, 2);

  // Write merged settings to target via SSH
  // Use a heredoc-style approach to avoid shell escaping issues
  const escapedJson = settingsJson.replace(/'/g, "'\\''");
  const writeCmd = `mkdir -p ~/.claude && printf '%s' '${escapedJson}' > ~/.claude/settings.json`;

  const { code: writeCode, stderr: writeErr } = await sshExec(host, writeCmd, 20_000);

  if (writeCode !== 0) {
    result.errors.push(`Failed to write remote settings.json: ${writeErr.trim()}`);
    return result;
  }

  result.ok = true;
  result.serversDeployed = servers.map((s) => s.name);
  console.log(
    `[cc-bridge/mcp] Successfully deployed ${servers.length} MCP servers to ${targetHost}: ${result.serversDeployed.join(", ")}`,
  );

  return result;
}
