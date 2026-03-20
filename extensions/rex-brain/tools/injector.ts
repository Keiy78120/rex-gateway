import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolDef = {
  name: string;
  description: string;
  category: ToolCategory;
  requiresService?: string;
};

export type SelectedTools = {
  tools: ToolDef[];
  summary: string;
  count: number;
};

type ToolCategory = "memory" | "file" | "command" | "status" | "fleet" | "web";

type IntentGroup = "search" | "code" | "fleet" | "status" | "general";

// ---------------------------------------------------------------------------
// Tool registry (9 tools)
// ---------------------------------------------------------------------------

const TOOL_REGISTRY: ToolDef[] = [
  {
    name: "memory_search",
    description: "Search Rex semantic memory (SQLite + vector embeddings)",
    category: "memory",
    requiresService: "ollama",
  },
  {
    name: "read_file",
    description: "Read contents of a file at a given path",
    category: "file",
  },
  {
    name: "run_command",
    description: "Execute a shell command and return output",
    category: "command",
  },
  {
    name: "get_status",
    description: "Get current system status (CPU, RAM, services)",
    category: "status",
  },
  {
    name: "list_projects",
    description: "List known projects from Rex memory index",
    category: "memory",
  },
  {
    name: "observe",
    description: "Observe and log an event without side effects",
    category: "status",
  },
  {
    name: "web_search",
    description: "Search the web via Brave or Perplexity API",
    category: "web",
    requiresService: "brave_or_perplexity",
  },
  {
    name: "fleet_status",
    description: "Check fleet device connectivity and health",
    category: "fleet",
    requiresService: "tailscale",
  },
  {
    name: "deploy_agent",
    description: "Deploy or restart an agent on a fleet device",
    category: "fleet",
    requiresService: "tailscale",
  },
];

// ---------------------------------------------------------------------------
// Intent classification (keyword matching, no LLM)
// ---------------------------------------------------------------------------

const INTENT_KEYWORDS: Record<IntentGroup, string[]> = {
  search: ["search", "find", "lookup", "query", "where", "memory", "remember", "recall", "history"],
  code: [
    "code",
    "file",
    "read",
    "write",
    "edit",
    "run",
    "execute",
    "build",
    "test",
    "debug",
    "fix",
    "script",
  ],
  fleet: ["fleet", "device", "deploy", "agent", "sync", "ssh", "tailscale", "vps", "pc", "mac"],
  status: ["status", "health", "check", "monitor", "observe", "cpu", "ram", "disk", "load"],
  general: [],
};

const INTENT_TO_CATEGORIES: Record<IntentGroup, ToolCategory[]> = {
  search: ["memory"],
  code: ["file", "command"],
  fleet: ["fleet"],
  status: ["status"],
  general: ["memory", "file", "command", "status", "fleet", "web"],
};

function classifyIntent(message: string): IntentGroup {
  const lower = message.toLowerCase();
  let bestMatch: IntentGroup = "general";
  let bestScore = 0;

  for (const [group, keywords] of Object.entries(INTENT_KEYWORDS) as [IntentGroup, string[]][]) {
    if (group === "general") continue;
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = group;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Service health checks
// ---------------------------------------------------------------------------

function checkService(service: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (service === "ollama") {
      const proc = execFile(
        "curl",
        ["-s", "--max-time", "2", "http://localhost:11434/api/tags"],
        { timeout: 5_000 },
        (error) => resolve(!error),
      );
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(false);
      }, 6_000);
      proc.on("close", () => clearTimeout(timer));
      return;
    }

    if (service === "tailscale") {
      const proc = execFile("tailscale", ["status"], { timeout: 5_000 }, (error) =>
        resolve(!error),
      );
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(false);
      }, 6_000);
      proc.on("close", () => clearTimeout(timer));
      return;
    }

    if (service === "brave_or_perplexity") {
      const hasBrave = Boolean(process.env["BRAVE_API_KEY"]);
      const hasPerplexity = Boolean(process.env["PERPLEXITY_API_KEY"]);
      resolve(hasBrave || hasPerplexity);
      return;
    }

    // Unknown service — assume available
    resolve(true);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select appropriate tools for an LLM call based on:
 * - User intent (keyword matching)
 * - Model capacity (small models get fewer tools)
 * - Service health (skip tools whose backing service is down)
 */
export async function selectTools(intent: string, modelCapacity: number): Promise<SelectedTools> {
  const group = classifyIntent(intent);
  const allowedCategories = INTENT_TO_CATEGORIES[group];

  // Filter by intent category
  let candidates = TOOL_REGISTRY.filter((t) => allowedCategories.includes(t.category));

  // For "general" intent, use all tools
  if (group === "general") {
    candidates = [...TOOL_REGISTRY];
  }

  // Health check: remove tools whose required service is down
  const healthChecks = await Promise.all(
    candidates.map(async (tool) => {
      if (!tool.requiresService) return { tool, healthy: true };
      const healthy = await checkService(tool.requiresService);
      return { tool, healthy };
    }),
  );

  const healthyTools = healthChecks.filter((r) => r.healthy).map((r) => r.tool);

  // Apply model capacity limit
  // Small models (< 3B params): max 2 tools
  // Medium models (3-14B): max 5 tools
  // Large models (> 14B): all tools
  let maxTools: number;
  if (modelCapacity < 3) {
    maxTools = 2;
  } else if (modelCapacity <= 14) {
    maxTools = 5;
  } else {
    maxTools = 9;
  }

  const selected = healthyTools.slice(0, maxTools);

  const unhealthyNames = healthChecks.filter((r) => !r.healthy).map((r) => r.tool.name);

  const summaryParts = [
    `Intent: ${group}`,
    `${selected.length}/${TOOL_REGISTRY.length} tools selected`,
  ];
  if (unhealthyNames.length > 0) {
    summaryParts.push(`Unavailable: ${unhealthyNames.join(", ")}`);
  }
  if (selected.length < healthyTools.length) {
    summaryParts.push(`Capped at ${maxTools} for model capacity ${modelCapacity}B`);
  }

  return {
    tools: selected,
    summary: summaryParts.join(" | "),
    count: selected.length,
  };
}
