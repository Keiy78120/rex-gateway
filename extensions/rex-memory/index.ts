/**
 * Rex Memory — OpenClaw Extension Plugin
 *
 * Hybrid BM25+vector search with multi-tenant scoping and semantic categorization.
 * Replaces memory-core with a SQLite-backed system using Ollama embeddings.
 */

import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { categorizeBatch, getUncategorizedMemories, VALID_CATEGORIES } from "./categorize.js";
import { closeDb, initDb } from "./db.js";
import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from "./embed.js";
import { hybridSearch } from "./hybrid-search.js";
import {
  addPending,
  getMemoryCount,
  getPendingCount,
  ingestDirect,
  processPending,
} from "./ingest.js";
import { validateScope } from "./scoping.js";
import { syncFromBrain, syncToAgent } from "./shared-memory.js";

// ============================================================================
// Plugin config parsing
// ============================================================================

type RexMemoryConfig = {
  dbPath?: string;
  ollamaUrl: string;
  embeddingModel: string;
  categorizationModel: string;
  brainVpsUrl?: string;
};

function parseConfig(raw: unknown): RexMemoryConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    ollamaUrl: typeof cfg.ollamaUrl === "string" ? cfg.ollamaUrl : DEFAULT_OLLAMA_URL,
    embeddingModel: typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : DEFAULT_MODEL,
    categorizationModel:
      typeof cfg.categorizationModel === "string" ? cfg.categorizationModel : "qwen2.5:1.5b",
    brainVpsUrl: typeof cfg.brainVpsUrl === "string" ? cfg.brainVpsUrl : undefined,
  };
}

// ============================================================================
// Plugin entry
// ============================================================================

export default definePluginEntry({
  id: "rex-memory",
  name: "Rex Memory",
  description: "Hybrid BM25+vector search with multi-tenant scoping and semantic categorization",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const embeddingOpts = { ollamaUrl: cfg.ollamaUrl, model: cfg.embeddingModel };
    const categorizeOpts = { ollamaUrl: cfg.ollamaUrl, model: cfg.categorizationModel };

    // Initialize database
    const db = initDb(cfg.dbPath);
    api.logger.info(`rex-memory: initialized (db: ${cfg.dbPath ?? "~/.rex-memory/rex-memory.db"})`);

    // ======================================================================
    // Tool: memory_search — hybrid BM25+vector search
    // ======================================================================

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search through Rex memory using hybrid BM25+vector search. Use when you need context about past decisions, code patterns, debugging history, or project information.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          scope: Type.Optional(
            Type.String({ description: "Scope filter: global, kevin, dstudio, or * for all" }),
          ),
          category: Type.Optional(
            Type.String({
              description:
                "Category filter: code, architecture, debugging, personal, project, reference, decision, pattern",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 10,
            scope,
            category,
          } = params as {
            query: string;
            limit?: number;
            scope?: string;
            category?: string;
          };

          const results = await hybridSearch(query, { limit, scope, category }, embeddingOpts);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.matchType}|${r.category ?? "uncategorized"}] ${r.content.slice(0, 200)} (score: ${r.score.toFixed(4)})`,
            )
            .join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
            details: {
              count: results.length,
              results: results.map((r) => ({
                id: r.id,
                content: r.content.slice(0, 500),
                score: r.score,
                category: r.category,
                scope: r.scope,
                matchType: r.matchType,
              })),
            },
          };
        },
      },
      { name: "memory_search" },
    );

    // ======================================================================
    // Tool: memory_ingest — add to memory
    // ======================================================================

    api.registerTool(
      {
        name: "memory_ingest",
        label: "Memory Ingest",
        description:
          "Store information in Rex memory. Use for saving important context, decisions, patterns, and code snippets.",
        parameters: Type.Object({
          content: Type.String({ description: "Information to remember" }),
          scope: Type.Optional(
            Type.String({ description: "Scope: global, kevin, dstudio (default: global)" }),
          ),
          category: Type.Optional(
            Type.String({
              description:
                "Category: code, architecture, debugging, personal, project, reference, decision, pattern",
            }),
          ),
          source: Type.Optional(Type.String({ description: "Source identifier (default: agent)" })),
        }),
        async execute(_toolCallId, params) {
          const {
            content,
            scope = "global",
            category,
            source = "agent",
          } = params as {
            content: string;
            scope?: string;
            category?: string;
            source?: string;
          };

          const memory = await ingestDirect(content, { scope, category, source }, embeddingOpts);

          return {
            content: [
              {
                type: "text",
                text: `Stored memory: "${content.slice(0, 100)}..." (id: ${memory.id.slice(0, 8)}, scope: ${scope})`,
              },
            ],
            details: { action: "created", id: memory.id, scope },
          };
        },
      },
      { name: "memory_ingest" },
    );

    // ======================================================================
    // Tool: memory_categorize — auto-categorize uncategorized memories
    // ======================================================================

    api.registerTool(
      {
        name: "memory_categorize",
        label: "Memory Categorize",
        description: "Auto-categorize uncategorized memories using local LLM.",
        parameters: Type.Object({
          batchSize: Type.Optional(
            Type.Number({ description: "Number of memories to categorize (default: 50)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { batchSize = 50 } = params as { batchSize?: number };

          const uncategorized = getUncategorizedMemories(batchSize);
          if (uncategorized.length === 0) {
            return {
              content: [{ type: "text", text: "All memories are already categorized." }],
              details: { categorized: 0 },
            };
          }

          await categorizeBatch(uncategorized, batchSize, categorizeOpts);

          return {
            content: [
              {
                type: "text",
                text: `Categorized ${uncategorized.length} memories.`,
              },
            ],
            details: { categorized: uncategorized.length },
          };
        },
      },
      { name: "memory_categorize" },
    );

    // ======================================================================
    // Commands: /search, /ingest, /categorize
    // ======================================================================

    api.registerCommand({
      name: "search",
      description: "Search Rex memory (hybrid BM25+vector)",
      acceptsArgs: true,
      handler: async (ctx) => {
        const query = (ctx.args ?? "").trim();
        if (!query) {
          return { text: "Usage: /search <query>" };
        }

        const results = await hybridSearch(
          query,
          { limit: 5, scope: ctx.senderId ? undefined : "*" },
          embeddingOpts,
        );

        if (results.length === 0) {
          return { text: "No relevant memories found." };
        }

        const lines = results.map(
          (r, i) => `${i + 1}. [${r.matchType}|${r.category ?? "?"}] ${r.content.slice(0, 150)}`,
        );

        return { text: lines.join("\n") };
      },
    });

    api.registerCommand({
      name: "ingest",
      description: "Add content to Rex memory",
      acceptsArgs: true,
      handler: async (ctx) => {
        const content = (ctx.args ?? "").trim();
        if (!content) {
          return { text: "Usage: /ingest <content>" };
        }

        const pendingId = addPending(content, {
          scope: "global",
          agentId: ctx.senderId,
          source: "command",
        });

        return {
          text: `Added to pending queue (id: ${pendingId}). Will be embedded on next processing cycle.`,
        };
      },
    });

    api.registerCommand({
      name: "categorize",
      description: "Auto-categorize uncategorized memories",
      handler: async () => {
        const uncategorized = getUncategorizedMemories(50);
        if (uncategorized.length === 0) {
          return { text: "All memories are already categorized." };
        }

        await categorizeBatch(uncategorized, 50, categorizeOpts);
        return { text: `Categorized ${uncategorized.length} memories.` };
      },
    });

    // ======================================================================
    // CLI: rex-memory subcommands
    // ======================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program.command("rex-memory").description("Rex Memory management commands");

        mem
          .command("search")
          .description("Search memories (hybrid BM25+vector)")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .option("--scope <scope>", "Scope filter")
          .option("--category <cat>", "Category filter")
          .action(
            async (query: string, opts: { limit: string; scope?: string; category?: string }) => {
              const results = await hybridSearch(
                query,
                {
                  limit: parseInt(opts.limit, 10),
                  scope: opts.scope,
                  category: opts.category,
                },
                embeddingOpts,
              );

              if (results.length === 0) {
                console.log("No results found.");
                return;
              }

              for (const r of results) {
                console.log(
                  `[${r.matchType}|${r.category ?? "?"}] (${r.score.toFixed(4)}) ${r.content.slice(0, 120)}`,
                );
              }
            },
          );

        mem
          .command("ingest")
          .description("Add content to pending ingest queue")
          .argument("<content>", "Content to ingest")
          .option("--scope <scope>", "Memory scope", "global")
          .option("--source <source>", "Source identifier", "cli")
          .action((content: string, opts: { scope: string; source: string }) => {
            const id = addPending(content, { scope: opts.scope, source: opts.source });
            console.log(`Added to pending queue (id: ${id})`);
          });

        mem
          .command("process")
          .description("Process pending ingest queue")
          .option("--batch <n>", "Batch size", "30")
          .action(async (opts: { batch: string }) => {
            const result = await processPending(parseInt(opts.batch, 10), embeddingOpts);
            console.log(`Processed: ${result.processed}, errors: ${result.errors}`);
          });

        mem
          .command("categorize")
          .description("Auto-categorize uncategorized memories")
          .option("--batch <n>", "Batch size", "50")
          .action(async (opts: { batch: string }) => {
            const entries = getUncategorizedMemories(parseInt(opts.batch, 10));
            if (entries.length === 0) {
              console.log("All memories are categorized.");
              return;
            }
            await categorizeBatch(entries, parseInt(opts.batch, 10), categorizeOpts);
            console.log(`Categorized ${entries.length} memories.`);
          });

        mem
          .command("stats")
          .description("Show memory statistics")
          .action(() => {
            const total = getMemoryCount();
            const pending = getPendingCount();
            const uncategorized = getUncategorizedMemories(1).length;
            console.log(`Memories: ${total}`);
            console.log(`Pending:  ${pending}`);
            console.log(`Uncategorized: ${uncategorized > 0 ? "yes" : "none"}`);
          });

        mem
          .command("sync")
          .description("Sync memories with brain VPS")
          .option("--agent <id>", "Agent to sync to")
          .option("--scope <scope>", "Scope for sync", "global")
          .action(async (opts: { agent?: string; scope: string }) => {
            if (opts.agent) {
              const result = await syncToAgent(opts.agent, opts.scope);
              console.log(`Pushed ${result.pushed} memories to ${opts.agent}`);
            } else if (cfg.brainVpsUrl) {
              const result = await syncFromBrain(cfg.brainVpsUrl);
              console.log(
                `Pulled ${result.pulled} memories from brain (${result.conflicts} conflicts)`,
              );
            } else {
              console.log("No brain VPS URL configured. Use --agent <id> or set brainVpsUrl.");
            }
          });
      },
      { commands: ["rex-memory"] },
    );

    // ======================================================================
    // Service: background pending processing
    // ======================================================================

    let processingInterval: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "memory-ingest-worker",
      start: () => {
        api.logger.info("rex-memory: ingest worker started");
        // Process pending every 60 seconds
        processingInterval = setInterval(async () => {
          try {
            const result = await processPending(30, embeddingOpts);
            if (result.processed > 0) {
              api.logger.info(
                `rex-memory: processed ${result.processed} pending memories (${result.errors} errors)`,
              );
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            api.logger.error(`rex-memory: ingest worker error: ${message}`);
          }
        }, 60_000);
      },
      stop: () => {
        if (processingInterval) {
          clearInterval(processingInterval);
          processingInterval = null;
        }
        closeDb();
        api.logger.info("rex-memory: ingest worker stopped");
      },
    });
  },
});
