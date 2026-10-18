import Anthropic from "@anthropic-ai/sdk";
import {
  DRAW_MODEL_LABELS,
  type DrawModel,
  type GenerateEvent,
  type GenerateRequest,
} from "@/lib/generate-types";
import {
  DRAW_SYSTEM_PROMPT,
  PLAN_SCHEMA,
  PLAN_SYSTEM_PROMPT,
  REFINE_PROMPT,
  drawItemPrompt,
  morePlanItemsPrompt,
  planPrompt,
  repairPrompt,
  setContextPrompt,
  type SetItem,
  type SetStyle,
} from "@/lib/prompts";
import { extractSvg, renderPng } from "@/lib/svg";

// Planning is a cheap list-making step; only the drawing model is selectable.
const PLAN_MODEL = "claude-haiku-5-5";
type DrawModelConfig = { id: string; fallback: boolean; effort: boolean };
// Haiku 5.5 has no server-side fallback. Sonnet 5.5 and Opus 5.5 retry a
// declined drawing on Anthropic's recommended model instead of failing it.
// Opus 4 is deprecated and supports neither fallback nor the effort setting.
const DRAW_MODEL_IDS: Record<DrawModel, DrawModelConfig> = {
  haiku: { id: "claude-haiku-5-5", fallback: false, effort: true },
  sonnet: { id: "claude-sonnet-5-5", fallback: true, effort: true },
  opus: { id: "claude-opus-5-5", fallback: true, effort: true },
  opus4: { id: "claude-opus-4-0", fallback: false, effort: false },
};
// Set explicitly: Haiku 5.5 and Opus 5.5 default to medium, Sonnet 5.5 to high.
const EFFORT = "medium";
// Drawings run in parallel; keep this under the account's requests-per-minute limit.
const CONCURRENCY = 8;
const MAX_PLAN_TOP_UPS = 2;
const MAX_REPAIRS = 1;

// An error whose message is safe to show to the user as-is.
export class UserFacingError extends Error {}

// Plans `count` related subjects with one shared style, then draws them in
// parallel. Each drawing can be refined by showing the model its own render.
// A failed drawing is reported and skipped; errors that would fail every
// drawing (bad key, bad request) stop the whole set.
export async function generateVectorSet(
  { prompt, count, refinements, drawModel }: GenerateRequest,
  emit: (event: GenerateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const client = new Anthropic({ maxRetries: 5 });

  emit({
    type: "status",
    message:
      count === 1
        ? "Merancang gambar…"
        : `Menyusun ${count} ide gambar untuk tema ini…`,
  });
  const { style, items } = await planSet(client, prompt, count, signal);
  if (items.length < count) {
    emit({
      type: "status",
      message: `Model hanya menyusun ${items.length} dari ${count} ide.`,
    });
  }
  emit({
    type: "plan",
    items: items.map((item, index) => ({ index, title: item.title })),
  });
  emit({
    type: "status",
    message: `Menggambar ${items.length} vektor dengan ${DRAW_MODEL_LABELS[drawModel]}, ${Math.min(CONCURRENCY, items.length)} sekaligus…`,
  });

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: DRAW_SYSTEM_PROMPT },
    {
      type: "text",
      text: setContextPrompt(prompt, style),
      cache_control: { type: "ephemeral" },
    },
  ];
  const stopAll = new AbortController();
  const onAbort = () => stopAll.abort();
  signal.addEventListener("abort", onAbort);

  let succeeded = 0;
  let failed = 0;
  try {
    await forEachConcurrent(items, CONCURRENCY, stopAll.signal, async (item, index) => {
      try {
        const result = await drawItem(
          client,
          DRAW_MODEL_IDS[drawModel],
          system,
          item,
          refinements,
          stopAll.signal,
        );
        succeeded++;
        emit({ type: "item", index, ...result });
      } catch (error) {
        if (stopAll.signal.aborted) return;
        if (isFatal(error)) {
          stopAll.abort();
          throw error;
        }
        if (!(error instanceof UserFacingError)) {
          console.error(`Drawing "${item.title}" failed:`, error);
        }
        failed++;
        emit({ type: "item_error", index, message: describeError(error) });
      }
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  emit({ type: "done", succeeded, failed });
}

async function planSet(
  client: Anthropic,
  theme: string,
  count: number,
  signal: AbortSignal,
): Promise<{ style: SetStyle; items: SetItem[] }> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: planPrompt(theme, count) },
  ];
  let style: SetStyle | null = null;
  const items: SetItem[] = [];
  const seen = new Set<string>();

  for (let attempt = 0; attempt <= MAX_PLAN_TOP_UPS; attempt++) {
    const reply = await client.messages
      .stream(
        {
          model: PLAN_MODEL,
          max_tokens: 32_000,
          output_config: {
            effort: EFFORT,
            format: { type: "json_schema", schema: PLAN_SCHEMA },
          },
          system: PLAN_SYSTEM_PROMPT,
          messages,
        },
        { signal },
      )
      .finalMessage();
    if (reply.stop_reason === "refusal") {
      throw new UserFacingError(
        "Model menolak tema ini. Coba ubah deskripsinya.",
      );
    }
    messages.push({ role: "assistant", content: reply.content });

    const plan = parsePlan(replyText(reply));
    style ??= plan?.style ?? null;
    for (const item of plan?.items ?? []) {
      const key = item.title.trim().toLowerCase();
      if (seen.has(key) || items.length >= count) continue;
      seen.add(key);
      items.push(item);
    }
    if (items.length >= count) break;
    messages.push({
      role: "user",
      content: morePlanItemsPrompt(count - items.length),
    });
  }

  if (items.length === 0 || style === null) {
    throw new UserFacingError(
      "Model gagal menyusun daftar gambar. Coba lagi atau ubah deskripsinya.",
    );
  }
  return { style, items };
}

function parsePlan(text: string): { style: SetStyle; items: SetItem[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const { style, items } = (data ?? {}) as { style?: unknown; items?: unknown };
  if (typeof style !== "object" || style === null || !Array.isArray(items)) {
    return null;
  }
  const { palette, notes } = style as { palette?: unknown; notes?: unknown };
  return {
    style: {
      palette: Array.isArray(palette)
        ? palette.filter(
            (color): color is string =>
              typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
          )
        : [],
      notes: typeof notes === "string" ? notes : "",
    },
    items: items.filter(
      (item): item is SetItem =>
        typeof item?.title === "string" &&
        item.title.trim() !== "" &&
        typeof item?.description === "string",
    ),
  };
}

async function drawItem(
  client: Anthropic,
  model: DrawModelConfig,
  system: Anthropic.Beta.BetaTextBlockParam[],
  item: SetItem,
  refinements: number,
  signal: AbortSignal,
): Promise<{ svg: string; note: string }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: drawItemPrompt(item) },
  ];
  // Asserted rather than annotated so TS keeps the union across loop iterations.
  let best = null as { svg: string; note: string } | null;
  let lastProblems: string[] = [];
  let round = 0;
  let repairs = 0;

  for (;;) {
    const reply = await client.beta.messages
      .stream(
        {
          model: model.id,
          max_tokens: 16_000,
          ...(model.effort && { output_config: { effort: EFFORT } }),
          system,
          messages,
          ...(model.fallback && {
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          }),
        },
        { signal },
      )
      .finalMessage();
    if (reply.stop_reason === "refusal") {
      throw new UserFacingError("Ditolak oleh model.");
    }
    // Thinking blocks must go back unchanged, so append the whole content.
    messages.push({ role: "assistant", content: reply.content });

    const text = replyText(reply);
    const result = extractSvg(text);
    if (!result.ok) {
      lastProblems =
        reply.stop_reason === "max_tokens"
          ? [...result.problems, "jawaban terpotong karena terlalu panjang"]
          : result.problems;
      if (repairs >= MAX_REPAIRS) break;
      repairs++;
      messages.push({ role: "user", content: repairPrompt(lastProblems) });
      continue;
    }

    if (result.svg === best?.svg) break;
    best = { svg: result.svg, note: noteFrom(text) };
    if (round >= refinements) break;
    round++;
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

  if (best === null) {
    throw new UserFacingError(`SVG tidak valid (${lastProblems.join("; ")}).`);
  }
  return best;
}

async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) {
      const index = next++;
      await task(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

function replyText(reply: Anthropic.Message | Anthropic.Beta.BetaMessage): string {
  return reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function noteFrom(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<svg[\s>][\s\S]*<\/svg>/i, "")
    .trim();
}

// Errors that would repeat for every drawing in the set.
function isFatal(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.BadRequestError
  );
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
    return `Kesalahan dari API Anthropic (${error.status}).`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Tidak bisa terhubung ke API Anthropic.";
  }
  return "Terjadi kesalahan tak terduga. Detailnya ada di log server.";
}
