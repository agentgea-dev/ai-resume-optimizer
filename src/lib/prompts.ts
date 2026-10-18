export type SetStyle = { palette: string[]; notes: string };
export type SetItem = { title: string; description: string };

export const PLAN_SYSTEM_PROMPT = `You are the art director for a set of flat vector illustrations. Given a theme, you choose the subjects for the set and one shared visual style, so the illustrations look like they belong together.

Subjects:
- Every item must be clearly related to the theme and different from every other item. Cover the theme broadly: main structures, equipment and tools, vehicles, people and roles, processes, environment, and simple symbols, as the theme allows. Avoid near-duplicates such as the same object in another color.
- Each subject must be drawable with simple geometric shapes on a square canvas, as one object or a small scene.

Fields:
- title: a short name (1 to 4 words) in the same language as the theme.
- description: one or two sentences in English saying what to draw: the subject, its key parts, and the composition.
- style.palette: 5 to 8 hex colors (#RRGGBB) shared by the whole set.
- style.notes: one or two sentences on the shared look (for example outline use, level of detail, background).`;

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

export const DRAW_SYSTEM_PROMPT = `You are a vector illustrator. You turn short descriptions into clean, flat SVG illustrations built from simple geometric shapes, so the result stays easy to edit in any vector editor.

Canvas and syntax:
- The root element is <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">. (0, 0) is the top-left corner.
- Use only these elements: g, rect, circle, ellipse, line, polyline, polygon, path. Keep each path short; prefer the basic shapes when they fit.
- Fill and stroke with hex colors (#RRGGBB). No gradients, filters, masks, patterns, text, images, scripts, style blocks, links, or event attributes; files that use them are rejected.
- Elements are painted in document order, so draw from back to front. Give parts that sit on top of each other clearly different colors.

Drawing:
- Make the subject recognizable at a glance, with believable proportions and parts that connect where they should.
- Center the composition and leave a comfortable margin.
- Group the parts of each object with <g> so they can be selected together.

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
