import { Agent, fetch } from "undici";

// Minimal client for Ollama's native API. The native /api/chat takes
// options.num_ctx; the OpenAI-compatible endpoint does not, and Ollama's small
// default context window silently drops the start of a long prompt.

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_NUM_CTX = 16_384;
// Local models are slow; a whole drawing has to finish within this.
const TIMEOUT_MS = 10 * 60 * 1000;
// Room left in the context window for the prompt itself.
const PROMPT_RESERVE_TOKENS = 2048;

// With stream:false Ollama sends no headers until generation is done, and a
// queued request waits even longer. undici's default 300 s headers and body
// timeouts would cut those off, so TIMEOUT_MS (an AbortSignal) is the only limit.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// Error codes that mean nothing is listening at OLLAMA_HOST.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
]);

// status is null when nothing answered at OLLAMA_HOST.
export class OllamaError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

export class OllamaTimeoutError extends Error {}

// The connection broke after Ollama accepted the request.
export class OllamaDisconnectedError extends Error {}

// OLLAMA_HOST in the forms the Ollama CLI accepts: a URL, "host", "host:port",
// ":port", or a bare IPv6 address such as "::1". Returns null if it cannot be
// parsed.
export function ollamaHost(): string | null {
  const raw = process.env.OLLAMA_HOST?.trim().replace(/^["']|["']$/g, "");
  if (!raw) return DEFAULT_OLLAMA_HOST;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).origin;
    let hostPort = raw.split("/")[0];
    if (!hostPort.startsWith("[") && (hostPort.match(/:/g) ?? []).length > 1) {
      hostPort = `[${hostPort}]`;
    }
    if (hostPort.startsWith(":")) hostPort = `localhost${hostPort}`;
    const hasPort = /(^[^:\]]+|\]):\d+$/.test(hostPort);
    return new URL(`http://${hostPort}${hasPort ? "" : ":11434"}`).origin;
  } catch {
    return null;
  }
}

function numCtx(): number {
  return Number(process.env.OLLAMA_NUM_CTX) || DEFAULT_NUM_CTX;
}

async function request<T>(
  path: string,
  { body, signal }: { body?: unknown; signal: AbortSignal },
): Promise<T> {
  const host = ollamaHost();
  if (host === null) {
    throw new OllamaError(null, `OLLAMA_HOST "${process.env.OLLAMA_HOST}" is not valid`);
  }
  const combined = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const response = await fetch(`${host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
      dispatcher,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new OllamaError(response.status, data?.error ?? response.statusText);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof OllamaError || signal.aborted) throw error;
    if (combined.aborted) {
      throw new OllamaTimeoutError(`Ollama did not answer within ${TIMEOUT_MS / 1000} s`);
    }
    const code = (error as { cause?: { code?: string } }).cause?.code;
    // Only a failed connection means Ollama is not running; anything else
    // (a dropped connection mid-answer) fails just this request.
    if (code && UNREACHABLE_CODES.has(code)) throw new OllamaError(null, code);
    throw new OllamaDisconnectedError(
      error instanceof Error ? `${error.message}${code ? ` (${code})` : ""}` : String(error),
    );
  }
}

type TagsResponse = {
  models?: {
    name: string;
    remote_host?: string | null;
    remote_model?: string | null;
    details?: { family?: string; families?: string[] | null };
  }[];
};

// Installed chat models that run on this machine, most recently pulled or
// created first (Ollama's order). Embedding models and Ollama Cloud models
// (which run remotely) are skipped.
export async function listChatModels(signal: AbortSignal): Promise<string[]> {
  const data = await request<TagsResponse>("/api/tags", { signal });
  return (data.models ?? [])
    .filter((model) => {
      const families = [model.details?.family, ...(model.details?.families ?? [])];
      return (
        !model.remote_host &&
        !model.remote_model &&
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
      // Reasoning tokens come out of num_predict, so thinking models (Qwen 3,
      // DeepSeek R1) would leave little room for the SVG. gpt-oss cannot turn
      // thinking off, only down. Older Ollama versions ignore the field.
      think: /gpt-oss/i.test(model) ? "low" : false,
      ...(json && { format: "json" }),
      options: {
        num_ctx: ctx,
        num_predict: Math.min(maxTokens, Math.max(1024, ctx - PROMPT_RESERVE_TOKENS)),
      },
    },
  });
  return {
    content: data.message?.content ?? "",
    truncated: data.done_reason === "length",
  };
}
