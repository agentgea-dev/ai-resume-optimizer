export const MAX_PROMPT_LENGTH = 500;
export const MAX_COUNT = 100;
export const COUNT_OPTIONS = [1, 10, 50, MAX_COUNT] as const;
export const DEFAULT_COUNT = MAX_COUNT;
export const MAX_REFINEMENTS = 2;
export const DEFAULT_REFINEMENTS = 0;

export type GenerateRequest = {
  prompt: string;
  count: number;
  refinements: number;
};

export type PlannedItem = { index: number; title: string };

// Streamed from /api/generate as newline-delimited JSON. `plan` lists every
// item up front; each then finishes with exactly one `item` or `item_error`.
export type GenerateEvent =
  | { type: "status"; message: string }
  | { type: "plan"; items: PlannedItem[] }
  | { type: "item"; index: number; svg: string; note: string }
  | { type: "item_error"; index: number; message: string }
  | { type: "done"; succeeded: number; failed: number }
  | { type: "error"; message: string };

export function parseGenerateRequest(
  body: unknown,
): { ok: true; value: GenerateRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body permintaan harus berupa objek JSON." };
  }
  const { prompt, count, refinements } = body as Record<string, unknown>;

  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    return { ok: false, error: "Deskripsi minimal 3 karakter." };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `Deskripsi maksimal ${MAX_PROMPT_LENGTH} karakter.`,
    };
  }
  if (!isIntInRange(count, 1, MAX_COUNT)) {
    return { ok: false, error: `Jumlah gambar harus 1 sampai ${MAX_COUNT}.` };
  }
  if (!isIntInRange(refinements, 0, MAX_REFINEMENTS)) {
    return {
      ok: false,
      error: `Jumlah perbaikan harus 0 sampai ${MAX_REFINEMENTS}.`,
    };
  }
  return { ok: true, value: { prompt: prompt.trim(), count, refinements } };
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}
