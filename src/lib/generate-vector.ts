import {
  DRAW_MODEL_LABELS,
  type GenerateEvent,
  type GenerateRequest,
} from "@/lib/generate-types";
import {
  concurrencyFor,
  createClients,
  describeApiError,
  isFatal,
  openSession,
  providerOf,
  resolveSpecs,
  type ChatSession,
  type SessionOptions,
  type UserTurn,
} from "@/lib/model-sessions";
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
  const provider = providerOf(drawModel);
  const clients = createClients(provider);
  const concurrency = concurrencyFor(provider);
  const specs = await resolveSpecs(drawModel, signal);
  // Name the model when the user did not pick it explicitly.
  const modelLabel =
    provider === "anthropic"
      ? DRAW_MODEL_LABELS[drawModel]
      : `${DRAW_MODEL_LABELS[drawModel]} (${specs.draw.id})`;

  emit({
    type: "status",
    message:
      count === 1
        ? "Merancang gambar…"
        : `Menyusun ${count} ide gambar untuk tema ini…`,
  });
  const { style, items } = await planSet(
    openSession(
      specs.plan,
      {
        system: [PLAN_SYSTEM_PROMPT],
        jsonSchema: PLAN_SCHEMA,
        maxTokens: 32_000,
        signal,
      },
      clients,
    ),
    prompt,
    count,
  );
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
    message:
      concurrency === 1
        ? `Menggambar ${items.length} vektor dengan ${modelLabel}, satu per satu…`
        : `Menggambar ${items.length} vektor dengan ${modelLabel}, ${Math.min(concurrency, items.length)} sekaligus…`,
  });

  const stopAll = new AbortController();
  const onAbort = () => stopAll.abort();
  signal.addEventListener("abort", onAbort);
  const drawOptions: SessionOptions = {
    // The set context is shared by every drawing, so it is the cached block.
    system: [DRAW_SYSTEM_PROMPT, setContextPrompt(prompt, style)],
    maxTokens: 16_000,
    signal: stopAll.signal,
  };

  let succeeded = 0;
  let failed = 0;
  try {
    await forEachConcurrent(items, concurrency, stopAll.signal, async (item, index) => {
      try {
        const session = openSession(specs.draw, drawOptions, clients);
        const result = await drawItem(session, item, refinements);
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
  session: ChatSession,
  theme: string,
  count: number,
): Promise<{ style: SetStyle; items: SetItem[] }> {
  let style: SetStyle | null = null;
  const items: SetItem[] = [];
  const seen = new Set<string>();
  let request = planPrompt(theme, count);

  for (let attempt = 0; attempt <= MAX_PLAN_TOP_UPS; attempt++) {
    const reply = await session.send({ text: request });
    if (reply.refused) {
      throw new UserFacingError(
        "Model menolak tema ini. Coba ubah deskripsinya.",
      );
    }

    const plan = parsePlan(reply.text);
    style ??= plan?.style ?? null;
    for (const item of plan?.items ?? []) {
      const key = item.title.trim().toLowerCase();
      if (seen.has(key) || items.length >= count) continue;
      seen.add(key);
      items.push(item);
    }
    if (items.length >= count) break;
    request = morePlanItemsPrompt(count - items.length);
  }

  if (items.length === 0 || style === null) {
    throw new UserFacingError(
      "Model gagal menyusun daftar gambar. Coba lagi atau ubah deskripsinya.",
    );
  }
  return { style, items };
}

function parsePlan(text: string): { style: SetStyle; items: SetItem[] } | null {
  // Models without a strict JSON mode may wrap the object in a fence or prose.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
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
  session: ChatSession,
  item: SetItem,
  refinements: number,
): Promise<{ svg: string; note: string }> {
  // Asserted rather than annotated so TS keeps the union across loop iterations.
  let best = null as { svg: string; note: string } | null;
  let lastProblems: string[] = [];
  let round = 0;
  let repairs = 0;
  let turn: UserTurn = { text: drawItemPrompt(item) };

  for (;;) {
    const reply = await session.send(turn);
    if (reply.refused) throw new UserFacingError("Ditolak oleh model.");

    const result = extractSvg(reply.text);
    if (!result.ok) {
      lastProblems = reply.truncated
        ? [...result.problems, "jawaban terpotong karena terlalu panjang"]
        : result.problems;
      if (repairs >= MAX_REPAIRS) break;
      repairs++;
      turn = { text: repairPrompt(lastProblems) };
      continue;
    }

    if (result.svg === best?.svg) break;
    best = { svg: result.svg, note: noteFrom(reply.text) };
    if (round >= refinements) break;
    round++;
    turn = { text: REFINE_PROMPT, imagePng: renderPng(result.svg) };
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

function noteFrom(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<svg[\s>][\s\S]*<\/svg>/i, "")
    .trim();
}

export function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  return (
    describeApiError(error) ??
    "Terjadi kesalahan tak terduga. Detailnya ada di log server."
  );
}
