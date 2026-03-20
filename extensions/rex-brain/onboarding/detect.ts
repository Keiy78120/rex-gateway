import { execFile } from "node:child_process";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GpuInfo = {
  vendor: string;
  model: string;
  vram?: string;
};

export type InstalledTool = {
  name: string;
  path: string;
  version: string;
};

export type MachineProfile = {
  os: string;
  arch: string;
  cpu: {
    model: string;
    cores: number;
    isAppleSilicon: boolean;
  };
  gpu: GpuInfo[];
  ram: {
    totalGB: number;
    freeGB: number;
  };
  disk: {
    total: string;
    used: string;
    available: string;
    percentUsed: string;
  };
  network: {
    tailscaleConnected: boolean;
    tailscaleIp: string | null;
    publicIp: string | null;
  };
  installedTools: InstalledTool[];
};

// ---------------------------------------------------------------------------
// Shell helper (execFile wrapper)
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
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
// GPU detection
// ---------------------------------------------------------------------------

async function detectGpuMac(): Promise<GpuInfo[]> {
  const { ok, stdout } = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
  if (!ok || !stdout) return [];

  try {
    const data = JSON.parse(stdout) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        spdisplays_vendor?: string;
        spdisplays_vram_shared?: string;
        spdisplays_vram?: string;
      }>;
    };
    const displays = data.SPDisplaysDataType ?? [];
    return displays.map((d) => ({
      vendor: d.spdisplays_vendor ?? "Apple",
      model: d.sppci_model ?? "Unknown",
      vram: d.spdisplays_vram ?? d.spdisplays_vram_shared ?? undefined,
    }));
  } catch {
    return [];
  }
}

async function detectGpuNvidia(): Promise<GpuInfo[]> {
  const { ok, stdout } = await run("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (!ok || !stdout) return [];

  return stdout.split("\n").map((line) => {
    const [model, vram] = line.split(",").map((s) => s.trim());
    return { vendor: "NVIDIA", model: model ?? "Unknown", vram: vram ? `${vram} MiB` : undefined };
  });
}

async function detectGpuAmd(): Promise<GpuInfo[]> {
  const { ok, stdout } = await run("rocm-smi", ["--showproductname"]);
  if (!ok || !stdout) return [];

  const lines = stdout.split("\n").filter((l) => l.includes("Card"));
  return lines.map((line) => ({
    vendor: "AMD",
    model: line.replace(/.*:\s*/, "").trim() || "Unknown",
  }));
}

async function detectGpu(): Promise<GpuInfo[]> {
  const platform = os.platform();

  if (platform === "darwin") {
    return detectGpuMac();
  }

  // Linux/Windows: try NVIDIA first, then AMD
  const nvidia = await detectGpuNvidia();
  if (nvidia.length > 0) return nvidia;

  const amd = await detectGpuAmd();
  if (amd.length > 0) return amd;

  return [];
}

// ---------------------------------------------------------------------------
// Disk detection
// ---------------------------------------------------------------------------

async function detectDisk(): Promise<MachineProfile["disk"]> {
  const fallback = {
    total: "unknown",
    used: "unknown",
    available: "unknown",
    percentUsed: "unknown",
  };

  const { ok, stdout } = await run("df", ["-h", "/"]);
  if (!ok || !stdout) return fallback;

  // df -h output: Filesystem Size Used Avail Use% Mounted
  const lines = stdout.split("\n");
  if (lines.length < 2) return fallback;

  const parts = lines[1]!.split(/\s+/);
  if (parts.length < 5) return fallback;

  return {
    total: parts[1] ?? "unknown",
    used: parts[2] ?? "unknown",
    available: parts[3] ?? "unknown",
    percentUsed: parts[4] ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// Network detection
// ---------------------------------------------------------------------------

async function detectNetwork(): Promise<MachineProfile["network"]> {
  const result: MachineProfile["network"] = {
    tailscaleConnected: false,
    tailscaleIp: null,
    publicIp: null,
  };

  // Tailscale
  const ts = await run("tailscale", ["status", "--json"]);
  if (ts.ok && ts.stdout) {
    try {
      const data = JSON.parse(ts.stdout) as { Self?: { TailscaleIPs?: string[] } };
      const ips = data.Self?.TailscaleIPs;
      if (ips && ips.length > 0) {
        result.tailscaleConnected = true;
        result.tailscaleIp = ips[0] ?? null;
      }
    } catch {
      // Tailscale JSON parse failed, not connected
    }
  }

  // Public IP (with short timeout)
  const ip = await run("curl", ["-s", "--max-time", "5", "https://ifconfig.me"]);
  if (ip.ok && ip.stdout) {
    result.publicIp = ip.stdout;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

const TOOLS_TO_CHECK = [
  { name: "node", versionArgs: ["-v"] },
  { name: "bun", versionArgs: ["--version"] },
  { name: "python3", versionArgs: ["--version"] },
  { name: "docker", versionArgs: ["--version"] },
  { name: "ollama", versionArgs: ["--version"] },
  { name: "claude", versionArgs: ["--version"] },
  { name: "git", versionArgs: ["--version"] },
  { name: "tailscale", versionArgs: ["version"] },
  { name: "ssh", versionArgs: ["-V"] },
] as const;

async function detectTool(
  name: string,
  versionArgs: readonly string[],
): Promise<InstalledTool | null> {
  // Find binary path
  const which = await run("which", [name], 5_000);
  if (!which.ok || !which.stdout) return null;

  // Get version (some tools output to stderr, like ssh -V)
  const ver = await run(name, [...versionArgs], 5_000);
  const version = (ver.stdout || ver.stderr).split("\n")[0] ?? "unknown";

  return {
    name,
    path: which.stdout,
    version: version.trim(),
  };
}

async function detectTools(): Promise<InstalledTool[]> {
  const results = await Promise.all(TOOLS_TO_CHECK.map((t) => detectTool(t.name, t.versionArgs)));
  return results.filter((r): r is InstalledTool => r !== null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-detect the current machine's hardware and software capabilities.
 */
export async function detectMachine(): Promise<MachineProfile> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "Unknown";
  const isAppleSilicon =
    cpuModel.toLowerCase().includes("apple") ||
    (os.arch() === "arm64" && os.platform() === "darwin");

  const [gpu, disk, network, installedTools] = await Promise.all([
    detectGpu(),
    detectDisk(),
    detectNetwork(),
    detectTools(),
  ]);

  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: {
      model: cpuModel,
      cores: cpus.length,
      isAppleSilicon,
    },
    gpu,
    ram: {
      totalGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
      freeGB: Math.round((os.freemem() / 1073741824) * 10) / 10,
    },
    disk,
    network,
    installedTools,
  };
}
