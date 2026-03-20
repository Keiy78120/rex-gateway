import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriorityLevel = "critical" | "warning" | "info";

export type ProactiveSignal = {
  type: string;
  title: string;
  detail: string;
  source: string;
  detectedAt: number;
  priority: PriorityLevel;
};

export type HardwareSignals = {
  cpuLoad: number[];
  ramUsedPercent: number;
  ramFreeGB: number;
  diskUsedPercent: number | null;
};

export type ServiceSignals = {
  ollamaRunning: boolean;
  ollamaModels: string[];
  dockerRunning: boolean;
  dockerContainers: number;
  tailscaleConnected: boolean;
  tailscalePeers: number;
};

export type DevSignals = {
  gitBranch: string | null;
  gitDirty: boolean;
  uncommittedFiles: number;
  pendingMemoryChunks: number;
};

export type ProviderSignals = {
  groq: boolean;
  cerebras: boolean;
  brave: boolean;
  openai: boolean;
  anthropic: boolean;
  fireworks: boolean;
  together: boolean;
  perplexity: boolean;
};

export type SystemSignals = {
  hardware: HardwareSignals;
  services: ServiceSignals;
  dev: DevSignals;
  providers: ProviderSignals;
  capturedAt: number;
  alerts: ProactiveSignal[];
};

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
      });
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs + 1000);
    proc.on("close", () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Hardware signals (zero LLM)
// ---------------------------------------------------------------------------

async function detectHardware(): Promise<HardwareSignals> {
  const cpuLoad = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const ramFreeGB = Math.round((freeMem / 1073741824) * 10) / 10;

  let diskUsedPercent: number | null = null;
  const { ok, stdout } = await run("df", ["-h", "/"]);
  if (ok && stdout) {
    const lines = stdout.split("\n");
    if (lines.length >= 2) {
      const parts = lines[1]!.split(/\s+/);
      const pctStr = parts[4];
      if (pctStr) {
        const parsed = parseInt(pctStr.replace("%", ""), 10);
        if (!Number.isNaN(parsed)) diskUsedPercent = parsed;
      }
    }
  }

  return { cpuLoad, ramUsedPercent, ramFreeGB, diskUsedPercent };
}

// ---------------------------------------------------------------------------
// Service signals
// ---------------------------------------------------------------------------

async function detectServices(): Promise<ServiceSignals> {
  const result: ServiceSignals = {
    ollamaRunning: false,
    ollamaModels: [],
    dockerRunning: false,
    dockerContainers: 0,
    tailscaleConnected: false,
    tailscalePeers: 0,
  };

  // Ollama
  const ollama = await run("curl", ["-s", "--max-time", "2", "http://localhost:11434/api/tags"]);
  if (ollama.ok && ollama.stdout) {
    result.ollamaRunning = true;
    try {
      const data = JSON.parse(ollama.stdout) as { models?: Array<{ name?: string }> };
      result.ollamaModels = (data.models ?? []).map((m) => m.name ?? "unknown");
    } catch {
      // Running but can't parse models
    }
  }

  // Docker
  const docker = await run("docker", ["ps", "--format", "{{.ID}}"], 5_000);
  if (docker.ok) {
    result.dockerRunning = true;
    const ids = docker.stdout.split("\n").filter((l) => l.length > 0);
    result.dockerContainers = ids.length;
  }

  // Tailscale
  const ts = await run("tailscale", ["status", "--json"], 5_000);
  if (ts.ok && ts.stdout) {
    try {
      const data = JSON.parse(ts.stdout) as { Peer?: Record<string, unknown> };
      result.tailscaleConnected = true;
      result.tailscalePeers = Object.keys(data.Peer ?? {}).length;
    } catch {
      // Status returned but unparseable
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dev signals
// ---------------------------------------------------------------------------

async function detectDev(): Promise<DevSignals> {
  const result: DevSignals = {
    gitBranch: null,
    gitDirty: false,
    uncommittedFiles: 0,
    pendingMemoryChunks: 0,
  };

  // Git branch
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], 5_000);
  if (branch.ok) {
    result.gitBranch = branch.stdout;
  }

  // Git status
  const status = await run("git", ["status", "--porcelain"], 5_000);
  if (status.ok && status.stdout) {
    const lines = status.stdout.split("\n").filter((l) => l.length > 0);
    result.uncommittedFiles = lines.length;
    result.gitDirty = lines.length > 0;
  }

  // Pending memory chunks (Rex memory pending dir)
  const pendingDir = path.join(os.homedir(), ".rex-memory", "pending");
  try {
    const entries = await fs.readdir(pendingDir);
    result.pendingMemoryChunks = entries.length;
  } catch {
    // Dir doesn't exist or not readable — 0 pending
  }

  return result;
}

// ---------------------------------------------------------------------------
// Provider signals (env var check, zero network)
// ---------------------------------------------------------------------------

function detectProviders(): ProviderSignals {
  const env = process.env;
  return {
    groq: Boolean(env["GROQ_API_KEY"]),
    cerebras: Boolean(env["CEREBRAS_API_KEY"]),
    brave: Boolean(env["BRAVE_API_KEY"]),
    openai: Boolean(env["OPENAI_API_KEY"]),
    anthropic: Boolean(env["ANTHROPIC_API_KEY"]),
    fireworks: Boolean(env["FIREWORKS_API_KEY"]),
    together: Boolean(env["TOGETHER_API_KEY"]),
    perplexity: Boolean(env["PERPLEXITY_API_KEY"]),
  };
}

// ---------------------------------------------------------------------------
// Alert generation
// ---------------------------------------------------------------------------

function generateAlerts(
  hardware: HardwareSignals,
  services: ServiceSignals,
  dev: DevSignals,
): ProactiveSignal[] {
  const now = Date.now();
  const alerts: ProactiveSignal[] = [];

  // CPU load > 80% of cores
  const cpuCores = os.cpus().length;
  const load5m = hardware.cpuLoad[1] ?? 0;
  if (load5m > cpuCores * 0.8) {
    alerts.push({
      type: "high_cpu",
      title: "High CPU load",
      detail: `5-min load avg ${load5m.toFixed(1)} exceeds 80% of ${cpuCores} cores`,
      source: "hardware",
      detectedAt: now,
      priority: load5m > cpuCores ? "critical" : "warning",
    });
  }

  // RAM > 90%
  if (hardware.ramUsedPercent > 90) {
    alerts.push({
      type: "low_ram",
      title: "Low available RAM",
      detail: `${hardware.ramUsedPercent}% RAM used, ${hardware.ramFreeGB}GB free`,
      source: "hardware",
      detectedAt: now,
      priority: hardware.ramUsedPercent > 95 ? "critical" : "warning",
    });
  }

  // Disk > 85%
  if (hardware.diskUsedPercent !== null && hardware.diskUsedPercent > 85) {
    alerts.push({
      type: "low_disk",
      title: "Low disk space",
      detail: `${hardware.diskUsedPercent}% disk used`,
      source: "hardware",
      detectedAt: now,
      priority: hardware.diskUsedPercent > 95 ? "critical" : "warning",
    });
  }

  // Ollama down
  if (!services.ollamaRunning) {
    alerts.push({
      type: "ollama_down",
      title: "Ollama not running",
      detail: "Local LLM inference unavailable — API-only mode",
      source: "services",
      detectedAt: now,
      priority: "warning",
    });
  }

  // Tailscale disconnected
  if (!services.tailscaleConnected) {
    alerts.push({
      type: "tailscale_down",
      title: "Tailscale disconnected",
      detail: "Fleet mesh network unavailable",
      source: "services",
      detectedAt: now,
      priority: "warning",
    });
  }

  // Many uncommitted files
  if (dev.uncommittedFiles > 10) {
    alerts.push({
      type: "git_dirty",
      title: "Many uncommitted changes",
      detail: `${dev.uncommittedFiles} uncommitted files in working directory`,
      source: "dev",
      detectedAt: now,
      priority: "info",
    });
  }

  // Pending memory chunks piling up
  if (dev.pendingMemoryChunks > 50) {
    alerts.push({
      type: "memory_backlog",
      title: "Memory ingest backlog",
      detail: `${dev.pendingMemoryChunks} chunks pending ingestion`,
      source: "dev",
      detectedAt: now,
      priority: "warning",
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect all system signals without calling any LLM.
 * Pure environmental sensing: hardware, services, dev context, provider availability.
 */
export async function detectSignals(): Promise<SystemSignals> {
  const [hardware, services, dev] = await Promise.all([
    detectHardware(),
    detectServices(),
    detectDev(),
  ]);

  const providers = detectProviders();
  const alerts = generateAlerts(hardware, services, dev);

  return {
    hardware,
    services,
    dev,
    providers,
    capturedAt: Date.now(),
    alerts,
  };
}
