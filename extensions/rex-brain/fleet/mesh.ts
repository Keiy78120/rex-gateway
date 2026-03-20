import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FleetNodeRole = "mac" | "pc" | "vps";

export interface FleetNode {
  name: string;
  ip: string;
  os: string;
  online: boolean;
  lastSeen: string;
  role: FleetNodeRole;
}

export interface PingResult {
  reachable: boolean;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Known fleet IPs → role mapping
// ---------------------------------------------------------------------------

const KNOWN_ROLES: Record<string, FleetNodeRole> = {
  "100.112.24.122": "mac",
  "100.91.130.59": "pc",
  "109.176.197.27": "vps",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr?.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

interface TailscalePeer {
  TailscaleIPs?: string[];
  HostName?: string;
  OS?: string;
  Online?: boolean;
  LastSeen?: string;
}

interface TailscaleStatus {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
}

function inferRole(ip: string, hostname: string): FleetNodeRole {
  if (KNOWN_ROLES[ip]) {
    return KNOWN_ROLES[ip];
  }
  const lower = hostname.toLowerCase();
  if (lower.includes("mac") || lower.includes("mbp") || lower.includes("imac")) {
    return "mac";
  }
  if (lower.includes("vps") || lower.includes("srv") || lower.includes("server")) {
    return "vps";
  }
  return "pc";
}

function parsePeer(peer: TailscalePeer): FleetNode | null {
  const ip = peer.TailscaleIPs?.[0]?.trim() ?? "";
  if (!ip) {
    return null;
  }
  const name = peer.HostName?.trim() ?? "unknown";
  const os = peer.OS?.trim() ?? "unknown";
  const online = peer.Online === true;
  const lastSeen = peer.LastSeen?.trim() ?? "";
  const role = inferRole(ip, name);
  return { name, ip, os, online, lastSeen, role };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all Tailscale mesh nodes by running `tailscale status --json`.
 */
export async function discoverNodes(): Promise<FleetNode[]> {
  try {
    const raw = await runCommand("tailscale", ["status", "--json"]);
    const status: TailscaleStatus = JSON.parse(raw) as TailscaleStatus;
    const nodes: FleetNode[] = [];

    // Include self
    if (status.Self) {
      const self = parsePeer(status.Self);
      if (self) {
        nodes.push(self);
      }
    }

    // Include peers
    if (status.Peer) {
      for (const peer of Object.values(status.Peer)) {
        const node = parsePeer(peer);
        if (node) {
          nodes.push(node);
        }
      }
    }

    return nodes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to discover Tailscale nodes: ${message}`);
  }
}

/**
 * Ping a specific node by IP and measure latency.
 */
export async function pingNode(ip: string): Promise<PingResult> {
  const start = performance.now();
  try {
    // Use tailscale ping for mesh-level reachability (1 attempt, 5s timeout)
    await runCommand("tailscale", ["ping", "--c", "1", "--timeout", "5s", ip]);
    const latencyMs = Math.round(performance.now() - start);
    return { reachable: true, latencyMs };
  } catch {
    const latencyMs = Math.round(performance.now() - start);
    return { reachable: false, latencyMs };
  }
}

/**
 * Look up the role of a known fleet IP.
 */
export function getKnownRole(ip: string): FleetNodeRole | null {
  return KNOWN_ROLES[ip] ?? null;
}
