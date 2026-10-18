"use client";

import { useRef, useState } from "react";
import {
  Check,
  Code2,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  Shapes,
  Square,
  Wand2,
} from "lucide-react";
import {
  DEFAULT_REFINEMENTS,
  MAX_PROMPT_LENGTH,
  MAX_REFINEMENTS,
  type GenerateEvent,
} from "@/lib/generate-types";
import { cn } from "@/lib/utils";

type Draft = { round: number; svg: string; note: string };

const EXAMPLES = [
  "Apel merah dengan dua daun hijau",
  "Mercusuar di tepi laut saat senja",
  "Kucing oranye tidur melingkar",
  "Secangkir kopi panas dengan uap",
];

export function VectorGenerator() {
  const [prompt, setPrompt] = useState("");
  const [refinements, setRefinements] = useState(DEFAULT_REFINEMENTS);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selectedRound, setSelectedRound] = useState(0);
  const [resultPrompt, setResultPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canSubmit = !running && prompt.trim().length >= 3;

  async function generate() {
    if (!canSubmit) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setLog([]);
    setDrafts([]);
    setSelectedRound(0);
    setResultPrompt(prompt);
    setError(null);

    const handle = (event: GenerateEvent) => {
      switch (event.type) {
        case "status":
          setLog((prev) => [...prev, event.message]);
          break;
        case "draft":
          setDrafts((prev) => [
            ...prev,
            { round: event.round, svg: event.svg, note: event.note },
          ]);
          setSelectedRound(event.round);
          break;
        case "error":
          setError(event.message);
          break;
      }
    };

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, refinements }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? `Permintaan gagal (${response.status}).`);
        return;
      }

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as GenerateEvent;
          if (event.type === "done" || event.type === "error") finished = true;
          handle(event);
        }
      }
      if (!finished) setError("Koneksi ke server terputus sebelum selesai.");
    } catch (err) {
      if (abort.signal.aborted) {
        setLog((prev) => [...prev, "Dihentikan."]);
      } else {
        setError(
          err instanceof Error ? err.message : "Gagal menghubungi server.",
        );
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  const current =
    drafts.find((draft) => draft.round === selectedRound) ?? drafts.at(-1);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shapes className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Vektor AI</h1>
          <p className="text-sm text-muted-foreground">
            Tulis deskripsi, dapatkan ilustrasi SVG yang bisa diedit.
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="prompt" className="text-sm font-medium">
              Deskripsi
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void generate();
                }
              }}
              maxLength={MAX_PROMPT_LENGTH}
              rows={4}
              disabled={running}
              placeholder="Contoh: rubah merah sedang berlari di padang rumput"
              className="resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={running}
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          <fieldset className="flex flex-col gap-2" disabled={running}>
            <legend className="mb-2 text-sm font-medium">
              Putaran perbaikan visual
            </legend>
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
              {Array.from({ length: MAX_REFINEMENTS + 1 }, (_, n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={refinements === n}
                  onClick={() => setRefinements(n)}
                  className={cn(
                    "rounded-md py-1.5 text-sm transition-colors disabled:opacity-60",
                    refinements === n
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Setiap putaran, model melihat hasil render-nya sendiri lalu
              memperbaiki bagian yang janggal. Lebih banyak putaran berarti
              lebih lama dan lebih mahal.
            </p>
          </fieldset>

          {/* Distinct keys stop React from reusing the submit button's DOM node,
              which made a click on "Hentikan" also submit the form. */}
          {running ? (
            <button
              key="stop"
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium transition-colors hover:bg-accent"
            >
              <Square className="size-4" aria-hidden />
              Hentikan
            </button>
          ) : (
            <button
              key="submit"
              type="submit"
              disabled={!canSubmit}
              className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Wand2 className="size-4" aria-hidden />
              Buat vektor
            </button>
          )}

          {(log.length > 0 || error) && (
            <ol
              aria-live="polite"
              className="flex flex-col gap-1.5 border-t border-border pt-4 text-sm"
            >
              {log.map((message, i) => {
                const active = running && i === log.length - 1;
                return (
                  <li
                    key={i}
                    className={cn(
                      "flex items-start gap-2",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {active ? (
                      <Loader2
                        className="mt-0.5 size-4 shrink-0 animate-spin"
                        aria-hidden
                      />
                    ) : (
                      <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                    )}
                    <span>{message}</span>
                  </li>
                );
              })}
              {error && (
                <li
                  role="alert"
                  className="rounded-md bg-destructive/10 px-3 py-2 text-destructive"
                >
                  {error}
                </li>
              )}
            </ol>
          )}
        </form>

        <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="relative mx-auto aspect-square w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-white">
            {current ? (
              // eslint-disable-next-line @next/next/no-img-element -- data: URL; an <img> also keeps any SVG script from running
              <img
                src={svgDataUrl(current.svg)}
                alt={`Ilustrasi vektor: ${resultPrompt}`}
                className="size-full object-contain"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                {running ? (
                  <>
                    <Loader2 className="size-6 animate-spin" aria-hidden />
                    <span>Menggambar draf pertama…</span>
                  </>
                ) : (
                  <>
                    <ImageIcon className="size-8" aria-hidden />
                    <span>Hasil akan muncul di sini.</span>
                  </>
                )}
              </div>
            )}
          </div>

          {drafts.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {drafts.map((draft) => (
                <button
                  key={draft.round}
                  type="button"
                  onClick={() => setSelectedRound(draft.round)}
                  aria-pressed={draft === current}
                  className={cn(
                    "flex shrink-0 flex-col items-center gap-1 rounded-lg border p-1.5 text-xs transition-colors",
                    draft === current
                      ? "border-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL thumbnail */}
                  <img
                    src={svgDataUrl(draft.svg)}
                    alt=""
                    className="size-16 rounded bg-white object-contain"
                  />
                  {roundLabel(draft.round)}
                </button>
              ))}
            </div>
          )}

          {current && (
            <>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  icon={<Download className="size-4" aria-hidden />}
                  label="Unduh SVG"
                  onClick={() =>
                    downloadBlob(
                      new Blob([current.svg], { type: "image/svg+xml" }),
                      `${slugify(resultPrompt)}.svg`,
                    )
                  }
                />
                <ActionButton
                  icon={<ImageIcon className="size-4" aria-hidden />}
                  label="Unduh PNG"
                  onClick={() => void downloadPng(current.svg, resultPrompt)}
                />
                <CopyButton text={current.svg} />
              </div>

              {current.note && (
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-medium">
                    {current.round === 0
                      ? "Rencana model"
                      : `Catatan ${roundLabel(current.round).toLowerCase()}`}
                  </h2>
                  <p className="whitespace-pre-line text-sm text-muted-foreground">
                    {current.note}
                  </p>
                </div>
              )}

              <details className="group rounded-lg border border-border">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
                  <Code2 className="size-4" aria-hidden />
                  Kode SVG
                </summary>
                <pre className="max-h-80 overflow-auto border-t border-border bg-muted px-3 py-2 text-xs leading-relaxed">
                  <code>{current.svg}</code>
                </pre>
              </details>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-accent"
    >
      {icon}
      {label}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton
      icon={
        copied ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )
      }
      label={copied ? "Tersalin" : "Salin kode"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    />
  );
}

function roundLabel(round: number) {
  return round === 0 ? "Draf awal" : `Perbaikan ${round}`;
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function slugify(text: string) {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "vektor";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadPng(svg: string, prompt: string) {
  const [, , width, height] = (svg.match(/viewBox\s*=\s*"([^"]+)"/)?.[1] ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const aspect = width > 0 && height > 0 ? height / width : 1;

  const image = new Image();
  image.src = svgDataUrl(svg);
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round(1024 * aspect);
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${slugify(prompt)}.png`);
  }, "image/png");
}
