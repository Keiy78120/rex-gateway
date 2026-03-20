import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelayRole = "enrich" | "analyze" | "decide" | "execute";

export type RelayStep = {
  model: string;
  host: string;
  role: RelayRole;
};

export type StepResult = {
  model: string;
  role: RelayRole;
  response: string;
  tokens: number;
  durationMs: number;
  skipped: boolean;
  error?: string;
};

export type RelayResult = {
  finalResponse: string;
  steps: StepResult[];
  totalTokens: number;
};

type OllamaResponse = {
  message?: { content?: string };
  eval_count?: number;
  prompt_eval_count?: number;
};

type OpenAIResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
};

// ---------------------------------------------------------------------------
// Default chain
// ---------------------------------------------------------------------------

export const DEFAULT_CHAIN: RelayStep[] = [
  { model: "qwen2.5:1.5b", host: "http://localhost:11434", role: "enrich" },
  { model: "llama-3.3-70b-versatile", host: "https://api.groq.com/openai/v1", role: "analyze" },
  { model: "claude-haiku-4-5-20250514", host: "https://api.anthropic.com", role: "decide" },
  { model: "claude-sonnet-4-20250514", host: "https://api.anthropic.com", role: "decide" },
  { model: "claude-opus-4-20250514", host: "https://api.anthropic.com", role: "execute" },
];

// ---------------------------------------------------------------------------
// Role prompts
// ---------------------------------------------------------------------------

const ROLE_PROMPTS: Record<RelayRole, string> = {
  enrich:
    "You are a context enricher. Given the user's question, identify key concepts, extract relevant context, and reformulate the question with additional clarity. Keep it concise.",
  analyze:
    "You are an analyst. Given an enriched question, break down the problem, identify constraints, and list possible approaches. Be structured and brief.",
  decide:
    "You are a decision maker. Given an analyzed problem with possible approaches, select the best approach and explain why. Be decisive and clear.",
  execute:
    "You are the final executor. Given a well-analyzed and decided approach, provide the complete, actionable answer. Be thorough and precise.",
};

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; data: string; statusCode: number }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            data: Buffer.concat(chunks).toString("utf-8"),
            statusCode: res.statusCode ?? 500,
          });
        });
      },
    );

    req.on("error", () => resolve({ ok: false, data: "", statusCode: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, data: "", statusCode: 0 });
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Provider-specific calls
// ---------------------------------------------------------------------------

function isOllamaHost(host: string): boolean {
  return host.includes("localhost:11434") || host.includes("127.0.0.1:11434");
}

function isAnthropicHost(host: string): boolean {
  return host.includes("api.anthropic.com");
}

async function callOllama(
  host: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ response: string; tokens: number }> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    stream: false,
  });

  const result = await httpRequest(`${host}/api/chat`, body, {});
  if (!result.ok) {
    throw new Error(`Ollama returned ${result.statusCode}: ${result.data.slice(0, 200)}`);
  }

  const data = JSON.parse(result.data) as OllamaResponse;
  const content = data.message?.content ?? "";
  const tokens = (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0);
  return { response: content, tokens };
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ response: string; tokens: number }> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const result = await httpRequest(
    "https://api.anthropic.com/v1/messages",
    body,
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    60_000,
  );

  if (!result.ok) {
    throw new Error(`Anthropic returned ${result.statusCode}: ${result.data.slice(0, 200)}`);
  }

  const data = JSON.parse(result.data) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = data.content?.[0]?.text ?? "";
  const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
  return { response: content, tokens };
}

async function callOpenAICompatible(
  host: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ response: string; tokens: number }> {
  // Determine API key from host
  let apiKey = "";
  if (host.includes("groq.com")) {
    apiKey = process.env["GROQ_API_KEY"] ?? "";
  } else if (host.includes("together.xyz")) {
    apiKey = process.env["TOGETHER_API_KEY"] ?? "";
  } else if (host.includes("openai.com")) {
    apiKey = process.env["OPENAI_API_KEY"] ?? "";
  } else if (host.includes("fireworks.ai")) {
    apiKey = process.env["FIREWORKS_API_KEY"] ?? "";
  }

  if (!apiKey) {
    throw new Error(`No API key found for host: ${host}`);
  }

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 4096,
  });

  const url = host.endsWith("/v1") ? `${host}/chat/completions` : `${host}/v1/chat/completions`;

  const result = await httpRequest(
    url,
    body,
    {
      Authorization: `Bearer ${apiKey}`,
    },
    60_000,
  );

  if (!result.ok) {
    throw new Error(
      `OpenAI-compatible API returned ${result.statusCode}: ${result.data.slice(0, 200)}`,
    );
  }

  const data = JSON.parse(result.data) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content ?? "";
  const tokens = data.usage?.total_tokens ?? 0;
  return { response: content, tokens };
}

// ---------------------------------------------------------------------------
// Unified call dispatcher
// ---------------------------------------------------------------------------

async function callModel(
  step: RelayStep,
  systemPrompt: string,
  userMessage: string,
): Promise<{ response: string; tokens: number }> {
  if (isOllamaHost(step.host)) {
    return callOllama(step.host, step.model, systemPrompt, userMessage);
  }
  if (isAnthropicHost(step.host)) {
    return callAnthropic(step.model, systemPrompt, userMessage);
  }
  return callOpenAICompatible(step.host, step.model, systemPrompt, userMessage);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a multi-AI relay chain where each step enriches context.
 * Only the final model gets the fully enriched question.
 * Failed steps are skipped — the chain continues with accumulated context.
 */
export async function relayChain(
  message: string,
  chain: RelayStep[] = DEFAULT_CHAIN,
): Promise<RelayResult> {
  const steps: StepResult[] = [];
  let totalTokens = 0;
  let accumulatedContext = message;

  for (const step of chain) {
    const startMs = Date.now();
    const rolePrompt = ROLE_PROMPTS[step.role];

    // Build input: original message + accumulated context from previous steps
    const input =
      steps.length === 0
        ? accumulatedContext
        : `Original question: ${message}\n\nContext from previous analysis:\n${accumulatedContext}`;

    try {
      const result = await callModel(step, rolePrompt, input);
      const durationMs = Date.now() - startMs;

      steps.push({
        model: step.model,
        role: step.role,
        response: result.response,
        tokens: result.tokens,
        durationMs,
        skipped: false,
      });

      totalTokens += result.tokens;
      accumulatedContext = result.response;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);

      console.warn(`[relay] Step ${step.model} (${step.role}) failed: ${errorMsg} — skipping`);

      steps.push({
        model: step.model,
        role: step.role,
        response: "",
        tokens: 0,
        durationMs,
        skipped: true,
        error: errorMsg,
      });

      // Don't update accumulatedContext — keep previous step's output
    }
  }

  // Final response = last successful step's response
  const lastSuccessful = [...steps].reverse().find((s) => !s.skipped);
  const finalResponse = lastSuccessful?.response ?? `[relay] All steps failed for: ${message}`;

  return { finalResponse, steps, totalTokens };
}
