import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerHealth {
  name: string;
  status: "running" | "stopped" | "restarting" | "dead" | "unknown";
  uptime: string;
  restarts: number;
  memUsage: string;
}

export interface AlertPayload {
  container: string;
  previousStatus: string;
  currentStatus: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_TIMEOUT_MS = 15_000;

const MONITORED_CONTAINERS = ["milo-openclaw", "mission-control-front", "n8n-automation"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: DOCKER_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr?.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Run a docker command on a remote host via SSH.
 * If sshTarget is undefined, run locally.
 */
function dockerCommand(args: readonly string[], sshTarget?: string): Promise<string> {
  if (sshTarget) {
    return runCommand("ssh", [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      sshTarget,
      "docker",
      ...args,
    ]);
  }
  return runCommand("docker", args);
}

interface DockerInspectState {
  Status?: string;
  Running?: boolean;
  Restarting?: boolean;
  Dead?: boolean;
  StartedAt?: string;
  RestartCount?: number;
}

interface DockerInspectResult {
  State?: DockerInspectState;
}

function parseStatus(state: DockerInspectState | undefined): ContainerHealth["status"] {
  if (!state) {
    return "unknown";
  }
  if (state.Dead === true) {
    return "dead";
  }
  if (state.Restarting === true) {
    return "restarting";
  }
  if (state.Running === true) {
    return "running";
  }
  if (state.Status === "exited" || state.Running === false) {
    return "stopped";
  }
  return "unknown";
}

function computeUptime(startedAt: string | undefined): string {
  if (!startedAt) {
    return "unknown";
  }
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) {
    return "unknown";
  }
  const diffMs = Date.now() - started;
  if (diffMs < 0) {
    return "0s";
  }

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the health of a Docker container by name.
 *
 * @param name - Container name
 * @param sshTarget - Optional SSH target (user@host) for remote docker commands
 */
export async function checkContainerHealth(
  name: string,
  sshTarget?: string,
): Promise<ContainerHealth> {
  try {
    const inspectRaw = await dockerCommand(
      ["inspect", "--format", "{{json .State}}", name],
      sshTarget,
    );
    const state = JSON.parse(inspectRaw.trim()) as DockerInspectState;

    // Get memory usage from docker stats (one-shot, no-stream)
    let memUsage = "unknown";
    try {
      const statsRaw = await dockerCommand(
        ["stats", "--no-stream", "--format", "{{.MemUsage}}", name],
        sshTarget,
      );
      memUsage = statsRaw.trim() || "unknown";
    } catch {
      // Non-critical — container may not be running
    }

    return {
      name,
      status: parseStatus(state),
      uptime: computeUptime(state.StartedAt),
      restarts: typeof state.RestartCount === "number" ? state.RestartCount : 0,
      memUsage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Container probably doesn't exist or docker is unreachable
    return {
      name,
      status: "unknown",
      uptime: "unknown",
      restarts: 0,
      memUsage: `error: ${message}`,
    };
  }
}

/**
 * Restart a Docker container by name.
 *
 * @param name - Container name
 * @param sshTarget - Optional SSH target for remote docker
 * @returns true if restart succeeded
 */
export async function restartContainer(name: string, sshTarget?: string): Promise<boolean> {
  try {
    await dockerCommand(["restart", name], sshTarget);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check health of all monitored containers.
 *
 * @param sshTarget - Optional SSH target for remote docker
 */
export async function checkAllContainers(sshTarget?: string): Promise<ContainerHealth[]> {
  const results: ContainerHealth[] = [];
  for (const name of MONITORED_CONTAINERS) {
    const health = await checkContainerHealth(name, sshTarget);
    results.push(health);
  }
  return results;
}

/**
 * Send a Telegram alert to Kevin when a container status changes.
 *
 * Uses the Telegram Bot API directly via curl (execFile).
 * Requires REX_TELEGRAM_BOT_TOKEN and REX_TELEGRAM_CHAT_ID env vars.
 */
export async function sendAlert(payload: AlertPayload): Promise<boolean> {
  const token = process.env.REX_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.REX_TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  const statusIcon = payload.currentStatus === "running" ? "OK" : "ALERT";
  const text = [
    `[${statusIcon}] Container: ${payload.container}`,
    `Status: ${payload.previousStatus} -> ${payload.currentStatus}`,
    `Time: ${payload.timestamp}`,
  ].join("\n");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await runCommand("curl", [
      "-s",
      "-X",
      "POST",
      url,
      "-d",
      `chat_id=${chatId}`,
      "-d",
      `text=${text}`,
      "-d",
      "disable_notification=false",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Monitor loop: check all containers and alert on status changes.
 * Returns the current health snapshot and any alerts that were sent.
 */
export async function monitorAndAlert(
  previousStates: Map<string, string>,
  sshTarget?: string,
): Promise<{ health: ContainerHealth[]; alertsSent: string[] }> {
  const health = await checkAllContainers(sshTarget);
  const alertsSent: string[] = [];

  for (const container of health) {
    const prev = previousStates.get(container.name);
    if (prev !== undefined && prev !== container.status) {
      const alert: AlertPayload = {
        container: container.name,
        previousStatus: prev,
        currentStatus: container.status,
        timestamp: new Date().toISOString(),
      };
      const sent = await sendAlert(alert);
      if (sent) {
        alertsSent.push(container.name);
      }
    }
    previousStates.set(container.name, container.status);
  }

  return { health, alertsSent };
}

/**
 * Get the list of default monitored container names.
 */
export function getMonitoredContainers(): readonly string[] {
  return MONITORED_CONTAINERS;
}
