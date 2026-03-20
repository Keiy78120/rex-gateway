import { execFile } from "node:child_process";
import type { MachineProfile } from "./detect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WizardResult = {
  installed: string[];
  configured: string[];
  skipped: string[];
  errors: string[];
};

type InstallStep = {
  name: string;
  check: () => Promise<boolean>;
  install: () => Promise<boolean>;
  description: string;
};

type DeviceClass = "mac-apple-silicon" | "pc-nvidia" | "vps-no-gpu" | "laptop-basic";

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
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

async function commandExists(name: string): Promise<boolean> {
  const { ok } = await run("which", [name], 5_000);
  return ok;
}

// ---------------------------------------------------------------------------
// Device classification
// ---------------------------------------------------------------------------

function classifyDevice(profile: MachineProfile): DeviceClass {
  // Mac with Apple Silicon
  if (profile.os.startsWith("darwin") && profile.cpu.isAppleSilicon) {
    return "mac-apple-silicon";
  }

  // PC with NVIDIA GPU
  const hasNvidia = profile.gpu.some((g) => g.vendor === "NVIDIA");
  if (hasNvidia) {
    return "pc-nvidia";
  }

  // VPS: Linux with no GPU detected and low RAM typical of cloud instances
  if (profile.os.startsWith("linux") && profile.gpu.length === 0) {
    return "vps-no-gpu";
  }

  // Fallback: laptop/basic machine
  return "laptop-basic";
}

// ---------------------------------------------------------------------------
// Install steps
// ---------------------------------------------------------------------------

function ollamaStep(): InstallStep {
  return {
    name: "ollama",
    description: "Ollama LLM runner",
    check: () => commandExists("ollama"),
    install: async () => {
      const platform = process.platform;
      if (platform === "darwin") {
        // macOS: use brew
        const { ok } = await run("brew", ["install", "ollama"], 120_000);
        return ok;
      }
      // Linux: use install script
      const { ok } = await run(
        "sh",
        ["-c", "curl -fsSL https://ollama.ai/install.sh | sh"],
        120_000,
      );
      return ok;
    },
  };
}

function ollamaModelStep(model: string): InstallStep {
  return {
    name: `ollama:${model}`,
    description: `Ollama model ${model}`,
    check: async () => {
      const { ok, stdout } = await run("ollama", ["list"], 10_000);
      if (!ok) return false;
      return stdout.includes(model);
    },
    install: async () => {
      const { ok } = await run("ollama", ["pull", model], 300_000);
      return ok;
    },
  };
}

function cudaStep(): InstallStep {
  return {
    name: "cuda-toolkit",
    description: "NVIDIA CUDA toolkit",
    check: async () => {
      const { ok } = await run("nvcc", ["--version"], 5_000);
      return ok;
    },
    install: async () => {
      // Only attempt on Linux with apt
      const hasApt = await commandExists("apt-get");
      if (!hasApt) return false;
      const { ok } = await run(
        "sudo",
        ["apt-get", "install", "-y", "nvidia-cuda-toolkit"],
        300_000,
      );
      return ok;
    },
  };
}

function unslothStep(): InstallStep {
  return {
    name: "unsloth",
    description: "Unsloth fine-tuning framework",
    check: async () => {
      const { ok } = await run("python3", ["-c", "import unsloth"], 10_000);
      return ok;
    },
    install: async () => {
      const { ok } = await run("pip3", ["install", "unsloth"], 120_000);
      return ok;
    },
  };
}

function rexCliStep(): InstallStep {
  return {
    name: "rex-cli",
    description: "Rex CLI (rex-claude)",
    check: () => commandExists("rex"),
    install: async () => {
      const { ok } = await run("npm", ["install", "-g", "rex-claude"], 60_000);
      return ok;
    },
  };
}

function ccRulesStep(): InstallStep {
  return {
    name: "cc-rules",
    description: "Claude Code rules and guards",
    check: async () => {
      const { ok } = await run("ls", ["-d", `${process.env["HOME"] ?? "~"}/.claude/rules`], 5_000);
      return ok;
    },
    install: async () => {
      const home = process.env["HOME"] ?? "~";
      const { ok: mkdirOk } = await run("mkdir", ["-p", `${home}/.claude/rules`], 5_000);
      if (!mkdirOk) return false;
      // Sync from brain VPS (will be populated by join.ts)
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Step matrix per device class
// ---------------------------------------------------------------------------

function getStepsForClass(deviceClass: DeviceClass): InstallStep[] {
  switch (deviceClass) {
    case "mac-apple-silicon":
      return [ollamaStep(), ollamaModelStep("qwen2.5:1.5b"), rexCliStep(), ccRulesStep()];

    case "pc-nvidia":
      return [
        ollamaStep(),
        cudaStep(),
        ollamaModelStep("qwen2.5:1.5b"),
        unslothStep(),
        rexCliStep(),
        ccRulesStep(),
      ];

    case "vps-no-gpu":
      return [ollamaStep(), ollamaModelStep("qwen2.5:0.5b"), rexCliStep(), ccRulesStep()];

    case "laptop-basic":
      return [rexCliStep(), ccRulesStep()];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the setup wizard based on detected machine profile.
 * Installs missing tools, verifies after install, reports results.
 */
export async function runWizard(profile: MachineProfile): Promise<WizardResult> {
  const deviceClass = classifyDevice(profile);
  const steps = getStepsForClass(deviceClass);
  const result: WizardResult = { installed: [], configured: [], skipped: [], errors: [] };

  console.log(`[wizard] Device class: ${deviceClass} — ${steps.length} steps to run`);

  for (const step of steps) {
    try {
      // Check if already installed
      const alreadyInstalled = await step.check();
      if (alreadyInstalled) {
        result.skipped.push(step.name);
        console.log(`[wizard] ${step.name}: already installed, skipping`);
        continue;
      }

      // Attempt install
      console.log(`[wizard] ${step.name}: installing (${step.description})...`);
      const installOk = await step.install();

      if (!installOk) {
        result.errors.push(`${step.name}: install failed`);
        console.error(`[wizard] ${step.name}: install failed`);
        continue;
      }

      // Verify after install
      const verified = await step.check();
      if (verified) {
        result.installed.push(step.name);
        console.log(`[wizard] ${step.name}: installed and verified`);
      } else {
        result.errors.push(`${step.name}: installed but verification failed`);
        console.warn(`[wizard] ${step.name}: installed but could not verify`);
      }
    } catch (err) {
      result.errors.push(`${step.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[wizard] ${step.name}: unexpected error — ${err}`);
    }
  }

  // Configured = all steps that succeeded (installed or already present)
  result.configured = [...result.installed, ...result.skipped];

  return result;
}
