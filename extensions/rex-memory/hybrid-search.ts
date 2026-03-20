// ============================================================================
// Hybrid BM25 + vector search with RRF (Reciprocal Rank Fusion)
// ============================================================================

import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { bufferToEmbedding, generateEmbedding, isZeroVector } from "./embed.js";
import { filterByScope, type MemoryEntry } from "./scoping.js";

// ============================================================================
// Types
// ============================================================================

export type SearchOptions = {
  limit: number;
  scope?: string;
  category?: string;
  minScore?: number;
};

export type SearchResult = {
  id: string;
  content: string;
  score: number;
  category: string | null;
  scope: string;
  matchType: "bm25" | "vector" | "hybrid";
};

// ============================================================================
// Constants
// ============================================================================

// RRF fusion weights: alpha for vector, (1-alpha) for BM25
const VECTOR_WEIGHT = 0.7;
const BM25_WEIGHT = 1 - VECTOR_WEIGHT;
const RRF_K = 60; // RRF smoothing constant
const DEFAULT_MIN_SCORE = 0.01;
const CANDIDATE_MULTIPLIER = 3; // Fetch more candidates than needed for filtering

// ============================================================================
// BM25 search via FTS5
// ============================================================================

type FtsRow = {
  id: string;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  rank: number;
};

function searchBm25(db: Database.Database, query: string, limit: number): FtsRow[] {
  // Escape FTS5 special characters in query
  const sanitized = query.replace(/['"(){}[\]^~*?:\\]/g, " ").trim();
  if (!sanitized) {
    return [];
  }

  try {
    const stmt = db.prepare(`
      SELECT m.id, m.content, m.scope, m.agent_id, m.category,
             m.created_at, m.updated_at, rank
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(sanitized, limit) as FtsRow[];
  } catch {
    // FTS5 query syntax errors are non-fatal
    return [];
  }
}

// ============================================================================
// Vector search via cosine similarity
// ============================================================================

type VectorRow = {
  id: string;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  embedding: Buffer;
  created_at: string;
  updated_at: string;
};

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }
  return dot / denominator;
}

function searchVector(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number,
): Array<VectorRow & { similarity: number }> {
  // Fetch all memories with embeddings and compute similarity in-process
  // (sqlite-vec extension not required — pure JS cosine similarity)
  const stmt = db.prepare(`
    SELECT id, content, scope, agent_id, category, embedding, created_at, updated_at
    FROM memories
    WHERE embedding IS NOT NULL
  `);
  const rows = stmt.all() as VectorRow[];

  const scored = rows
    .map((row) => {
      const rowEmbedding = bufferToEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, rowEmbedding);
      return { ...row, similarity };
    })
    .filter((row) => row.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

// ============================================================================
// RRF Fusion
// ============================================================================

type RankedCandidate = {
  id: string;
  content: string;
  scope: string;
  agent_id: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  bm25Rank: number | null;
  vectorRank: number | null;
  rrfScore: number;
};

function fuseResults(
  bm25Results: FtsRow[],
  vectorResults: Array<VectorRow & { similarity: number }>,
): RankedCandidate[] {
  const candidates = new Map<string, RankedCandidate>();

  // Index BM25 results by rank position
  for (let i = 0; i < bm25Results.length; i++) {
    const row = bm25Results[i];
    candidates.set(row.id, {
      id: row.id,
      content: row.content,
      scope: row.scope,
      agent_id: row.agent_id,
      category: row.category,
      created_at: row.created_at,
      updated_at: row.updated_at,
      bm25Rank: i + 1,
      vectorRank: null,
      rrfScore: 0,
    });
  }

  // Index vector results by rank position
  for (let i = 0; i < vectorResults.length; i++) {
    const row = vectorResults[i];
    const existing = candidates.get(row.id);
    if (existing) {
      existing.vectorRank = i + 1;
    } else {
      candidates.set(row.id, {
        id: row.id,
        content: row.content,
        scope: row.scope,
        agent_id: row.agent_id,
        category: row.category,
        created_at: row.created_at,
        updated_at: row.updated_at,
        bm25Rank: null,
        vectorRank: i + 1,
        rrfScore: 0,
      });
    }
  }

  // Compute RRF scores
  for (const candidate of candidates.values()) {
    let score = 0;
    if (candidate.bm25Rank !== null) {
      score += BM25_WEIGHT * (1 / (RRF_K + candidate.bm25Rank));
    }
    if (candidate.vectorRank !== null) {
      score += VECTOR_WEIGHT * (1 / (RRF_K + candidate.vectorRank));
    }
    candidate.rrfScore = score;
  }

  return Array.from(candidates.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

// ============================================================================
// Public API
// ============================================================================

export async function hybridSearch(
  query: string,
  options: SearchOptions,
  embeddingOptions?: { ollamaUrl?: string; model?: string },
): Promise<SearchResult[]> {
  const db = getDb();
  const { limit, scope, category, minScore = DEFAULT_MIN_SCORE } = options;
  const candidateLimit = limit * CANDIDATE_MULTIPLIER;

  // Run BM25 search
  const bm25Results = searchBm25(db, query, candidateLimit);

  // Generate query embedding and run vector search
  const queryEmbedding = await generateEmbedding(query, embeddingOptions);
  const hasValidEmbedding = !isZeroVector(queryEmbedding);
  const vectorResults = hasValidEmbedding ? searchVector(db, queryEmbedding, candidateLimit) : [];

  // Fuse results
  let candidates: RankedCandidate[];

  if (bm25Results.length === 0 && vectorResults.length === 0) {
    return [];
  }

  if (vectorResults.length === 0) {
    // BM25 only (Ollama unavailable)
    candidates = bm25Results.map((row, i) => ({
      id: row.id,
      content: row.content,
      scope: row.scope,
      agent_id: row.agent_id,
      category: row.category,
      created_at: row.created_at,
      updated_at: row.updated_at,
      bm25Rank: i + 1,
      vectorRank: null,
      rrfScore: BM25_WEIGHT * (1 / (RRF_K + i + 1)),
    }));
  } else if (bm25Results.length === 0) {
    // Vector only
    candidates = vectorResults.map((row, i) => ({
      id: row.id,
      content: row.content,
      scope: row.scope,
      agent_id: row.agent_id,
      category: row.category,
      created_at: row.created_at,
      updated_at: row.updated_at,
      bm25Rank: null,
      vectorRank: i + 1,
      rrfScore: VECTOR_WEIGHT * (1 / (RRF_K + i + 1)),
    }));
  } else {
    candidates = fuseResults(bm25Results, vectorResults);
  }

  // Apply scope filtering
  if (scope) {
    const asMemoryEntries: MemoryEntry[] = candidates.map((c) => ({
      id: c.id,
      content: c.content,
      scope: c.scope,
      agent_id: c.agent_id,
      category: c.category,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    const filtered = filterByScope(asMemoryEntries, scope);
    const filteredIds = new Set(filtered.map((f) => f.id));
    candidates = candidates.filter((c) => filteredIds.has(c.id));
  }

  // Apply category filter
  if (category) {
    candidates = candidates.filter((c) => c.category === category);
  }

  // Apply score threshold and limit
  const results: SearchResult[] = candidates
    .filter((c) => c.rrfScore >= minScore)
    .slice(0, limit)
    .map((c) => {
      let matchType: SearchResult["matchType"];
      if (c.bm25Rank !== null && c.vectorRank !== null) {
        matchType = "hybrid";
      } else if (c.vectorRank !== null) {
        matchType = "vector";
      } else {
        matchType = "bm25";
      }

      return {
        id: c.id,
        content: c.content,
        score: c.rrfScore,
        category: c.category,
        scope: c.scope,
        matchType,
      };
    });

  return results;
}
