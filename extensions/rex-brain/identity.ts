/**
 * Rex Identity Layer — OpenClaw plugin port
 *
 * Implements Rex's personality injection and script-first routing.
 * Rex always responds in its own name; LLMs are internal tools.
 *
 * Ported from: rex/packages/cli/src/brain/identity.ts
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Rex system prompt ────────────────────────────────────────────────────────

export const REX_SYSTEM_PROMPT = `You are REX — a living intelligence OS, not a chatbot. You are the brain that orchestrates everything.

Architecture:
- Layer 1 (REX Core): intent detection, memory, signals, scripts, crons, fleet sync. 70% scripts / 30% LLM.
- Layer 2 (REX Code): dev superlayer for Claude Code + Codex. Dynamic context, REX Scan, project-aware tools.
- Layer 3 (REX Relay): multi-AI orchestration via RELAY.md shared document. LLMs collaborate, not compete.

You are NOT Claude, GPT, Qwen, or any other AI. Those are internal tools — you use them, they don't define you.
You assist Kevin (D-Studio) with code, automation, memory, system operations, and proactive discovery.
Kevin speaks French by default. Respond in French unless the conversation is explicitly in English.

Rules:
- Respond concisely and directly — no boilerplate, no fluff
- Never identify as any LLM — you ARE REX
- Use past memory context for informed, personalized answers
- Flag open loops and unresolved issues proactively
- Prefer script/CLI answers over LLM explanations when data is available
- If a script can answer, use it (0 LLM). Script-first, always.
- Never add Co-Authored-By in commits. Never mention AI in PR descriptions.`;

// ── Script-first patterns ────────────────────────────────────────────────────

interface ScriptRule {
  pattern: RegExp;
  handler: (match: RegExpMatchArray, message: string) => Promise<string | null>;
}

const SCRIPT_RULES: ScriptRule[] = [
  {
    pattern: /\b(status|health|doctor|how are you|état|santé)\b/i,
    handler: () => runRex(["doctor", "--json"], "doctor"),
  },
  {
    pattern: /\b(search|cherche|find|trouve|remember|souviens|memory|mémoire)\b[:\s]+(.{3,})/i,
    handler: async (m) => {
      const query = m[2]?.trim();
      if (!query) return null;
      return runRex(["search", query, "--limit=5", "--json"], "search");
    },
  },
  {
    pattern: /\b(budget|token|burn|cost|coût|dépense)\b/i,
    handler: () => runRex(["budget", "--json"], "budget"),
  },
  {
    pattern: /\b(providers?|provider|fournisseur|available models?)\b/i,
    handler: () => runRex(["providers", "--json"], "providers"),
  },
  {
    pattern: /\b(logs?|log|journal|erreur|error|warning)\b/i,
    handler: () => runRex(["logs", "--lines=20"], "logs"),
  },
  {
    pattern: /\b(nodes?|fleet|hub|réseau|network|cluster)\b/i,
    handler: () => runRex(["hub", "status", "--json"], "hub-status"),
  },
  {
    pattern: /\b(projects?|projet|repos?)\b/i,
    handler: () => runRex(["projects", "--json"], "projects"),
  },
  {
    pattern: /\b(curious|discover|new models?|trending|news|actualité)\b/i,
    handler: () => runRex(["curious", "--json"], "curious"),
  },
  {
    pattern: /\b(monitor|activity|activité|commits?|sessions?)\b/i,
    handler: () => runRex(["monitor", "--json"], "monitor"),
  },
];

// ── Intent detection (0 LLM, pure regex) ─────────────────────────────────────

const INTENT_MAP: Record<string, RegExp> = {
  search: /cherch|search|trouv|find|quoi|what|qui|who|montre|show/i,
  create: /crée|create|nouveau|new|génères?|generate|écris|write|fais/i,
  fix: /fix|corrig|répare|bug|erreur|error|casse|broken/i,
  status: /status|état|comment|how|avance|progress|où en|done/i,
  schedule: /planifi|schedule|rappel|reminder|demain|tomorrow|agenda|rdv/i,
  budget: /budget|coût|prix|combien|facture|dépense|cost/i,
  deploy: /deploy|lance|start|démarre|installe|run/i,
  memory: /souviens|remember|rappelle|note|mémorise|oublie/i,
  fleet: /machine|appareil|mac|vps|pc|fleet|node/i,
  code: /\bcode|implement|refactor|build|debug\b/i,
  review: /\breview|analyze|audit|inspect\b/i,
};

export function detectMessageIntent(message: string): string {
  for (const [intent, pattern] of Object.entries(INTENT_MAP)) {
    if (pattern.test(message)) return intent;
  }
  return "general";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findRexBin(): string {
  const candidates = [
    join(homedir(), ".nvm", "versions", "node", "v22.20.0", "bin", "rex"),
    join(homedir(), ".local", "bin", "rex"),
    "/usr/local/bin/rex",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "rex";
}

const REX_BIN = findRexBin();

function runRex(args: string[], label: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15_000);
    execFile(REX_BIN, args, { encoding: "utf-8", timeout: 15_000 }, (err, stdout) => {
      clearTimeout(timeout);
      if (err || !stdout?.trim()) {
        resolve(null);
        return;
      }
      const out = stdout.trim();
      if (args.includes("--json")) {
        try {
          const parsed = JSON.parse(out);
          resolve(JSON.stringify(parsed, null, 2).slice(0, 2000));
          return;
        } catch {
          // fall through
        }
      }
      resolve(out.slice(0, 2000));
    });
  });
}

// ── Script-first attempt ─────────────────────────────────────────────────────

/**
 * Attempt to answer directly from CLI scripts — zero LLM cost.
 * Returns a formatted response string, or null if LLM is needed.
 */
export async function tryScriptFirst(message: string): Promise<string | null> {
  for (const rule of SCRIPT_RULES) {
    const match = message.match(rule.pattern);
    if (match) {
      const result = await rule.handler(match, message);
      if (result) return result;
    }
  }
  return null;
}

// ── Boilerplate stripping ────────────────────────────────────────────────────

const BOILERPLATE_PATTERNS = [
  /^As an AI( assistant)?,?\s*/i,
  /^I('m| am) Claude[,.]?\s*/i,
  /^Hello!?\s*/i,
  /^Sure[!,]?\s*/i,
  /^Of course[!,]?\s*/i,
  /^Certainly[!,]?\s*/i,
  /^Great[!,]?\s*/i,
];

export function stripBoilerplate(text: string): string {
  let result = text.trim();
  for (const pattern of BOILERPLATE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result;
}
