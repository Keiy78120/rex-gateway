import { createReadStream, existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingEntry {
  instruction: string;
  input: string;
  output: string;
  category: string;
  quality_score: number;
}

interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_MESSAGE_LENGTH = 20;
const HIGH_QUALITY_LENGTH = 300;
const CORRECTION_BONUS = 0.15;
const MAX_QUALITY_SCORE = 1.0;
const BASE_QUALITY_SCORE = 0.3;

// Patterns that indicate the response is tool-only (no real content)
const TOOL_ONLY_PATTERNS = [
  /^\s*\{.*"tool_call".*\}\s*$/s,
  /^\s*<tool_call>/,
  /^\s*<function_calls>/,
];

// Patterns that suggest a correction from the user
const CORRECTION_PATTERNS = [
  /^(no|non|wrong|incorrect|pas ça|c'est pas|en fait|actually|rather|plutôt)/i,
  /\b(corrige|corriger|fix|correct|wrong|faux|erreur|mistake)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isToolOnlyResponse(content: string): boolean {
  return TOOL_ONLY_PATTERNS.some((pattern) => pattern.test(content));
}

function isCorrection(content: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(content));
}

function categorizeMessage(instruction: string, output: string): string {
  const combined = `${instruction} ${output}`.toLowerCase();

  if (/\b(code|function|class|import|export|const|let|var)\b/.test(combined)) {
    return "coding";
  }
  if (/\b(debug|error|bug|fix|crash|exception|stack\s?trace)\b/.test(combined)) {
    return "debugging";
  }
  if (/\b(explain|what|how|why|comment|pourquoi|qu'est-ce)\b/.test(combined)) {
    return "explanation";
  }
  if (/\b(config|setup|install|deploy|env|environment)\b/.test(combined)) {
    return "configuration";
  }
  if (/\b(refactor|clean|simplify|optimize|améliorer)\b/.test(combined)) {
    return "refactoring";
  }
  if (/\b(test|spec|coverage|assert|expect|vitest|jest)\b/.test(combined)) {
    return "testing";
  }
  if (/\b(git|commit|branch|merge|pr|pull\s?request)\b/.test(combined)) {
    return "git";
  }
  return "general";
}

function scoreQuality(output: string, followedByCorrection: boolean): number {
  let score = BASE_QUALITY_SCORE;

  // Longer, more detailed responses score higher
  const length = output.length;
  if (length > HIGH_QUALITY_LENGTH) {
    score += 0.3;
  } else if (length > 100) {
    score += 0.15;
  }

  // Contains code blocks — likely more useful
  if (/```[\s\S]+```/.test(output)) {
    score += 0.1;
  }

  // Contains structured lists or steps
  if (/^\s*[-*\d]+[.)]\s/m.test(output)) {
    score += 0.05;
  }

  // Correction after this response lowers quality
  if (followedByCorrection) {
    score -= 0.2;
  }

  return Math.min(MAX_QUALITY_SCORE, Math.max(0, score));
}

/** Parse a single JSONL line, returning null on malformed data. */
function parseSessionLine(line: string): SessionMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("role" in parsed) ||
      !("content" in parsed)
    ) {
      return null;
    }
    const msg = parsed as Record<string, unknown>;
    const role = msg.role;
    const content = msg.content;
    if (
      typeof role !== "string" ||
      typeof content !== "string" ||
      !["user", "assistant", "system", "tool"].includes(role)
    ) {
      return null;
    }
    return {
      role: role as SessionMessage["role"],
      content,
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core: stream-read a single session file
// ---------------------------------------------------------------------------

async function readSessionMessages(filePath: string): Promise<SessionMessage[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const messages: SessionMessage[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    const msg = parseSessionLine(line);
    if (msg) {
      messages.push(msg);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Extract Q&A pairs from messages
// ---------------------------------------------------------------------------

function extractPairs(messages: SessionMessage[]): TrainingEntry[] {
  const entries: TrainingEntry[] = [];

  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];

    if (!current || !next) {
      continue;
    }

    // We want user → assistant pairs
    if (current.role !== "user" || next.role !== "assistant") {
      continue;
    }

    const instruction = current.content.trim();
    const output = next.content.trim();

    // Filter short messages
    if (instruction.length < MIN_MESSAGE_LENGTH) {
      continue;
    }
    if (output.length < MIN_MESSAGE_LENGTH) {
      continue;
    }

    // Filter tool-only responses
    if (isToolOnlyResponse(output)) {
      continue;
    }

    // Check if the message after the assistant response is a correction
    const followUp = messages[i + 2];
    const followedByCorrection = followUp?.role === "user" && isCorrection(followUp.content);

    const quality = scoreQuality(output, followedByCorrection);

    // Bonus for corrections that led to a better response
    let adjustedQuality = quality;
    if (followedByCorrection) {
      // The corrected response (if it exists) gets a bonus
      const correctedResponse = messages[i + 3];
      if (
        correctedResponse?.role === "assistant" &&
        correctedResponse.content.length > MIN_MESSAGE_LENGTH
      ) {
        adjustedQuality += CORRECTION_BONUS;
      }
    }

    const category = categorizeMessage(instruction, output);

    entries.push({
      instruction,
      input: "",
      output,
      category,
      quality_score: Math.min(MAX_QUALITY_SCORE, Math.max(0, adjustedQuality)),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a directory of JSONL session files and extract Q&A training pairs.
 * Uses streaming reads to handle large files without loading everything in memory.
 */
export async function collectTrainingData(sessionsDir: string): Promise<TrainingEntry[]> {
  if (!existsSync(sessionsDir)) {
    return [];
  }

  let files: string[];
  try {
    const dirEntries = await readdir(sessionsDir);
    files = dirEntries.filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  if (files.length === 0) {
    return [];
  }

  const allEntries: TrainingEntry[] = [];

  for (const file of files) {
    const filePath = join(sessionsDir, file);
    try {
      const messages = await readSessionMessages(filePath);
      const pairs = extractPairs(messages);
      allEntries.push(...pairs);
    } catch {
      // Skip corrupted/unreadable files
      continue;
    }
  }

  return allEntries;
}

/**
 * Write training entries to a JSONL file in Alpaca format.
 * Each line is a JSON object with { instruction, input, output }.
 */
export async function exportJsonl(entries: TrainingEntry[], outPath: string): Promise<void> {
  const lines = entries.map((entry) =>
    JSON.stringify({
      instruction: entry.instruction,
      input: entry.input,
      output: entry.output,
    }),
  );

  await writeFile(outPath, lines.join("\n") + "\n", "utf-8");
}
