import Anthropic from "@anthropic-ai/sdk";
import type { GenerateEvent, GenerateRequest } from "@/lib/generate-types";
import {
  REFINE_PROMPT,
  SYSTEM_PROMPT,
  firstDraftPrompt,
  repairPrompt,
} from "@/lib/prompts";
import { extractSvg, renderPng } from "@/lib/svg";

const MODEL = "claude-opus-5-5";
// Opus 5.5 defaults to medium; raise it for better drawings at the cost of latency.
const EFFORT = "medium";
const MAX_TOKENS = 32_000;

// An error whose message is safe to show to the user as-is.
export class UserFacingError extends Error {}

// Draws the description, then repeatedly shows the model its own rendered
// output so it can fix what looks wrong. Every usable SVG is emitted as a
// draft; the last one is the result.
export async function generateVector(
  { prompt, refinements }: GenerateRequest,
  emit: (event: GenerateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: firstDraftPrompt(prompt) },
  ];
  let lastSvg: string | null = null;
  let repairing = false;

  for (let round = 0; round <= refinements; round++) {
    emit({
      type: "status",
      message:
        round === 0
          ? "Merancang dan menggambar ilustrasi…"
          : repairing
            ? `Meminta model memperbaiki SVG (putaran ${round} dari ${refinements})…`
            : `Memeriksa hasil render, perbaikan ${round} dari ${refinements}…`,
    });

    const reply = await client.beta.messages
      .stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: EFFORT },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: SYSTEM_PROMPT,
          messages,
        },
        { signal },
      )
      .finalMessage();

    if (reply.stop_reason === "refusal") {
      throw new UserFacingError(
        "Model menolak permintaan ini. Coba ubah deskripsinya.",
      );
    }
    // Thinking blocks must go back unchanged, so append the whole content.
    messages.push({ role: "assistant", content: reply.content });

    const text = reply.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    const result = extractSvg(text);

    if (!result.ok) {
      const problems =
        reply.stop_reason === "max_tokens"
          ? [...result.problems, "jawaban terpotong karena terlalu panjang"]
          : result.problems;
      emit({
        type: "status",
        message: `SVG belum bisa dipakai (${problems.join("; ")}).`,
      });
      messages.push({ role: "user", content: repairPrompt(problems) });
      repairing = true;
      continue;
    }
    repairing = false;

    if (result.svg === lastSvg) {
      emit({ type: "status", message: "Tidak ada lagi yang perlu diperbaiki." });
      break;
    }
    lastSvg = result.svg;
    emit({ type: "draft", round, svg: result.svg, note: noteFrom(text) });

    if (round < refinements) {
      messages.push({
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: renderPng(result.svg).toString("base64"),
            },
          },
          { type: "text", text: REFINE_PROMPT },
        ],
      });
    }
  }

  if (lastSvg === null) {
    throw new UserFacingError(
      "Model tidak menghasilkan SVG yang valid. Coba lagi atau ubah deskripsinya.",
    );
  }
}

function noteFrom(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<svg[\s>][\s\S]*<\/svg>/i, "")
    .trim();
}

export function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) {
    return "API key Anthropic tidak valid. Periksa ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Batas pemakaian API tercapai. Coba lagi sebentar lagi.";
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    return `Kesalahan dari API Anthropic (${error.status}). Coba lagi.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Tidak bisa terhubung ke API Anthropic.";
  }
  return "Terjadi kesalahan tak terduga. Detailnya ada di log server.";
}
