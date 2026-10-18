// Minimal client for Ollama's native API. The native /api/chat takes
// options.num_ctx; the OpenAI-compatible endpoint does not, and Ollama's small
// default context window silently drops the start of a long prompt.

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_NUM_CTX = 16_384;
// Local models are slow; a whole drawing has to finish within this.
const TIMEOUT_MS = 10 * 60 * 1000;

// status is null when the server could not be reached at all.
export class OllamaError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export class OllamaTimeoutError extends Error {}

// OLLAMA_HOST follows the Ollama CLI's convention: "host", "host:port" or a URL.
export function ollamaHost(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return DEFAULT_OLLAMA_HOST;
  if (/^https?:\/\//i.test(raw)) return new URL(raw).origin;
  const url = new URL(`http://${raw}`);
  if (!url.port) url.port = "11434";
  return url.origin;
}

function numCtx(): number {
  return Number(process.env.OLLAMA_NUM_CTX) || DEFAULT_NUM_CTX;
}

async function request<T>(
  path: string,
  { body, signal }: { body?: unknown; signal: AbortSignal },
): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await fetch(`${ollamaHost()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (combined.aborted) {
      throw new OllamaTimeoutError(`Ollama did not answer within ${TIMEOUT_MS / 1000} s`);
    }
    throw new OllamaError(null, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new OllamaError(response.status, data?.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

type TagsResponse = {
  models?: {
    name: string;
    details?: { family?: string; families?: string[] | null };
  }[];
};

// Installed chat models, most recently pulled or created first (Ollama's order).
export async function listChatModels(signal: AbortSignal): Promise<string[]> {
  const data = await request<TagsResponse>("/api/tags", { signal });
  return (data.models ?? [])
    .filter((model) => {
      const families = [model.details?.family, ...(model.details?.families ?? [])];
      return (
        !/embed/i.test(model.name) &&
        !families.some((family) => family && /bert/i.test(family))
      );
    })
    .map((model) => model.name);
}

export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

type ChatResponse = { message?: { content?: string }; done_reason?: string };

export async function chat({
  model,
  messages,
  json,
  maxTokens,
  signal,
}: {
  model: string;
  messages: OllamaMessage[];
  json: boolean;
  maxTokens: number;
  signal: AbortSignal;
}): Promise<{ content: string; truncated: boolean }> {
  const ctx = numCtx();
  const data = await request<ChatResponse>("/api/chat", {
    signal,
    body: {
      model,
      messages,
      stream: false,
      ...(json && { format: "json" }),
      // Leave room in the context window for the prompt itself.
      options: { num_ctx: ctx, num_predict: Math.min(maxTokens, Math.floor(ctx / 2)) },
    },
  });
  return {
    content: data.message?.content ?? "",
    truncated: data.done_reason === "length",
  };
}
