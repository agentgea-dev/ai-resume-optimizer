export type SetStyle = { palette: string[]; notes: string };
export type SetItem = { title: string; description: string };

export const OUTLINE_COLOR = "#1B2A33";

export const PLAN_SYSTEM_PROMPT = `You are the art director for a set of flat vector illustrations in a bold-outline mascot style: a uniform near-black outline, chunky simplified shapes, flat cel shading with a base and a shadow tone per material, and one saturated accent color. Given a theme, you choose the subjects for the set and its palette, so the illustrations look like they belong together.

Subjects:
- Every item must be clearly related to the theme and different from every other item. Cover the theme broadly: main structures, equipment and tools, vehicles, people and roles, processes, environment, and simple symbols, as the theme allows. Avoid near-duplicates such as the same object in another color.
- Each subject must work as a single centered object or character on a square white canvas, not as a wide scene. Prefer concrete things that have a recognizable silhouette; avoid abstract ideas.

Fields:
- title: a short name (1 to 4 words) in the same language as the theme.
- description: one or two sentences in English saying what to draw: the subject, its key parts, and the composition.
- style.palette: 6 to 8 hex colors (#RRGGBB) shared by the whole set: first the outline color ${OUTLINE_COLOR}, then a base and a darker shadow tone for two or three neutral materials that suit the theme, then one saturated accent color and its shadow tone.
- style.notes: one or two sentences on what the set has in common beyond the palette (for example level of detail, recurring motifs, character proportions).`;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    style: {
      type: "object",
      properties: {
        palette: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
      required: ["palette", "notes"],
      additionalProperties: false,
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["style", "items"],
  additionalProperties: false,
};

export function planPrompt(theme: string, count: number): string {
  return `Theme: ${theme}

Plan a set of exactly ${count} illustration${count === 1 ? "" : "s"}.`;
}

export function morePlanItemsPrompt(missing: number): string {
  return `The set needs ${missing} more item${missing === 1 ? "" : "s"}. Reply in the same JSON format with only the new items, each different from every item already listed, and repeat the same style.`;
}

// Bold-outline mascot style. Chosen over the earlier plain-geometric prompt in a
// blind-judged comparison of Haiku drawings (overall 6.2 vs 3.7 out of 10).
export const DRAW_SYSTEM_PROMPT = `You are a vector illustrator. You draw polished flat illustrations in a bold-outline mascot style, hand-written as SVG that stays easy to edit in any vector editor.

Canvas and syntax:
- The root element is <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">. (0, 0) is the top-left corner.
- Allowed elements: g, path, circle, ellipse, rect, polygon, polyline, line, defs, clipPath. Fill and stroke with hex colors (#RRGGBB).
- Not allowed: gradients, filters, masks, patterns, text, images, scripts, style blocks, links, event attributes. url() may only point to a clipPath in the same file, as in clip-path="url(#body)". Files that break these rules are rejected.

Style:
- Outline: every visible part has the same dark outline. Put stroke="${OUTLINE_COLOR}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" on the group that wraps the subject so all parts inherit it. Inner details such as feather lines, seams, folds and panel lines use the same color at stroke-width 6 with fill="none".
- Shapes: draw organic parts (bodies, heads, wings, limbs, clothing, smoke, water, leaves) as single path elements with smooth cubic Bézier curves (C and S commands), not as stacks of circles and rectangles. Keep silhouettes chunky, simplified and slightly exaggerated so they read at small sizes. Use rect, circle and polygon only for parts that really are geometric.
- Color: a small palette. Give each material one base color and one darker shadow color of the same hue, and use one saturated accent color against neutral tones.
- Shading: flat cel shading with light from the top left. Each larger part gets one shadow shape on its lower right side, in the part's shadow color with stroke="none". Build each shaded part in this order: (1) the part's shape with its base fill, (2) the shadow shape with clip-path pointing to a clipPath that repeats the part's shape, (3) the part's shape again with fill="none" so its outline sits on top.
- Details: eyes get a small white highlight dot. Characters stand on the ground in a clear three-quarter pose with their feet visible.
- Composition: center the subject so it fills about 65% of the canvas, with empty white space around it. No background and no frame; at most a flat light-gray ellipse under the feet or base, without outline.
- Draw back to front and group the parts of each object with <g>.

Reply format:
- Put the complete SVG in exactly one \`\`\`svg fenced code block.
- Keep the prose outside the code block short, and write it in the same language as the theme.`;

// Shared by every drawing in a set, so it sits in the cached system prefix.
export function setContextPrompt(theme: string, style: SetStyle): string {
  const lines = [
    `This illustration is one of a set on the theme "${theme}". Keep to the set's shared style.`,
  ];
  if (style.palette.length > 0) {
    lines.push(
      `- Palette: ${style.palette.join(", ")}. Use these colors first; add others only when the subject needs them.`,
    );
  }
  if (style.notes) lines.push(`- Style: ${style.notes}`);
  return lines.join("\n");
}

export function drawItemPrompt(item: SetItem): string {
  return `Draw: ${item.title}. ${item.description}

Before the code, write a plan of at most 60 words: the parts, the shape and color for each, and where they sit. Then draw it.`;
}

export const REFINE_PROMPT = `This is your SVG rendered to PNG. Look at it the way a viewer would, against the description. Check for parts that are misplaced, disconnected or hidden behind other shapes, wrong proportions, missing parts, and weak composition or contrast.

List the problems you see in at most 60 words, then return the full corrected SVG. If nothing needs to change, say so and return the same SVG.`;

export function repairPrompt(problems: string[]): string {
  return `Your last reply could not be used: ${problems.join("; ")}. Return the full SVG again, following the canvas and element rules.`;
}
