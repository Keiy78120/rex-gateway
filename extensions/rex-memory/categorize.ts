// ============================================================================
// Auto-categorization of memories (Ollama qwen2.5:1.5b + regex fallback)
// ============================================================================

import { getDb } from "./db.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryEntryForCategorization = {
  id: string;
  content: string;
  category: string | null;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:1.5b";
const VALID_CATEGORIES = [
  "code",
  "architecture",
  "debugging",
  "personal",
  "project",
  "reference",
  "decision",
  "pattern",
] as const;

type Category = (typeof VALID_CATEGORIES)[number];

const CATEGORIZE_PROMPT = `Classify the following text into exactly ONE category.
Categories: code, architecture, debugging, personal, project, reference, decision, pattern

Rules:
- code: code snippets, implementations, scripts, commands
- architecture: system design, architecture decisions, infrastructure
- debugging: bug fixes, troubleshooting, error resolution
- personal: personal info, preferences, contacts, accounts
- project: project status, requirements, roadmap, tasks
- reference: documentation links, API references, external resources
- decision: decisions with rationale, trade-offs
- pattern: recurring patterns, best practices, conventions

Respond with ONLY the category name, nothing else.

Text: `;

// ============================================================================
// Regex-based fallback categorization
// ============================================================================

type CategoryPattern = {
  category: Category;
  patterns: RegExp[];
};

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: "code",
    patterns: [
      /\b(function|const|let|var|import|export|class|interface|type|enum)\b/,
      /\b(npm|pnpm|bun|yarn|pip|cargo|flutter|dart)\b/,
      /[{}();].*[{}();]/,
      /\b(async|await|return|throw|try|catch)\b/,
      /```[\s\S]*```/,
      /\b(git|docker|kubectl|ssh|curl|wget)\b/,
    ],
  },
  {
    category: "architecture",
    patterns: [
      /\b(architecture|design|system|infrastructure|microservice|monolith)\b/i,
      /\b(database|schema|migration|API|endpoint|route)\b/i,
      /\b(deploy|ci\/cd|pipeline|docker|kubernetes|cloudflare)\b/i,
      /\b(scale|performance|cache|queue|worker)\b/i,
    ],
  },
  {
    category: "debugging",
    patterns: [
      /\b(bug|fix|error|issue|crash|fail|broken|debug)\b/i,
      /\b(stack trace|exception|warning|deprecat)\b/i,
      /\b(workaround|hotfix|patch|rollback)\b/i,
      /\b(solved|resolved|root cause|regression)\b/i,
    ],
  },
  {
    category: "personal",
    patterns: [
      /\b(prefer|favorite|like|hate|love|want|need)\b/i,
      /\b(account|login|password|token|credential|email)\b/i,
      /\b(phone|address|contact|birthday)\b/i,
      /\b(my\s+\w+|i\s+am|i\s+have|i\s+use)\b/i,
    ],
  },
  {
    category: "project",
    patterns: [
      /\b(project|sprint|milestone|deadline|roadmap|backlog)\b/i,
      /\b(feature|ticket|issue|task|story|epic)\b/i,
      /\b(client|stakeholder|requirement|spec)\b/i,
      /\b(v\d+|version|release|launch)\b/i,
    ],
  },
  {
    category: "reference",
    patterns: [
      /https?:\/\/[^\s]+/,
      /\b(documentation|docs|reference|tutorial|guide)\b/i,
      /\b(api|sdk|library|framework|plugin)\b/i,
      /\b(see|refer|check|read|link)\b/i,
    ],
  },
  {
    category: "decision",
    patterns: [
      /\b(decided|decision|chose|chosen|pick|selected)\b/i,
      /\b(because|reason|rationale|trade-?off|pros?\s+and\s+cons?)\b/i,
      /\b(we\s+will|we\s+should|going\s+to|plan\s+to)\b/i,
      /\b(instead\s+of|rather\s+than|over\s+\w+)\b/i,
    ],
  },
  {
    category: "pattern",
    patterns: [
      /\b(pattern|convention|standard|best\s+practice|anti-?pattern)\b/i,
      /\b(always|never|rule|guideline|principle)\b/i,
      /\b(template|boilerplate|scaffold|skeleton)\b/i,
      /\b(reusable|abstract|generic|common)\b/i,
    ],
  },
];

function categorizeByRegex(content: string): Category {
  let bestCategory: Category = "reference";
  let bestScore = 0;

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ============================================================================
// Ollama-based categorization
// ============================================================================

type OllamaChatResponse = {
  message?: { content?: string };
};

async function categorizeWithOllama(
  content: string,
  options?: { ollamaUrl?: string; model?: string },
): Promise<Category | null> {
  const ollamaUrl = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options?.model ?? DEFAULT_MODEL;

  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `${CATEGORIZE_PROMPT}${content.slice(0, 500)}` }],
        stream: false,
        options: { temperature: 0, num_predict: 10 },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as OllamaChatResponse;
    const result = data.message?.content?.trim().toLowerCase();

    if (!result) {
      return null;
    }

    // Extract category from response (model might add extra text)
    for (const cat of VALID_CATEGORIES) {
      if (result.includes(cat)) {
        return cat;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function categorizeMemory(
  content: string,
  options?: { ollamaUrl?: string; model?: string },
): Promise<string> {
  // Try Ollama first
  const ollamaResult = await categorizeWithOllama(content, options);
  if (ollamaResult) {
    return ollamaResult;
  }

  // Fallback to regex
  return categorizeByRegex(content);
}

export async function categorizeBatch(
  entries: MemoryEntryForCategorization[],
  batchSize: number = 50,
  options?: { ollamaUrl?: string; model?: string },
): Promise<void> {
  const db = getDb();
  const updateStmt = db.prepare(`
    UPDATE memories SET category = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const auditStmt = db.prepare(`
    INSERT INTO audit_log (action, memory_id, details)
    VALUES ('categorize', ?, ?)
  `);

  const batch = entries.slice(0, batchSize);

  for (const entry of batch) {
    try {
      const category = await categorizeMemory(entry.content, options);

      const transaction = db.transaction(() => {
        updateStmt.run(category, entry.id);
        auditStmt.run(entry.id, `category=${category}`);
      });

      transaction();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`rex-memory: failed to categorize ${entry.id}: ${message}`);
    }
  }
}

export function getUncategorizedMemories(limit: number = 100): MemoryEntryForCategorization[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, content, category
    FROM memories
    WHERE category IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `,
    )
    .all(limit) as MemoryEntryForCategorization[];
}

export { VALID_CATEGORIES, type Category };
