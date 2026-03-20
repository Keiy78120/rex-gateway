import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
}

export interface SessionReflection {
  summary: string;
  patterns: string[];
  mistakes: string[];
  improvements: string[];
  duration: number;
}

export interface KeyDecision {
  type: "routing" | "tool_selection" | "model_choice" | "delegation";
  description: string;
  context: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Satisfaction signals
const POSITIVE_SIGNALS = [
  /\b(thanks|thank you|merci|parfait|perfect|great|excellent|nice|bien)\b/i,
  /\b(exactly|exactement|good job|bien joué|super|bravo)\b/i,
  /\b(that's (right|correct|it)|c'est (ça|correct|bon))\b/i,
  /\u{1F44D}|\u{2764}|\u{1F389}|\u{1F525}/u,
];

const NEGATIVE_SIGNALS = [
  /\b(wrong|incorrect|no|non|faux|pas ça|c'est pas|nope)\b/i,
  /\b(fix|corrige|corriger|mistake|erreur|broken|cassé)\b/i,
  /\b(again|encore|retry|recommence|redo|refais)\b/i,
  /\b(too (long|verbose|slow)|trop (long|verbeux|lent))\b/i,
];

// Patterns that indicate routing/delegation decisions
const ROUTING_PATTERNS = [
  /\b(route|routing|delegate|délègue|forward|transfer)\b/i,
  /\b(agent|model|opus|sonnet|haiku|qwen|ollama)\b/i,
  /\b(tool|outil|function|skill)\b/i,
];

// Patterns that indicate tool usage
const TOOL_PATTERNS = [
  /\b(using|utilise|calling|appel)\s+(tool|outil|function|api)\b/i,
  /tool_call|function_call/i,
  /<tool_call>|<function_calls>/i,
];

// Mistake indicators in assistant responses
const MISTAKE_PATTERNS = [
  /\b(sorry|désolé|apologies|pardon|my (bad|mistake)|erreur de ma part)\b/i,
  /\b(correction|let me (fix|correct)|je (corrige|rectifie))\b/i,
  /\b(actually|en fait|I was wrong|je me suis trompé)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stream-read a JSONL session file into messages. */
async function readSessionMessages(filePath: string): Promise<Message[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const messages: Message[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("role" in parsed) ||
        !("content" in parsed)
      ) {
        continue;
      }
      const msg = parsed as Record<string, unknown>;
      if (typeof msg.role !== "string" || typeof msg.content !== "string") {
        continue;
      }
      if (!["user", "assistant", "system", "tool"].includes(msg.role)) {
        continue;
      }
      messages.push({
        role: msg.role as Message["role"],
        content: msg.content,
        timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/** Compute session duration from first to last timestamped message (in seconds). */
function computeDuration(messages: Message[]): number {
  const timestamps: number[] = [];

  for (const msg of messages) {
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp).getTime();
      if (!Number.isNaN(ts)) {
        timestamps.push(ts);
      }
    }
  }

  if (timestamps.length < 2) {
    return 0;
  }

  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);

  return Math.round((last - first) / 1000);
}

/** Generate a one-line summary of the session based on content. */
function generateSummary(messages: Message[]): string {
  // Use the first user message as the session topic indicator
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) {
    return "Empty session (no user messages)";
  }

  const topicPreview = firstUser.content.slice(0, 120).replace(/\n/g, " ").trim();
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;

  return `${userCount} user / ${assistantCount} assistant messages. Topic: "${topicPreview}${firstUser.content.length > 120 ? "..." : ""}"`;
}

/** Find patterns of tool/routing usage in the session. */
function findPatterns(messages: Message[]): string[] {
  const patterns = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (TOOL_PATTERNS.some((p) => p.test(msg.content))) {
        patterns.add("Uses tool calls");
      }
      if (/```[\s\S]+```/.test(msg.content)) {
        patterns.add("Provides code blocks");
      }
      if (/^\s*[-*\d]+[.)]\s/m.test(msg.content)) {
        patterns.add("Uses structured lists");
      }
    }

    if (msg.role === "user") {
      if (/\b(file|fichier|code|script)\b/i.test(msg.content)) {
        patterns.add("Code-related session");
      }
      if (/\b(deploy|production|prod|server|serveur)\b/i.test(msg.content)) {
        patterns.add("Deployment-related session");
      }
      if (/\b(debug|error|bug|crash)\b/i.test(msg.content)) {
        patterns.add("Debugging session");
      }
    }
  }

  return [...patterns];
}

/** Find self-acknowledged mistakes in assistant responses. */
function findMistakes(messages: Message[]): string[] {
  const mistakes: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    // Check if assistant acknowledged a mistake
    if (MISTAKE_PATTERNS.some((p) => p.test(msg.content))) {
      const preview = msg.content.slice(0, 150).replace(/\n/g, " ").trim();
      mistakes.push(`Self-correction: "${preview}${msg.content.length > 150 ? "..." : ""}"`);
    }

    // Check if user explicitly corrected the assistant
    const nextMsg = messages[i + 1];
    if (nextMsg?.role === "user" && NEGATIVE_SIGNALS.some((p) => p.test(nextMsg.content))) {
      const userPreview = nextMsg.content.slice(0, 100).replace(/\n/g, " ").trim();
      mistakes.push(
        `User correction: "${userPreview}${nextMsg.content.length > 100 ? "..." : ""}"`,
      );
    }
  }

  return mistakes;
}

/** Suggest improvements based on session analysis. */
function suggestImprovements(
  messages: Message[],
  mistakes: string[],
  satisfaction: number,
): string[] {
  const improvements: string[] = [];

  // High mistake count
  if (mistakes.length > 3) {
    improvements.push("High error rate — review response accuracy for this topic");
  }

  // Low satisfaction
  if (satisfaction < 0.4) {
    improvements.push("Low satisfaction score — analyze what went wrong");
  }

  // Long assistant responses without code
  const verboseResponses = messages.filter(
    (m) => m.role === "assistant" && m.content.length > 1000 && !/```/.test(m.content),
  );
  if (verboseResponses.length > 2) {
    improvements.push("Multiple verbose text-only responses — consider being more concise");
  }

  // Too many back-and-forth corrections
  let correctionChains = 0;
  for (let i = 0; i < messages.length - 2; i++) {
    const a = messages[i];
    const b = messages[i + 1];
    const c = messages[i + 2];
    if (
      a?.role === "assistant" &&
      b?.role === "user" &&
      c?.role === "assistant" &&
      NEGATIVE_SIGNALS.some((p) => p.test(b.content))
    ) {
      correctionChains++;
    }
  }
  if (correctionChains > 2) {
    improvements.push("Multiple correction chains — improve first-attempt accuracy");
  }

  // No tool usage when it might have been helpful
  const hasToolUsage = messages.some(
    (m) =>
      m.role === "tool" || (m.role === "assistant" && TOOL_PATTERNS.some((p) => p.test(m.content))),
  );
  const hasCodeQuestions = messages.some(
    (m) => m.role === "user" && /\b(file|fichier|read|lire|search|cherche)\b/i.test(m.content),
  );
  if (!hasToolUsage && hasCodeQuestions) {
    improvements.push("Code questions without tool usage — consider using file/search tools");
  }

  if (improvements.length === 0) {
    improvements.push("Session looks good — no obvious improvements needed");
  }

  return improvements;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a session file and produce a structured reflection.
 * Streaming read for large files.
 */
export async function reflectOnSession(sessionPath: string): Promise<SessionReflection> {
  const messages = await readSessionMessages(sessionPath);

  if (messages.length === 0) {
    return {
      summary: `Empty or unreadable session: ${basename(sessionPath)}`,
      patterns: [],
      mistakes: [],
      improvements: ["No data to analyze"],
      duration: 0,
    };
  }

  const summary = generateSummary(messages);
  const patterns = findPatterns(messages);
  const mistakes = findMistakes(messages);
  const satisfaction = scoreSatisfaction(messages);
  const improvements = suggestImprovements(messages, mistakes, satisfaction);
  const duration = computeDuration(messages);

  return {
    summary,
    patterns,
    mistakes,
    improvements,
    duration,
  };
}

/**
 * Extract key decisions made during a session: routing, tool selections,
 * model choices, and delegation events.
 */
export function extractKeyDecisions(messages: Message[]): KeyDecision[] {
  const decisions: KeyDecision[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }

    const content = msg.content;

    // Check for routing decisions
    if (ROUTING_PATTERNS.some((p) => p.test(content))) {
      let decisionType: KeyDecision["type"] = "routing";

      if (/\b(tool|outil|function|skill)\b/i.test(content)) {
        decisionType = "tool_selection";
      } else if (/\b(model|opus|sonnet|haiku|qwen|ollama)\b/i.test(content)) {
        decisionType = "model_choice";
      } else if (/\b(delegate|délègue|agent|forward)\b/i.test(content)) {
        decisionType = "delegation";
      }

      const preview = content.slice(0, 200).replace(/\n/g, " ").trim();

      decisions.push({
        type: decisionType,
        description: `${preview}${content.length > 200 ? "..." : ""}`,
        context: content.slice(0, 500),
        timestamp: msg.timestamp,
      });
    }
  }

  return decisions;
}

/**
 * Score user satisfaction heuristically based on message patterns.
 * Returns a value between 0 (very unsatisfied) and 1 (very satisfied).
 *
 * - Positive signals (thanks, praise) increase the score
 * - Negative signals (corrections, complaints) decrease the score
 * - Score is weighted toward the end of the session (final impression matters more)
 */
export function scoreSatisfaction(messages: Message[]): number {
  const userMessages = messages.filter((m) => m.role === "user");

  if (userMessages.length === 0) {
    return 0.5; // Neutral for empty sessions
  }

  let positiveCount = 0;
  let negativeCount = 0;

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    if (!msg) {
      continue;
    }
    const content = msg.content;

    // Weight later messages more heavily (recency bias)
    const weight = 1 + (i / userMessages.length) * 0.5;

    if (POSITIVE_SIGNALS.some((p) => p.test(content))) {
      positiveCount += weight;
    }
    if (NEGATIVE_SIGNALS.some((p) => p.test(content))) {
      negativeCount += weight;
    }
  }

  const total = positiveCount + negativeCount;
  if (total === 0) {
    return 0.5; // Neutral when no clear signals
  }

  // Normalize to 0-1 range
  return Math.min(1, Math.max(0, positiveCount / total));
}

/**
 * Export a session reflection as a memory-compatible summary.
 * Writes a JSONL entry that can be ingested into Rex's memory system.
 */
export async function exportReflectionToMemory(
  reflection: SessionReflection,
  outPath: string,
): Promise<void> {
  const memoryEntry = {
    type: "session_reflection",
    timestamp: new Date().toISOString(),
    summary: reflection.summary,
    patterns: reflection.patterns,
    mistakes: reflection.mistakes,
    improvements: reflection.improvements,
    duration_seconds: reflection.duration,
    satisfaction_indicators: {
      mistake_count: reflection.mistakes.length,
      pattern_count: reflection.patterns.length,
      improvement_count: reflection.improvements.length,
    },
  };

  const line = JSON.stringify(memoryEntry) + "\n";

  // Append to existing file
  const { appendFile } = await import("node:fs/promises");
  try {
    await appendFile(outPath, line, "utf-8");
  } catch {
    // If append fails (file doesn't exist yet), create it
    await writeFile(outPath, line, "utf-8");
  }
}
