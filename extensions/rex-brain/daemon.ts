/**
 * Rex Daemon — Background service for OpenClaw registerService
 *
 * Runs cyclic background tasks:
 *  - Health check (every 5min): Ollama, disk, memory DB
 *  - Milo monitor (every 5min): Docker container status, auto-restart
 *  - Fleet mesh health (every 30min): Tailscale node pings
 *  - Memory ingest (every 1h): process pending memory chunks
 *  - Training status (every 6h): check training pipeline
 *
 * Ported from: rex/packages/cli/src/daemon.ts
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "./api.js";

// ── Configuration ────────────────────────────────────────────────────────────

type DaemonConfig = {
  healthIntervalMs: number;
  fleetIntervalMs: number;
  ingestIntervalMs: number;
  trainingIntervalMs: number;
  telegramBotToken: string;
  telegramChatId: string;
  ollamaUrl: string;
  miloContainerName: string;
  tailscaleNodes: string[];
};

const DEFAULT_CONFIG: DaemonConfig = {
  healthIntervalMs: 5 * 60 * 1000, // 5 min
  fleetIntervalMs: 30 * 60 * 1000, // 30 min
  ingestIntervalMs: 60 * 60 * 1000, // 1 hour
  trainingIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  telegramBotToken: process.env.REX_TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.REX_TELEGRAM_CHAT_ID ?? "",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  miloContainerName: "milo-openclaw",
  tailscaleNodes: ["100.112.24.122", "100.91.130.59"],
};

// ── Central log ──────────────────────────────────────────────────────────────

type LogEntry = {
  timestamp: string;
  source: string;
  level: "info" | "warn" | "error";
  message: string;
};

const centralLog: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function logEvent(
  source: string,
  level: LogEntry["level"],
  message: string,
  logger: PluginLogger,
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source,
    level,
    message,
  };
  centralLog.push(entry);
  if (centralLog.length > MAX_LOG_ENTRIES) {
    centralLog.splice(0, centralLog.length - MAX_LOG_ENTRIES);
  }

  switch (level) {
    case "info":
      logger.info(`[rex-daemon:${source}] ${message}`);
      break;
    case "warn":
      logger.warn(`[rex-daemon:${source}] ${message}`);
      break;
    case "error":
      logger.error(`[rex-daemon:${source}] ${message}`);
      break;
  }
}

export function getRecentLogs(limit = 50): LogEntry[] {
  return centralLog.slice(-limit);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function execCommand(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() ?? "",
        stderr: stderr?.trim() ?? "",
        exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

async function alertKevin(message: string, cfg: DaemonConfig): Promise<void> {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        text: message,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Alert delivery failure is non-fatal
  }
}

// ── Health check cycle (every 5 min) ─────────────────────────────────────────

async function healthCheckCycle(cfg: DaemonConfig, logger: PluginLogger): Promise<void> {
  // Check Ollama
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as { models?: unknown[] };
      const modelCount = Array.isArray(data.models) ? data.models.length : 0;
      logEvent("health", "info", `Ollama OK — ${modelCount} models loaded`, logger);
    } else {
      logEvent("health", "warn", `Ollama responded with ${res.status}`, logger);
    }
  } catch {
    logEvent("health", "warn", "Ollama unreachable", logger);
  }

  // Check disk space
  try {
    const { stdout } = await execCommand("df", ["-h", homedir()]);
    const lines = stdout.split("\n").filter(Boolean);
    const dataLine = lines[1];
    if (dataLine) {
      const parts = dataLine.split(/\s+/);
      const usagePercent = parts[4] ?? "?";
      const available = parts[3] ?? "?";
      logEvent("health", "info", `Disk: ${usagePercent} used, ${available} available`, logger);

      const numericUsage = parseInt(usagePercent, 10);
      if (!isNaN(numericUsage) && numericUsage > 90) {
        logEvent("health", "error", `Disk usage critical: ${usagePercent}`, logger);
        await alertKevin(`Rex: disk usage critical (${usagePercent})`, cfg);
      }
    }
  } catch {
    logEvent("health", "warn", "Could not check disk space", logger);
  }

  // Check memory DB
  const memoryDbPath = join(homedir(), ".rex-memory", "rex-memory.db");
  if (existsSync(memoryDbPath)) {
    try {
      const stat = statSync(memoryDbPath);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      logEvent("health", "info", `Memory DB: ${sizeMB} MB`, logger);
    } catch {
      logEvent("health", "warn", "Could not stat memory DB", logger);
    }
  } else {
    logEvent("health", "warn", "Memory DB not found", logger);
  }
}

// ── Milo monitor cycle (every 5 min) ─────────────────────────────────────────

async function miloMonitorCycle(cfg: DaemonConfig, logger: PluginLogger): Promise<void> {
  const containerName = cfg.miloContainerName;

  try {
    const { stdout, exitCode } = await execCommand("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      containerName,
    ]);

    if (exitCode !== 0) {
      logEvent(
        "milo",
        "warn",
        `Container ${containerName} not found (docker inspect failed)`,
        logger,
      );
      return;
    }

    const status = stdout.trim().toLowerCase();
    logEvent("milo", "info", `Container ${containerName}: ${status}`, logger);

    if (status !== "running") {
      logEvent(
        "milo",
        "warn",
        `Container ${containerName} is ${status}, attempting restart...`,
        logger,
      );

      const { exitCode: restartCode, stderr } = await execCommand("docker", [
        "start",
        containerName,
      ]);

      if (restartCode === 0) {
        logEvent("milo", "info", `Container ${containerName} restarted successfully`, logger);
        await alertKevin(
          `Rex: container \`${containerName}\` was ${status}, restarted successfully.`,
          cfg,
        );
      } else {
        logEvent("milo", "error", `Failed to restart ${containerName}: ${stderr}`, logger);
        await alertKevin(
          `Rex: failed to restart container \`${containerName}\` (was ${status}): ${stderr.slice(0, 200)}`,
          cfg,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("milo", "warn", `Docker check failed: ${msg.slice(0, 150)}`, logger);
  }
}

// ── Fleet mesh health (every 30 min) ─────────────────────────────────────────

async function fleetMeshCycle(cfg: DaemonConfig, logger: PluginLogger): Promise<void> {
  const results: string[] = [];

  for (const nodeIp of cfg.tailscaleNodes) {
    try {
      const { exitCode } = await execCommand("ping", ["-c", "1", "-W", "3", nodeIp], 5000);
      const status = exitCode === 0 ? "reachable" : "unreachable";
      results.push(`${nodeIp}: ${status}`);

      if (exitCode !== 0) {
        logEvent("fleet", "warn", `Node ${nodeIp} unreachable`, logger);
      }
    } catch {
      results.push(`${nodeIp}: error`);
      logEvent("fleet", "warn", `Ping failed for ${nodeIp}`, logger);
    }
  }

  logEvent("fleet", "info", `Fleet mesh: ${results.join(", ")}`, logger);

  // Check Tailscale status
  try {
    const { stdout, exitCode } = await execCommand("tailscale", ["status", "--json"], 8000);
    if (exitCode === 0 && stdout) {
      const tsStatus = JSON.parse(stdout) as {
        Self?: { Online?: boolean; TailscaleIPs?: string[] };
        Peer?: Record<string, { Online?: boolean; HostName?: string }>;
      };
      const selfOnline = tsStatus.Self?.Online ?? false;
      const peers = tsStatus.Peer ? Object.values(tsStatus.Peer) : [];
      const onlinePeers = peers.filter((p) => p.Online).length;
      logEvent(
        "fleet",
        "info",
        `Tailscale: self=${selfOnline ? "online" : "offline"}, ${onlinePeers}/${peers.length} peers online`,
        logger,
      );
    }
  } catch {
    logEvent("fleet", "warn", "Could not check Tailscale status", logger);
  }
}

// ── Memory ingest cycle (every 1 hour) ───────────────────────────────────────

async function memoryIngestCycle(logger: PluginLogger): Promise<void> {
  const rexBinCandidates = [
    join(homedir(), ".nvm", "versions", "node", "v22.20.0", "bin", "rex"),
    join(homedir(), ".local", "bin", "rex"),
    "/usr/local/bin/rex",
  ];
  let rexBin = "rex";
  for (const c of rexBinCandidates) {
    if (existsSync(c)) {
      rexBin = c;
      break;
    }
  }

  // Run ingest
  try {
    const { stdout, exitCode, stderr } = await execCommand(rexBin, ["ingest"], 120_000);
    if (exitCode === 0) {
      logEvent("memory", "info", `Ingest completed: ${stdout.slice(0, 200)}`, logger);
    } else {
      logEvent("memory", "warn", `Ingest failed: ${stderr.slice(0, 200)}`, logger);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("memory", "warn", `Ingest error: ${msg.slice(0, 150)}`, logger);
  }

  // Run categorize
  try {
    const { stdout, exitCode } = await execCommand(rexBin, ["categorize", "--batch=100"], 120_000);
    if (exitCode === 0) {
      logEvent("memory", "info", `Categorize completed: ${stdout.slice(0, 200)}`, logger);
    }
  } catch {
    logEvent("memory", "warn", "Categorize failed", logger);
  }
}

// ── Training status check (every 6 hours) ────────────────────────────────────

async function trainingStatusCycle(logger: PluginLogger): Promise<void> {
  const trainingDir = join(homedir(), ".claude", "rex", "training");
  if (!existsSync(trainingDir)) {
    logEvent("training", "info", "No training directory found, skipping", logger);
    return;
  }

  try {
    const { stdout } = await execCommand("ls", ["-la", trainingDir]);
    const fileCount = stdout.split("\n").filter(Boolean).length - 1; // subtract header
    logEvent("training", "info", `Training dir: ${fileCount} files`, logger);
  } catch {
    logEvent("training", "warn", "Could not check training directory", logger);
  }
}

// ── Interval management ──────────────────────────────────────────────────────

type IntervalHandle = ReturnType<typeof setInterval>;

// ── Service factory ──────────────────────────────────────────────────────────

export function createRexDaemonService(): OpenClawPluginService {
  const intervals: IntervalHandle[] = [];

  return {
    id: "rex-daemon",
    async start(ctx: OpenClawPluginServiceContext) {
      const pluginCfg = ctx.config as unknown as Record<string, unknown>;
      const cfg: DaemonConfig = {
        ...DEFAULT_CONFIG,
        ...(typeof pluginCfg?.healthIntervalMs === "number"
          ? { healthIntervalMs: pluginCfg.healthIntervalMs }
          : {}),
        ...(typeof pluginCfg?.fleetIntervalMs === "number"
          ? { fleetIntervalMs: pluginCfg.fleetIntervalMs }
          : {}),
        ...(typeof pluginCfg?.ingestIntervalMs === "number"
          ? { ingestIntervalMs: pluginCfg.ingestIntervalMs }
          : {}),
        ...(typeof pluginCfg?.telegramBotToken === "string"
          ? { telegramBotToken: pluginCfg.telegramBotToken }
          : {}),
        ...(typeof pluginCfg?.telegramChatId === "string"
          ? { telegramChatId: pluginCfg.telegramChatId }
          : {}),
        ...(typeof pluginCfg?.ollamaUrl === "string" ? { ollamaUrl: pluginCfg.ollamaUrl } : {}),
      };

      ctx.logger.info("rex-daemon: starting background cycles");

      // Run initial health check immediately
      await healthCheckCycle(cfg, ctx.logger).catch((err) => {
        ctx.logger.error(`rex-daemon: initial health check failed: ${String(err)}`);
      });

      // Schedule recurring cycles
      intervals.push(
        setInterval(() => {
          healthCheckCycle(cfg, ctx.logger).catch((err) => {
            ctx.logger.error(`rex-daemon: health check failed: ${String(err)}`);
          });
        }, cfg.healthIntervalMs),
      );

      intervals.push(
        setInterval(() => {
          miloMonitorCycle(cfg, ctx.logger).catch((err) => {
            ctx.logger.error(`rex-daemon: milo monitor failed: ${String(err)}`);
          });
        }, cfg.healthIntervalMs), // same interval as health
      );

      intervals.push(
        setInterval(() => {
          fleetMeshCycle(cfg, ctx.logger).catch((err) => {
            ctx.logger.error(`rex-daemon: fleet mesh check failed: ${String(err)}`);
          });
        }, cfg.fleetIntervalMs),
      );

      intervals.push(
        setInterval(() => {
          memoryIngestCycle(ctx.logger).catch((err) => {
            ctx.logger.error(`rex-daemon: memory ingest failed: ${String(err)}`);
          });
        }, cfg.ingestIntervalMs),
      );

      intervals.push(
        setInterval(() => {
          trainingStatusCycle(ctx.logger).catch((err) => {
            ctx.logger.error(`rex-daemon: training status check failed: ${String(err)}`);
          });
        }, cfg.trainingIntervalMs),
      );

      ctx.logger.info(
        `rex-daemon: all cycles scheduled (health=${cfg.healthIntervalMs / 1000}s, fleet=${cfg.fleetIntervalMs / 1000}s, ingest=${cfg.ingestIntervalMs / 1000}s, training=${cfg.trainingIntervalMs / 1000}s)`,
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info("rex-daemon: stopping background cycles");
      for (const handle of intervals) {
        clearInterval(handle);
      }
      intervals.length = 0;
    },
  };
}
