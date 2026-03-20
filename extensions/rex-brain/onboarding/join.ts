import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { detectMachine } from "./detect.js";
import { runWizard } from "./wizard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinResult = {
  success: boolean;
  deviceId: string;
  installedTools: string[];
  errors: string[];
};

type InviteValidation = {
  valid: boolean;
  fleetId: string;
  brainHost: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRAIN_VPS_DEFAULT = "109.176.197.27";
const BRAIN_API_PORT = 3141;
const TELEGRAM_BOT_TOKEN = process.env["REX_TELEGRAM_BOT_TOKEN"] ?? "";
const TELEGRAM_CHAT_ID = process.env["REX_TELEGRAM_CHAT_ID"] ?? "";

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
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
// Step 1: Validate invite code
// ---------------------------------------------------------------------------

async function validateInvite(inviteCode: string): Promise<InviteValidation> {
  try {
    const { ok, stdout } = await run("curl", [
      "-s",
      "--max-time",
      "10",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ code: inviteCode }),
      `http://${BRAIN_VPS_DEFAULT}:${BRAIN_API_PORT}/api/v1/fleet/validate-invite`,
    ]);

    if (!ok || !stdout) {
      return {
        valid: false,
        fleetId: "",
        brainHost: BRAIN_VPS_DEFAULT,
        error: "Brain VPS unreachable",
      };
    }

    const data = JSON.parse(stdout) as { valid?: boolean; fleetId?: string; error?: string };
    return {
      valid: data.valid === true,
      fleetId: data.fleetId ?? "",
      brainHost: BRAIN_VPS_DEFAULT,
      error: data.error,
    };
  } catch (err) {
    return {
      valid: false,
      fleetId: "",
      brainHost: BRAIN_VPS_DEFAULT,
      error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 4: Configure Tailscale + SSH
// ---------------------------------------------------------------------------

async function configureTailscale(): Promise<{ ok: boolean; error?: string }> {
  // Check Tailscale is installed
  const tsCheck = await run("which", ["tailscale"], 5_000);
  if (!tsCheck.ok) {
    return { ok: false, error: "Tailscale not installed" };
  }

  // Check already connected
  const tsStatus = await run("tailscale", ["status"], 10_000);
  if (tsStatus.ok) {
    return { ok: true }; // Already connected
  }

  // Attempt to bring up Tailscale
  const tsUp = await run("sudo", ["tailscale", "up"], 30_000);
  if (!tsUp.ok) {
    return { ok: false, error: `Tailscale up failed: ${tsUp.stderr}` };
  }

  return { ok: true };
}

async function configureSSHKeys(): Promise<{ ok: boolean; error?: string }> {
  const home = os.homedir();
  const sshDir = `${home}/.ssh`;

  // Ensure .ssh dir exists
  await run("mkdir", ["-p", sshDir], 5_000);

  // Check if key already exists
  const keyCheck = await run("ls", [`${sshDir}/id_ed25519`], 5_000);
  if (keyCheck.ok) {
    return { ok: true }; // Key already exists
  }

  // Generate new SSH key
  const keygen = await run("ssh-keygen", [
    "-t",
    "ed25519",
    "-f",
    `${sshDir}/id_ed25519`,
    "-N",
    "",
    "-C",
    `rex-fleet-${os.hostname()}`,
  ]);

  if (!keygen.ok) {
    return { ok: false, error: `SSH keygen failed: ${keygen.stderr}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Step 5: Sync rules/guards/skills from brain
// ---------------------------------------------------------------------------

async function syncFromBrain(
  brainHost: string,
): Promise<{ ok: boolean; synced: number; error?: string }> {
  const home = os.homedir();

  // Sync rules
  const rulesSync = await run(
    "rsync",
    [
      "-avz",
      "-e",
      "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
      `${brainHost}:~/.claude/rules/`,
      `${home}/.claude/rules/`,
    ],
    30_000,
  );

  // Sync guards
  const guardsSync = await run(
    "rsync",
    [
      "-avz",
      "-e",
      "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no",
      `${brainHost}:~/.claude/rex-guards/`,
      `${home}/.claude/rex-guards/`,
    ],
    30_000,
  );

  const synced = (rulesSync.ok ? 1 : 0) + (guardsSync.ok ? 1 : 0);
  const errors: string[] = [];
  if (!rulesSync.ok) errors.push(`rules sync failed: ${rulesSync.stderr}`);
  if (!guardsSync.ok) errors.push(`guards sync failed: ${guardsSync.stderr}`);

  return {
    ok: synced > 0,
    synced,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Step 6: Register device
// ---------------------------------------------------------------------------

async function registerDevice(
  brainHost: string,
  deviceId: string,
  profile: Awaited<ReturnType<typeof detectMachine>>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = {
      deviceId,
      hostname: os.hostname(),
      os: profile.os,
      arch: profile.arch,
      cpu: profile.cpu.model,
      ram: profile.ram.totalGB,
      gpu: profile.gpu.map((g) => g.model).join(", ") || "none",
      tailscaleIp: profile.network.tailscaleIp,
      tools: profile.installedTools.map((t) => t.name),
      joinedAt: Date.now(),
    };

    const { ok } = await run("curl", [
      "-s",
      "--max-time",
      "10",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(payload),
      `http://${brainHost}:${BRAIN_API_PORT}/api/v1/fleet/register`,
    ]);

    return { ok };
  } catch (err) {
    return {
      ok: false,
      error: `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 7: Rex doctor
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout, stderr } = await run("rex", ["doctor"], 30_000);
  return { ok, output: stdout || stderr };
}

// ---------------------------------------------------------------------------
// Step 8: Telegram notification
// ---------------------------------------------------------------------------

async function notifyTelegram(deviceId: string, hostname: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = `[Rex Fleet] New device joined:\n\nDevice: ${deviceId}\nHost: ${hostname}\nTime: ${new Date().toISOString()}`;

  await run("curl", [
    "-s",
    "--max-time",
    "10",
    "-X",
    "POST",
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    "-d",
    `chat_id=${TELEGRAM_CHAT_ID}`,
    "-d",
    `text=${text}`,
    "-d",
    "parse_mode=Markdown",
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * `rex join <invite-code>` — full onboarding flow for a new fleet device.
 */
export async function joinFleet(inviteCode: string): Promise<JoinResult> {
  const deviceId = `rex-${os.hostname()}-${randomUUID().slice(0, 8)}`;
  const result: JoinResult = { success: false, deviceId, installedTools: [], errors: [] };

  console.log(`[join] Starting fleet join for ${deviceId}...`);

  // Step 1: Validate invite
  console.log("[join] Step 1/8: Validating invite code...");
  const invite = await validateInvite(inviteCode);
  if (!invite.valid) {
    result.errors.push(`Invalid invite code: ${invite.error ?? "unknown"}`);
    return result;
  }
  console.log(`[join] Invite valid — fleet: ${invite.fleetId}`);

  // Step 2: Detect machine
  console.log("[join] Step 2/8: Detecting machine capabilities...");
  const profile = await detectMachine();
  console.log(
    `[join] Detected: ${profile.os} ${profile.arch}, ${profile.cpu.cores} cores, ${profile.ram.totalGB}GB RAM`,
  );

  // Step 3: Run wizard
  console.log("[join] Step 3/8: Running setup wizard...");
  const wizardResult = await runWizard(profile);
  result.installedTools = wizardResult.configured;
  if (wizardResult.errors.length > 0) {
    result.errors.push(...wizardResult.errors.map((e) => `wizard: ${e}`));
  }

  // Step 4: Tailscale + SSH
  console.log("[join] Step 4/8: Configuring Tailscale and SSH...");
  const tsResult = await configureTailscale();
  if (!tsResult.ok) {
    result.errors.push(`tailscale: ${tsResult.error ?? "failed"}`);
  }
  const sshResult = await configureSSHKeys();
  if (!sshResult.ok) {
    result.errors.push(`ssh: ${sshResult.error ?? "failed"}`);
  }

  // Step 5: Sync from brain
  console.log("[join] Step 5/8: Syncing rules/guards from brain VPS...");
  const syncResult = await syncFromBrain(invite.brainHost);
  if (!syncResult.ok) {
    result.errors.push(`sync: ${syncResult.error ?? "failed"}`);
  }

  // Step 6: Register device
  console.log("[join] Step 6/8: Registering device in fleet...");
  // Re-detect after wizard installs
  const updatedProfile = await detectMachine();
  const regResult = await registerDevice(invite.brainHost, deviceId, updatedProfile);
  if (!regResult.ok) {
    result.errors.push(`register: ${regResult.error ?? "failed"}`);
  }

  // Step 7: Rex doctor
  console.log("[join] Step 7/8: Running rex doctor...");
  const doctorResult = await runDoctor();
  if (!doctorResult.ok) {
    result.errors.push(`doctor: health check returned warnings`);
    console.warn(`[join] Doctor output: ${doctorResult.output}`);
  }

  // Step 8: Notify
  console.log("[join] Step 8/8: Sending notification...");
  await notifyTelegram(deviceId, os.hostname());

  // Determine success: critical steps are invite + register
  result.success = invite.valid && regResult.ok;

  console.log(
    result.success
      ? `[join] Device ${deviceId} joined fleet successfully`
      : `[join] Device ${deviceId} join completed with errors`,
  );

  return result;
}
