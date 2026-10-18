"use client";

import { useEffect, useRef, useState } from "react";
import { strToU8, zipSync } from "fflate";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  FolderDown,
  Image as ImageIcon,
  Loader2,
  Shapes,
  Square,
  Wand2,
  X,
} from "lucide-react";
import {
  COUNT_OPTIONS,
  DEFAULT_COUNT,
  DEFAULT_DRAW_MODEL,
  DEFAULT_REFINEMENTS,
  DRAW_MODEL_LABELS,
  MAX_PROMPT_LENGTH,
  MAX_REFINEMENTS,
  type DrawModel,
  type GenerateEvent,
} from "@/lib/generate-types";
import { cn } from "@/lib/utils";

type Item = { index: number; title: string } & (
  | { status: "pending" }
  | { status: "done"; svg: string; note: string }
  | { status: "failed"; error: string }
);
type DoneItem = Extract<Item, { status: "done" }>;

const EXAMPLES = [
  "Anjungan minyak dan gas lepas pantai",
  "Peralatan dapur",
  "Hewan laut",
  "Transportasi kota",
];

const COUNT_CHOICES = COUNT_OPTIONS.map((n) => ({ value: n, label: String(n) }));
const REFINEMENT_CHOICES = Array.from({ length: MAX_REFINEMENTS + 1 }, (_, n) => ({
  value: n,
  label: String(n),
}));
// Claude costs are relative per drawing at list price (Haiku 5.5 $0.10/$0.50,
// Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Opus 4 $15/$75 per million input/output
// tokens). Scores are from the blind-judged comparison in the README.
const MODEL_CHOICES: { value: DrawModel; label: string; note: string }[] = [
  {
    value: "groq",
    label: "Groq",
    note: "Model open-source lewat Groq (default openai/gpt-oss-120b, bisa diganti dengan GROQ_MODEL). Sangat cepat dan murah, tapi kualitas gambarnya belum diuji. Tier gratis Groq punya batas token per menit yang rendah, jadi set besar bisa lambat.",
  },
  {
    value: "haiku",
    label: "Haiku",
    note: "Claude Haiku: model Claude termurah. Skor uji buta 5,0 dari 10.",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    note: "Claude Sonnet: sekitar 20× biaya Haiku. Paling akurat dalam uji buta (6,3 dari 10).",
  },
  {
    value: "opus",
    label: "Opus",
    note: "Claude Opus: sekitar 40× biaya Haiku. Setara Sonnet dalam uji buta (6,3 dari 10).",
  },
  {
    value: "opus4",
    label: "Opus 4",
    note: "Claude Opus 4: model lama yang sudah deprecated dan bisa dihentikan Anthropic sewaktu-waktu. Sekitar 150× biaya Haiku.",
  },
];

export function VectorGenerator() {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<number>(DEFAULT_COUNT);
  const [refinements, setRefinements] = useState(DEFAULT_REFINEMENTS);
  const [drawModel, setDrawModel] = useState<DrawModel>(DEFAULT_DRAW_MODEL);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [theme, setTheme] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DoneItem | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canSubmit = !running && prompt.trim().length >= 3;
  const done = items.filter((item): item is DoneItem => item.status === "done");
  const failedCount = items.filter((item) => item.status === "failed").length;
  const finishedCount = done.length + failedCount;

  async function generate() {
    if (!canSubmit) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setLog([]);
    setItems([]);
    setTheme(prompt.trim());
    setError(null);

    const handle = (event: GenerateEvent) => {
      switch (event.type) {
        case "status":
          setLog((prev) => [...prev, event.message]);
          break;
        case "plan":
          setItems(event.items.map((item) => ({ ...item, status: "pending" })));
          break;
        case "item":
          setItems((prev) =>
            prev.map((item) =>
              item.index === event.index
                ? { ...item, status: "done", svg: event.svg, note: event.note }
                : item,
            ),
          );
          break;
        case "item_error":
          setItems((prev) =>
            prev.map((item) =>
              item.index === event.index
                ? { ...item, status: "failed", error: event.message }
                : item,
            ),
          );
          break;
        case "done":
          setLog((prev) => [
            ...prev,
            `Selesai: ${event.succeeded} berhasil${event.failed ? `, ${event.failed} gagal` : ""}.`,
          ]);
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
        body: JSON.stringify({ prompt, count, refinements, drawModel }),
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
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
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
      // Stopped or failed mid-set: settle the drawings that never arrived.
      setItems((prev) =>
        prev.map((item) =>
          item.status === "pending"
            ? { ...item, status: "failed", error: "Tidak selesai." }
            : item,
        ),
      );
      setRunning(false);
      abortRef.current = null;
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shapes className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Vektor AI</h1>
          <p className="text-sm text-muted-foreground">
            Tulis satu tema, dapatkan satu set ilustrasi SVG yang bisa diedit.
          </p>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-sm lg:sticky lg:top-6"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="prompt" className="text-sm font-medium">
              Tema
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
              rows={3}
              disabled={running}
              placeholder="Contoh: anjungan minyak dan gas lepas pantai"
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

          <Picker
            legend="Jumlah gambar"
            options={COUNT_CHOICES}
            value={count}
            onChange={setCount}
            disabled={running}
          />
          <Picker
            legend="Model penggambar"
            options={MODEL_CHOICES}
            value={drawModel}
            onChange={(model) => {
              setDrawModel(model);
              if (model === "groq") setRefinements(0);
            }}
            disabled={running}
            hint={MODEL_CHOICES.find((m) => m.value === drawModel)?.note}
          />
          <Picker
            legend="Perbaikan visual per gambar"
            options={REFINEMENT_CHOICES}
            value={refinements}
            onChange={setRefinements}
            disabled={running || drawModel === "groq"}
            hint={
              drawModel === "groq"
                ? `Perbaikan visual mengirim hasil render sebagai gambar, sedangkan model Groq default hanya membaca teks. Total sekitar ${count} panggilan ke Groq, plus 1 untuk perencanaan.`
                : `Setiap putaran, model melihat hasil render-nya sendiri lalu memperbaikinya. Total sekitar ${count * (1 + refinements)} panggilan ke ${DRAW_MODEL_LABELS[drawModel]}, plus 1 ke Claude Haiku untuk perencanaan.`
            }
          />

          {running ? (
            // Distinct keys stop React from reusing the submit button's DOM
            // node, which made a click on "Hentikan" also submit the form.
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
              Buat {count} vektor
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
          {items.length === 0 ? (
            <div className="flex aspect-[16/9] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {running ? (
                <>
                  <Loader2 className="size-6 animate-spin" aria-hidden />
                  <span>Menyusun daftar gambar…</span>
                </>
              ) : (
                <>
                  <ImageIcon className="size-8" aria-hidden />
                  <span>Hasil akan muncul di sini.</span>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="truncate text-sm font-medium">{theme}</h2>
                  <p className="text-xs text-muted-foreground">
                    {done.length} dari {items.length} selesai
                    {failedCount > 0 && `, ${failedCount} gagal`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={done.length === 0}
                  onClick={() => downloadZip(done, theme)}
                  className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-40"
                >
                  <FolderDown className="size-4" aria-hidden />
                  Unduh semua (ZIP)
                </button>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Progres"
                aria-valuemin={0}
                aria-valuemax={items.length}
                aria-valuenow={finishedCount}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${(finishedCount / items.length) * 100}%` }}
                />
              </div>

              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {items.map((item) => (
                  <li key={item.index}>
                    <ItemCard item={item} onOpen={setSelected} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <ItemDialog item={selected} onClose={() => setSelected(null)} />
    </main>
  );
}

function Picker<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  disabled,
  hint,
}: {
  legend: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div
        className="grid gap-1 rounded-lg bg-muted p-1"
        style={{
          gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md py-1.5 text-sm transition-colors disabled:opacity-60",
              value === option.value
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}

function ItemCard({
  item,
  onOpen,
}: {
  item: Item;
  onOpen: (item: DoneItem) => void;
}) {
  const label = (
    <span className="line-clamp-2 text-xs leading-snug">{item.title}</span>
  );

  if (item.status === "done") {
    return (
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex w-full flex-col gap-1.5 rounded-lg border border-border p-2 text-left transition-colors hover:border-muted-foreground"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL; an <img> also keeps any SVG script from running */}
        <img
          src={svgDataUrl(item.svg)}
          alt={item.title}
          className="aspect-square w-full rounded bg-white object-contain"
        />
        {label}
      </button>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border p-2 text-muted-foreground"
      title={item.status === "failed" ? item.error : undefined}
    >
      <div
        className={cn(
          "flex aspect-square w-full flex-col items-center justify-center gap-1 rounded p-2 text-center text-[11px]",
          item.status === "pending"
            ? "animate-pulse bg-muted"
            : "bg-destructive/5",
        )}
      >
        {item.status === "failed" && (
          <>
            <AlertTriangle className="size-5 text-destructive" aria-hidden />
            <span className="line-clamp-3">{item.error}</span>
          </>
        )}
      </div>
      {label}
    </div>
  );
}

function ItemDialog({
  item,
  onClose,
}: {
  item: DoneItem | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (item && !dialog.open) dialog.showModal();
    if (!item && dialog.open) dialog.close();
  }, [item]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      {item && (
        <div className="flex max-h-[calc(100vh-4rem)] flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-medium">{item.title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL preview */}
          <img
            src={svgDataUrl(item.svg)}
            alt={item.title}
            className="mx-auto aspect-square w-full max-w-[400px] rounded-lg border border-border bg-white object-contain"
          />
          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon={<Download className="size-4" aria-hidden />}
              label="Unduh SVG"
              onClick={() =>
                downloadBlob(
                  new Blob([item.svg], { type: "image/svg+xml" }),
                  `${slugify(item.title)}.svg`,
                )
              }
            />
            <ActionButton
              icon={<ImageIcon className="size-4" aria-hidden />}
              label="Unduh PNG"
              onClick={() => void downloadPng(item.svg, item.title)}
            />
            <CopyButton text={item.svg} />
          </div>
          {item.note && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {item.note}
            </p>
          )}
          <details className="rounded-lg border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
              <Code2 className="size-4" aria-hidden />
              Kode SVG
            </summary>
            <pre className="max-h-64 overflow-auto border-t border-border bg-muted px-3 py-2 text-xs leading-relaxed">
              <code>{item.svg}</code>
            </pre>
          </details>
        </div>
      )}
    </dialog>
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

function downloadZip(items: DoneItem[], theme: string) {
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    const number = String(item.index + 1).padStart(3, "0");
    files[`${number}-${slugify(item.title)}.svg`] = strToU8(item.svg);
  }
  const zip = zipSync(files, { level: 6 });
  downloadBlob(
    new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    `${slugify(theme)}.zip`,
  );
}

async function downloadPng(svg: string, name: string) {
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
    if (blob) downloadBlob(blob, `${slugify(name)}.png`);
  }, "image/png");
}
