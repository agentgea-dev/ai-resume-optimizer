import { Resvg } from "@resvg/resvg-js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_SVG_BYTES = 200_000;

// Flat shapes only. Anything that can load resources or run code (script,
// image, use, a, foreignObject, animate, style) stays out, so a generated
// file is safe to open directly in a browser.
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "title",
  "desc",
]);

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\son[a-z]+\s*=/i, reason: "atribut event (on...)" },
  { pattern: /(^|[\s:])href\s*=/i, reason: "atribut href" },
  { pattern: /url\s*\(/i, reason: "referensi url()" },
  { pattern: /javascript:/i, reason: "URL javascript:" },
  { pattern: /<!(?!--)/, reason: "deklarasi DOCTYPE/ENTITY/CDATA" },
  { pattern: /<\?(?!xml\s)/, reason: "processing instruction" },
];

export type SvgCheck =
  | { ok: true; svg: string }
  | { ok: false; problems: string[] };

// Pulls the SVG out of a model reply (a ```svg fence, or a bare <svg> element)
// and checks it against the allowlist above.
export function extractSvg(reply: string): SvgCheck {
  const fenced = reply.match(/```(?:svg|xml)?\s*\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : reply;
  const match = candidate.match(/<svg[\s>][\s\S]*<\/svg>/i);
  if (!match) {
    return { ok: false, problems: ["tidak ada elemen <svg> yang lengkap"] };
  }

  let svg = match[0].trim();
  if (!/^<svg[^>]*\sxmlns\s*=/.test(svg)) {
    svg = svg.replace(/^<svg/, `<svg xmlns="${SVG_NAMESPACE}"`);
  }

  const problems = findProblems(svg);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, svg };
}

function findProblems(svg: string): string[] {
  const problems: string[] = [];

  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
    problems.push(`ukuran melebihi ${MAX_SVG_BYTES / 1000} KB`);
  }
  if (!/^<svg[^>]*\sviewBox\s*=/.test(svg)) {
    problems.push("elemen <svg> tidak punya atribut viewBox");
  }

  const disallowed = new Set<string>();
  for (const [, name] of svg.matchAll(/<\/?\s*([A-Za-z][\w.:-]*)/g)) {
    if (!ALLOWED_ELEMENTS.has(name)) disallowed.add(name);
  }
  if (disallowed.size > 0) {
    problems.push(
      `elemen tidak diizinkan: ${[...disallowed].map((n) => `<${n}>`).join(", ")}`,
    );
  }

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(svg)) problems.push(`mengandung ${reason}`);
  }

  if (problems.length === 0) {
    try {
      new Resvg(svg);
    } catch (error) {
      problems.push(
        `SVG tidak bisa diparse: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems;
}

export function renderPng(svg: string, width = 512): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    background: "#ffffff",
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
