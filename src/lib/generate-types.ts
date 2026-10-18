export const MAX_PROMPT_LENGTH = 500;
export const MAX_REFINEMENTS = 3;
export const DEFAULT_REFINEMENTS = 2;

export type GenerateRequest = {
  prompt: string;
  refinements: number;
};

// Streamed from /api/generate as newline-delimited JSON.
// A draft's `round` is 0 for the first drawing and 1..n for each refinement.
export type GenerateEvent =
  | { type: "status"; message: string }
  | { type: "draft"; round: number; svg: string; note: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function parseGenerateRequest(
  body: unknown,
): { ok: true; value: GenerateRequest } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body permintaan harus berupa objek JSON." };
  }
  const { prompt, refinements } = body as Record<string, unknown>;

  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    return { ok: false, error: "Deskripsi minimal 3 karakter." };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `Deskripsi maksimal ${MAX_PROMPT_LENGTH} karakter.`,
    };
  }
  if (
    typeof refinements !== "number" ||
    !Number.isInteger(refinements) ||
    refinements < 0 ||
    refinements > MAX_REFINEMENTS
  ) {
    return {
      ok: false,
      error: `Jumlah perbaikan harus 0 sampai ${MAX_REFINEMENTS}.`,
    };
  }
  return { ok: true, value: { prompt: prompt.trim(), refinements } };
}
