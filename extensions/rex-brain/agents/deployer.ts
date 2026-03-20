import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  model: string;
  scope: string;
  telegramToken?: string;
  ports: { host: number; container: number }[];
}

export interface DeployResult {
  success: boolean;
  containerId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPLOY_TIMEOUT_MS = 120_000; // 2 minutes for image pull + start
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_RETRIES = 6;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const OPENCLAW_IMAGE = "ghcr.io/openclaw/openclaw:latest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(
  cmd: string,
  args: readonly string[],
  timeout = DEPLOY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr?.trim() || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Run a docker command on a remote host via SSH, or locally if no target.
 */
function dockerExec(
  args: readonly string[],
  sshTarget?: string,
  timeout = DEPLOY_TIMEOUT_MS,
): Promise<string> {
  if (sshTarget) {
    return runCommand(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        sshTarget,
        "docker",
        ...args,
      ],
      timeout,
    );
  }
  return runCommand("docker", args, timeout);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Docker compose generation
// ---------------------------------------------------------------------------

function generateComposeService(config: AgentConfig): string {
  const portMappings = config.ports.map((p) => `      - "${p.host}:${p.container}"`).join("\n");

  const envVars: string[] = [
    `      - OPENCLAW_AGENT_NAME=${config.name}`,
    `      - OPENCLAW_MODEL=${config.model}`,
    `      - OPENCLAW_SCOPE=${config.scope}`,
  ];

  if (config.telegramToken) {
    envVars.push(`      - TELEGRAM_BOT_TOKEN=${config.telegramToken}`);
  }

  return `  ${config.name}:
    image: ${OPENCLAW_IMAGE}
    container_name: ${config.name}
    restart: unless-stopped
    ports:
${portMappings}
    environment:
${envVars.join("\n")}
    volumes:
      - ./${config.name}-data:/data
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deploy a new OpenClaw agent container.
 *
 * Steps:
 * 1. Generate docker-compose service entry
 * 2. Pull the OpenClaw image
 * 3. Start the container with scope-limited env
 * 4. Verify health after start
 *
 * @param config - Agent configuration
 * @param sshTarget - Optional SSH target for remote deployment
 * @param deployDir - Directory for compose files (default: /opt/rex-agents)
 */
export async function deployAgent(
  config: AgentConfig,
  sshTarget?: string,
  deployDir = "/opt/rex-agents",
): Promise<DeployResult> {
  try {
    // 1. Ensure deploy directory exists
    if (sshTarget) {
      await runCommand("ssh", [
        "-o",
        "StrictHostKeyChecking=accept-new",
        sshTarget,
        "mkdir",
        "-p",
        deployDir,
      ]);
    } else {
      await mkdir(deployDir, { recursive: true });
    }

    // 2. Generate and write compose service snippet
    const composeContent = `version: "3.8"\nservices:\n${generateComposeService(config)}`;
    const composeFile = join(deployDir, `docker-compose.${config.name}.yml`);

    if (sshTarget) {
      // Write via SSH cat
      await runCommand("ssh", [
        "-o",
        "StrictHostKeyChecking=accept-new",
        sshTarget,
        "cat",
        ">",
        composeFile,
      ]);
      // Fallback: use echo via ssh
      await runCommand("ssh", [
        "-o",
        "StrictHostKeyChecking=accept-new",
        sshTarget,
        `cat > ${composeFile} << 'COMPOSE_EOF'\n${composeContent}\nCOMPOSE_EOF`,
      ]);
    } else {
      await writeFile(composeFile, composeContent, "utf8");
    }

    // 3. Pull the image
    await dockerExec(["pull", OPENCLAW_IMAGE], sshTarget);

    // 4. Build environment args
    const envArgs: string[] = [
      "-e",
      `OPENCLAW_AGENT_NAME=${config.name}`,
      "-e",
      `OPENCLAW_MODEL=${config.model}`,
      "-e",
      `OPENCLAW_SCOPE=${config.scope}`,
    ];
    if (config.telegramToken) {
      envArgs.push("-e", `TELEGRAM_BOT_TOKEN=${config.telegramToken}`);
    }

    // Port args
    const portArgs: string[] = [];
    for (const p of config.ports) {
      portArgs.push("-p", `${p.host}:${p.container}`);
    }

    // 5. Run the container
    const containerId = await dockerExec(
      [
        "run",
        "-d",
        "--name",
        config.name,
        "--restart",
        "unless-stopped",
        ...portArgs,
        ...envArgs,
        OPENCLAW_IMAGE,
      ],
      sshTarget,
    );

    // 6. Verify health
    const healthy = await verifyHealth(config.name, sshTarget);

    if (!healthy) {
      return {
        success: false,
        containerId: containerId.slice(0, 12),
        message: `Container ${config.name} started but health check failed after ${HEALTH_CHECK_RETRIES} retries.`,
      };
    }

    return {
      success: true,
      containerId: containerId.slice(0, 12),
      message: `Agent ${config.name} deployed successfully (model: ${config.model}, scope: ${config.scope}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      containerId: "",
      message: `Deployment failed: ${message}`,
    };
  }
}

/**
 * Verify container health by checking if it's running after a brief wait.
 */
async function verifyHealth(containerName: string, sshTarget?: string): Promise<boolean> {
  for (let attempt = 0; attempt < HEALTH_CHECK_RETRIES; attempt++) {
    await sleep(HEALTH_CHECK_INTERVAL_MS);
    try {
      const status = await dockerExec(
        ["inspect", "--format", "{{.State.Running}}", containerName],
        sshTarget,
        HEALTH_CHECK_TIMEOUT_MS,
      );
      if (status.trim() === "true") {
        return true;
      }
    } catch {
      // Container may still be starting
    }
  }
  return false;
}

/**
 * Stop and remove an agent container.
 */
export async function removeAgent(name: string, sshTarget?: string): Promise<boolean> {
  try {
    await dockerExec(["stop", name], sshTarget);
    await dockerExec(["rm", name], sshTarget);
    return true;
  } catch {
    return false;
  }
}
