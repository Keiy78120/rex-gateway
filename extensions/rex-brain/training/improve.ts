import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { TrainingEntry } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  filePath: string;
  messages: Message[];
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
}

export type CorrectionCategory =
  | "wrong_answer"
  | "wrong_tool"
  | "wrong_format"
  | "missing_context"
  | "over_verbose";

export interface Correction {
  userMessage: string;
  rexResponse: string;
  userCorrection: string;
  category: CorrectionCategory;
}

export interface Pattern {
  category: CorrectionCategory;
  corrections: Correction[];
  frequency: number;
  commonTriggers: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Phrases that signal a correction from the user. */
const CORRECTION_SIGNALS: Record<CorrectionCategory, RegExp[]> = {
  wrong_answer: [
    /\b(wrong|incorrect|no|non|faux|pas ça|c'est pas|that's not)\b/i,
    /\b(actually|en fait|plutôt|rather)\b/i,
  ],
  wrong_tool: [
    /\b(wrong tool|mauvais outil|don't use|utilise pas|pas cet outil)\b/i,
    /\b(use .+ instead|utilise .+ plutôt)\b/i,
  ],
  wrong_format: [
    /\b(format|formatting|mise en forme|reformat|restructure)\b/i,
    /\b(like this|comme ça|this format|ce format)\b/i,
  ],
  missing_context: [
    /\b(missing|manque|forgot|oublié|also consider|tu as oublié)\b/i,
    /\b(context|contexte|should also|devrait aussi)\b/i,
  ],
  over_verbose: [
    /\b(too (long|verbose|much)|trop (long|verbeux))\b/i,
    /\b(shorter|plus court|concise|succinct|résume|summarize)\b/i,
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a user message is correcting the previous assistant response,
 * and classify the correction category.
 */
function detectCorrection(userMessage: string): CorrectionCategory | null {
  const content = userMessage.trim();

  // Check each category's patterns, return first match
  for (const [category, patterns] of Object.entries(CORRECTION_SIGNALS)) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return category as CorrectionCategory;
      }
    }
  }

  return null;
}

/** Extract short trigger phrases from a message for pattern analysis. */
function extractTriggerWords(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Return unique words, capped at 10 to keep patterns concise
  return [...new Set(words)].slice(0, 10);
}

/** Stream-read a JSONL session file into messages. */
async function readSessionFile(filePath: string): Promise<Message[]> {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze sessions to find places where Rex was corrected by Kevin.
 * A correction is detected when the user responds to an assistant message
 * with a message matching correction signal patterns.
 */
export async function analyzeCorrections(sessions: Session[]): Promise<Correction[]> {
  const corrections: Correction[] = [];

  for (const session of sessions) {
    let messages = session.messages;

    // If messages are empty, try loading from file
    if (messages.length === 0 && session.filePath) {
      try {
        messages = await readSessionFile(session.filePath);
      } catch {
        continue;
      }
    }

    for (let i = 2; i < messages.length; i++) {
      const rexResponse = messages[i - 1];
      const userBefore = messages[i - 2];
      const userAfter = messages[i];

      if (!rexResponse || !userBefore || !userAfter) {
        continue;
      }

      // Pattern: user asks → rex responds → user corrects
      if (
        userBefore.role !== "user" ||
        rexResponse.role !== "assistant" ||
        userAfter.role !== "user"
      ) {
        continue;
      }

      const category = detectCorrection(userAfter.content);
      if (!category) {
        continue;
      }

      corrections.push({
        userMessage: userBefore.content,
        rexResponse: rexResponse.content,
        userCorrection: userAfter.content,
        category,
      });
    }
  }

  return corrections;
}

/**
 * Group corrections by category and extract common patterns.
 */
export function extractPatterns(corrections: Correction[]): Pattern[] {
  // Group by category
  const grouped = new Map<CorrectionCategory, Correction[]>();
  for (const correction of corrections) {
    const existing = grouped.get(correction.category);
    if (existing) {
      existing.push(correction);
    } else {
      grouped.set(correction.category, [correction]);
    }
  }

  const patterns: Pattern[] = [];

  for (const [category, categoryCorrections] of grouped) {
    // Collect trigger words across all corrections in this category
    const triggerCounts = new Map<string, number>();
    for (const c of categoryCorrections) {
      const triggers = extractTriggerWords(c.userMessage);
      for (const trigger of triggers) {
        triggerCounts.set(trigger, (triggerCounts.get(trigger) ?? 0) + 1);
      }
    }

    // Sort triggers by frequency, keep top 10
    const commonTriggers = [...triggerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    patterns.push({
      category,
      corrections: categoryCorrections,
      frequency: categoryCorrections.length,
      commonTriggers,
    });
  }

  // Sort patterns by frequency (most common mistakes first)
  patterns.sort((a, b) => b.frequency - a.frequency);

  return patterns;
}

/**
 * Generate training entries from correction patterns.
 * For each correction where the user provided the right answer,
 * create a training entry using the original question + corrected answer.
 */
export function generateTrainingFromCorrections(patterns: Pattern[]): TrainingEntry[] {
  const entries: TrainingEntry[] = [];

  for (const pattern of patterns) {
    for (const correction of pattern.corrections) {
      const instruction = correction.userMessage.trim();
      const correctedOutput = correction.userCorrection.trim();

      // Skip if the correction is too short to be useful as a training output
      if (instruction.length < 20 || correctedOutput.length < 20) {
        continue;
      }

      // The correction itself becomes the desired output
      // Quality is high because this is explicitly what the user wanted
      entries.push({
        instruction,
        input: `Previous incorrect response: ${truncate(correction.rexResponse, 200)}`,
        output: correctedOutput,
        category: `correction_${pattern.category}`,
        quality_score: 0.9,
      });
    }
  }

  return entries;
}

/** Truncate a string to a max length, adding ellipsis if needed. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}
