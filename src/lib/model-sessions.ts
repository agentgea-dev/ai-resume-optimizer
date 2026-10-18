import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import type { DrawModel } from "@/lib/generate-types";

export type Provider = "groq" | "anthropic";

type ModelSpec =
  | { provider: "anthropic"; id: string; fallback: boolean; effort: boolean }
  | { provider: "groq"; id: string };

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

// Haiku 5.5 has no server-side fallback. Sonnet 5.5 and Opus 5.5 retry a
// declined request on Anthropic's recommended model instead of failing it.
// Opus 4 is deprecated and supports neither fallback nor the effort setting.
const ANTHROPIC_SPECS = {
  haiku: { provider: "anthropic", id: "claude-haiku-5-5", fallback: false, effort: true },
  sonnet: { provider: "anthropic", id: "claude-sonnet-5-5", fallback: true, effort: true },
  opus: { provider: "anthropic", id: "claude-opus-5-5", fallback: true, effort: true },
  opus4: { provider: "anthropic", id: "claude-opus-4-0", fallback: false, effort: false },
} as const satisfies Record<Exclude<DrawModel, "groq">, ModelSpec>;

// Set explicitly: Haiku 5.5 and Opus 5.5 default to medium, Sonnet 5.5 to high.
const ANTHROPIC_EFFORT = "medium" as const;

function groqSpec(): ModelSpec {
  return { provider: "groq", id: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL };
}

export function providerOf(model: DrawModel): Provider {
  return model === "groq" ? "groq" : "anthropic";
}

// Planning is a cheap list-making step, so it runs on the provider's small
// default model; only the drawing model is selectable.
export function planSpec(provider: Provider): ModelSpec {
  return provider === "groq" ? groqSpec() : ANTHROPIC_SPECS.haiku;
}

export function drawSpec(model: DrawModel): ModelSpec {
  return model === "groq" ? groqSpec() : ANTHROPIC_SPECS[model];
}

export function modelId(model: DrawModel): string {
  return drawSpec(model).id;
}

export function missingCredentials(provider: Provider): string | null {
  if (provider === "groq") {
    return process.env.GROQ_API_KEY
      ? null
      : "GROQ_API_KEY belum diatur di server (.env.local).";
  }
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? null
    : "ANTHROPIC_API_KEY belum diatur di server (.env.local).";
}

// Groq's free tier allows far fewer tokens per minute than Anthropic's
// entry tier, so it runs fewer drawings at once and retries 429s longer.
export function concurrencyFor(provider: Provider): number {
  return provider === "groq" ? 4 : 8;
}

export type UserTurn = { text: string; imagePng?: Buffer };
export type Reply = { text: string; truncated: boolean; refused: boolean };

// One conversation with one model. Each provider keeps its history in its
// own format, so Claude's thinking blocks go back unchanged.
export interface ChatSession {
  send(turn: UserTurn): Promise<Reply>;
}

export type SessionOptions = {
  // Joined into the system prompt; the last block is cached where supported.
  system: string[];
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
};

export type Clients = { anthropic?: Anthropic; groq?: Groq };

export function createClients(provider: Provider): Clients {
  return provider === "groq"
    ? { groq: new Groq({ maxRetries: 8 }) }
    : { anthropic: new Anthropic({ maxRetries: 5 }) };
}

export function openSession(
  spec: ModelSpec,
  options: SessionOptions,
  clients: Clients,
): ChatSession {
  if (spec.provider === "groq") {
    if (!clients.groq) throw new Error("Groq client is not configured");
    return groqSession(clients.groq, spec.id, options);
  }
  if (!clients.anthropic) throw new Error("Anthropic client is not configured");
  return anthropicSession(clients.anthropic, spec, options);
}

function anthropicSession(
  client: Anthropic,
  spec: Extract<ModelSpec, { provider: "anthropic" }>,
  { system, jsonSchema, maxTokens, signal }: SessionOptions,
): ChatSession {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = system.map(
    (text, i) =>
      i === system.length - 1 && system.length > 1
        ? { type: "text", text, cache_control: { type: "ephemeral" } }
        : { type: "text", text },
  );

  return {
    async send(turn) {
      messages.push({
        role: "user",
        content: turn.imagePng
          ? [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: turn.imagePng.toString("base64"),
                },
              },
              { type: "text", text: turn.text },
            ]
          : turn.text,
      });
      const outputConfig: Anthropic.Beta.BetaOutputConfig = {
        ...(spec.effort && { effort: ANTHROPIC_EFFORT }),
        ...(jsonSchema && { format: { type: "json_schema", schema: jsonSchema } }),
      };
      const reply = await client.beta.messages
        .stream(
          {
            model: spec.id,
            max_tokens: maxTokens,
            system: systemBlocks,
            messages,
            ...(Object.keys(outputConfig).length > 0 && {
              output_config: outputConfig,
            }),
            ...(spec.fallback && {
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            }),
          },
          { signal },
        )
        .finalMessage();
      if (reply.stop_reason === "refusal") {
        return { text: "", truncated: false, refused: true };
      }
      // Thinking blocks must go back unchanged, so append the whole content.
      messages.push({ role: "assistant", content: reply.content });
      return {
        text: reply.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
        truncated: reply.stop_reason === "max_tokens",
        refused: false,
      };
    },
  };
}

function groqSession(
  client: Groq,
  model: string,
  { system, jsonSchema, maxTokens, signal }: SessionOptions,
): ChatSession {
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system.join("\n\n") },
  ];

  return {
    async send(turn) {
      messages.push({
        role: "user",
        content: turn.imagePng
          ? [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${turn.imagePng.toString("base64")}`,
                },
              },
              { type: "text", text: turn.text },
            ]
          : turn.text,
      });
      const completion = await client.chat.completions.create(
        {
          model,
          messages,
          max_completion_tokens: maxTokens,
          // JSON mode works on more Groq models than strict json_schema; the
          // caller validates the shape itself.
          ...(jsonSchema && { response_format: { type: "json_object" } }),
        },
        { signal },
      );
      const choice = completion.choices[0];
      const content = choice?.message.content ?? "";
      messages.push({ role: "assistant", content });
      return {
        // Some reasoning models (e.g. Qwen 3) return their reasoning inline.
        text: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
        truncated: choice?.finish_reason === "length",
        refused: false,
      };
    },
  };
}

// Errors that would repeat for every request in the set.
export function isFatal(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.BadRequestError ||
    error instanceof Groq.AuthenticationError ||
    error instanceof Groq.PermissionDeniedError ||
    error instanceof Groq.NotFoundError ||
    error instanceof Groq.BadRequestError
  );
}

// A user-facing message for an SDK error, or null when it is not one.
export function describeApiError(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) {
    return "API key Anthropic tidak valid. Periksa ANTHROPIC_API_KEY.";
  }
  if (error instanceof Groq.AuthenticationError) {
    return "API key Groq tidak valid. Periksa GROQ_API_KEY.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return "Model Anthropic ini tidak tersedia (404). Pilih model lain.";
  }
  if (error instanceof Groq.NotFoundError) {
    return `Model Groq "${process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL}" tidak ditemukan. Periksa GROQ_MODEL.`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Batas pemakaian API Anthropic tercapai. Coba lagi sebentar lagi.";
  }
  if (error instanceof Groq.RateLimitError) {
    return "Batas pemakaian Groq tercapai (token per menit). Coba lagi nanti, kurangi jumlah gambar, atau naikkan tier akun Groq.";
  }
  if (error instanceof Groq.BadRequestError) {
    return "Groq menolak permintaan (400). Jika GROQ_MODEL diganti, pastikan model itu mendukung JSON mode dan output panjang.";
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    return `Kesalahan dari API Anthropic (${error.status}).`;
  }
  if (error instanceof Groq.APIError && error.status !== undefined) {
    return `Kesalahan dari API Groq (${error.status}).`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Tidak bisa terhubung ke API Anthropic.";
  }
  if (error instanceof Groq.APIConnectionError) {
    return "Tidak bisa terhubung ke API Groq.";
  }
  return null;
}
