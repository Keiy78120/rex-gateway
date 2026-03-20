/**
 * Rex 6-Tier Routing — OpenClaw plugin port
 *
 * Decision tree for routing requests through the right model tier.
 * Zero LLM calls for routing itself — pure heuristics + keyword detection.
 *
 * Tiers:
 *  0. SCRIPT    — instant, 0 tokens, 0 cost
 *  1. LOCAL     — Ollama, fast (<3s), 0 cost, privacy-safe
 *  2. FREE_TIER — Groq/Cerebras (Ollama fallback), 0 cost
 *  3. SONNET    — Claude subscription, capable
 *  4. OPUS      — Claude subscription, expensive (max 3/day)
 *  5. CODEX     — background worker, non-interactive
 *
 * Ported from: rex/packages/cli/src/brain/orchestration-policy.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type OrchestrationTier = "script" | "local" | "free-tier" | "sonnet" | "opus" | "codex";

export type RoutingDecision = {
  tier: OrchestrationTier;
  model: string;
  provider: string;
  reason: string;
  estimatedCost: "free" | "subscription-low" | "subscription-high";
  confidence: number;
};

// ── Trigger patterns ─────────────────────────────────────────────────────────

export const SCRIPT_TRIGGERS =
  /\b(git|status|doctor|health|build|test|run|start|stop|restart|install|check|logs?|list|show)\b/i;

const MEMORY_TRIGGERS = /\b(search|find|recall|remember|lookup|memory|what did)\b/i;

export const LOCAL_TRIGGERS =
  /\b(summarize|categorize|classify|tag|translate|explain|quick|simple|format|parse)\b/i;

export const OPUS_TRIGGERS =
  /\b(architect|architecture|design|redesign|strategy|strategic|refactor entire|rewrite|plan|roadmap|audit entire|analyze all|complex agent|orchestrat)\b/i;

export const CODEX_TRIGGERS =
  /\b(modify files?|edit files?|batch|parallel|background|non.interactive|worktree|auto.fix|generate .* files?)\b/i;

const SONNET_COMPLEX_INDICATORS =
  /\b(review|refactor|debug|implement|cross.file|nuanced|explain complex|PR|pull request)\b/i;

// ── PII detection for privacy routing ────────────────────────────────────────

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, // phone
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/, // credit card
  /\b(password|mot de passe|token|secret|api.key|private.key)\s*[:=]\s*\S+/i,
];

export type DataSensitivity = "public" | "internal" | "sensitive";

export function classifyDataSensitivity(message: string): DataSensitivity {
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(message)) return "sensitive";
  }
  if (/\b(internal|confidential|privé|secret)\b/i.test(message)) return "internal";
  return "public";
}

export function stripPII(message: string): string {
  let result = message;
  result = result.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]");
  result = result.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "[PHONE]");
  result = result.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]");
  result = result.replace(/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/g, "[CARD]");
  result = result.replace(
    /\b(password|mot de passe|token|secret|api.key|private.key)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
  return result;
}

// ── Opus budget guard ────────────────────────────────────────────────────────

const opusCalls = new Map<string, number>();
let opusDailyLimit = 3;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function canCallOpus(): boolean {
  return (opusCalls.get(todayKey()) ?? 0) < opusDailyLimit;
}

export function recordOpusCall(): void {
  const today = todayKey();
  opusCalls.set(today, (opusCalls.get(today) ?? 0) + 1);
}

export function getOpusUsageToday(): { used: number; limit: number } {
  return { used: opusCalls.get(todayKey()) ?? 0, limit: opusDailyLimit };
}

export function setOpusDailyLimit(limit: number): void {
  opusDailyLimit = Math.max(1, limit);
}

// ── Ollama health check ──────────────────────────────────────────────────────

let ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

export function setOllamaUrl(url: string): void {
  ollamaUrl = url;
}

async function checkOllamaAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Task type inference ──────────────────────────────────────────────────────

function inferLocalModel(msg: string): string {
  if (/\b(code|function|class|implement|fix bug|debug)\b/i.test(msg)) return "qwen3-coder:30b";
  if (/\b(think|reason|why|how does|explain complex)\b/i.test(msg)) return "qwen3:30b";
  if (/\b(summarize|categorize|classify|tag)\b/i.test(msg)) return "qwen2.5:1.5b";
  return "qwen3.5:9b";
}

function forceModelToTier(model: string): OrchestrationTier {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet") || model.includes("claude")) return "sonnet";
  if (model === "codex") return "codex";
  return "local";
}

function modelToProvider(model: string): string {
  if (model.includes("claude")) return "anthropic";
  if (model.includes("groq/") || model.includes("llama")) return "groq";
  if (model.includes("qwen") || model.includes("deepseek")) return "ollama";
  if (model === "codex") return "openai";
  return "ollama";
}

// ── Main routing function ────────────────────────────────────────────────────

const LOCAL_MAX_TOKENS = 2000;

export interface RoutingContext {
  ollamaAvailable?: boolean;
  contextPercent?: number;
  forceModel?: string;
}

/**
 * Route a request to the appropriate model tier.
 * Pure heuristics, 0 LLM calls for the routing decision itself.
 */
export async function routeRequest(
  message: string,
  context: RoutingContext = {},
): Promise<RoutingDecision> {
  // Force override
  if (context.forceModel) {
    const tier = forceModelToTier(context.forceModel);
    return {
      tier,
      model: context.forceModel,
      provider: modelToProvider(context.forceModel),
      reason: `forced: ${context.forceModel}`,
      estimatedCost: context.forceModel.includes("opus") ? "subscription-high" : "subscription-low",
      confidence: 1,
    };
  }

  const msg = message.toLowerCase();
  const msgLen = message.length;

  // Tier 0: Script / CLI op
  if (SCRIPT_TRIGGERS.test(msg) && msgLen < 200) {
    return {
      tier: "script",
      model: "none",
      provider: "none",
      reason: "script/CLI op",
      estimatedCost: "free",
      confidence: 0.9,
    };
  }
  if (MEMORY_TRIGGERS.test(msg)) {
    return {
      tier: "script",
      model: "none",
      provider: "none",
      reason: "memory search (SQL)",
      estimatedCost: "free",
      confidence: 0.85,
    };
  }

  // Tier 5: Codex (background / context overflow)
  if (CODEX_TRIGGERS.test(msg)) {
    return {
      tier: "codex",
      model: "codex",
      provider: "openai",
      reason: "file modification / parallel task",
      estimatedCost: "free",
      confidence: 0.85,
    };
  }
  if ((context.contextPercent ?? 0) > 80) {
    return {
      tier: "codex",
      model: "codex",
      provider: "openai",
      reason: "context >80%, offload to Codex",
      estimatedCost: "free",
      confidence: 0.9,
    };
  }

  // Tier 4: Opus (architecture / orchestration)
  if (OPUS_TRIGGERS.test(msg)) {
    if (canCallOpus()) {
      recordOpusCall();
      return {
        tier: "opus",
        model: "claude-opus-4-6",
        provider: "anthropic",
        reason: "architecture/strategy keyword",
        estimatedCost: "subscription-high",
        confidence: 0.9,
      };
    }
    return {
      tier: "sonnet",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      reason: "Opus daily limit hit, Sonnet fallback",
      estimatedCost: "subscription-low",
      confidence: 0.7,
    };
  }

  // Tier 3: Sonnet (complex / cross-file / nuanced)
  const isComplex = msgLen > 800 || SONNET_COMPLEX_INDICATORS.test(msg);
  if (isComplex) {
    return {
      tier: "sonnet",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      reason: "complex/nuanced task",
      estimatedCost: "subscription-low",
      confidence: 0.8,
    };
  }

  // Privacy routing: sensitive data stays local
  const sensitivity = classifyDataSensitivity(message);
  if (sensitivity === "sensitive") {
    const ollamaUp = context.ollamaAvailable ?? (await checkOllamaAlive());
    if (ollamaUp) {
      return {
        tier: "local",
        model: inferLocalModel(msg),
        provider: "ollama",
        reason: "sensitive data detected, routing to local model",
        estimatedCost: "free",
        confidence: 0.95,
      };
    }
    // If Ollama is down and data is sensitive, still prefer Sonnet over free tier
    return {
      tier: "sonnet",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      reason: "sensitive data, Ollama offline, Sonnet (trusted provider) fallback",
      estimatedCost: "subscription-low",
      confidence: 0.7,
    };
  }

  // Tier 1: Local (Ollama)
  const ollamaUp = context.ollamaAvailable ?? (await checkOllamaAlive());
  if (ollamaUp && msgLen < LOCAL_MAX_TOKENS) {
    const model = inferLocalModel(msg);
    return {
      tier: "local",
      model,
      provider: "ollama",
      reason: `local model for ${msg.length < 100 ? "simple" : "medium"} task`,
      estimatedCost: "free",
      confidence: 0.85,
    };
  }

  // Tier 2: Free tier (Ollama offline)
  if (!ollamaUp && msgLen < LOCAL_MAX_TOKENS) {
    return {
      tier: "free-tier",
      model: "groq/llama-3.1-70b",
      provider: "groq",
      reason: "Ollama offline, free tier API",
      estimatedCost: "free",
      confidence: 0.75,
    };
  }

  // Fallback: Sonnet
  return {
    tier: "sonnet",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    reason: "default fallback",
    estimatedCost: "subscription-low",
    confidence: 0.6,
  };
}
