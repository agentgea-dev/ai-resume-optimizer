import {
  describeError,
  generateVectorSet,
  UserFacingError,
} from "@/lib/generate-vector";
import {
  parseGenerateRequest,
  type GenerateEvent,
} from "@/lib/generate-types";

// A set of 100 drawings with refinements can take several minutes.
export const maxDuration = 800;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY belum diatur di server (.env.local)." },
      { status: 500 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseGenerateRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: GenerateEvent) => {
        if (abort.signal.aborted) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        await generateVectorSet(parsed.value, emit, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        if (!(error instanceof UserFacingError)) {
          console.error("Vector generation failed:", error);
        }
        emit({ type: "error", message: describeError(error) });
      }
      if (!abort.signal.aborted) controller.close();
    },
    // The browser went away (tab closed or "Stop" pressed): stop paying for model calls.
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
