// ============================================================================
// Embedding generation via Ollama (nomic-embed-text, 768 dimensions)
// ============================================================================

const VECTOR_DIMS = 768;
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const THROTTLE_MS = 500;

let lastCallTime = 0;

type OllamaEmbeddingResponse = {
  embedding: number[];
};

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < THROTTLE_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed));
  }
  lastCallTime = Date.now();
}

function createZeroVector(): Float32Array {
  return new Float32Array(VECTOR_DIMS);
}

export async function generateEmbedding(
  text: string,
  options?: { ollamaUrl?: string; model?: string },
): Promise<Float32Array> {
  const ollamaUrl = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options?.model ?? DEFAULT_MODEL;

  await throttle();

  try {
    const response = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      console.warn(
        `rex-memory: Ollama embedding request failed (${response.status}): ${errorText}`,
      );
      return createZeroVector();
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;

    if (!data.embedding || !Array.isArray(data.embedding)) {
      console.warn("rex-memory: Ollama returned invalid embedding format");
      return createZeroVector();
    }

    // Pad or truncate to expected dimensions
    const vec = new Float32Array(VECTOR_DIMS);
    const len = Math.min(data.embedding.length, VECTOR_DIMS);
    for (let i = 0; i < len; i++) {
      vec[i] = data.embedding[i];
    }
    return vec;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`rex-memory: Ollama unavailable, returning zero vector. Error: ${message}`);
    return createZeroVector();
  }
}

export async function generateEmbeddings(
  texts: string[],
  options?: { ollamaUrl?: string; model?: string },
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    const embedding = await generateEmbedding(text, options);
    results.push(embedding);
  }
  return results;
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(arrayBuffer);
}

export function isZeroVector(embedding: Float32Array): boolean {
  for (let i = 0; i < embedding.length; i++) {
    if (embedding[i] !== 0) {
      return false;
    }
  }
  return true;
}

export { VECTOR_DIMS, DEFAULT_OLLAMA_URL, DEFAULT_MODEL };
