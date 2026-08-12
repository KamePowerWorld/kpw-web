import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const frontmatterSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(200),
  order: z.number().int().nonnegative(),
  draft: z.boolean(),
  eyebrow: z.string().min(1).max(100),
  heroLead: z.string().min(1).max(160),
  heroImage: z.string().regex(/^\.\/assets\/[A-Za-z0-9._-]+$/).optional(),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface DocPage {
  slug: string;
  filePath: string;
  data: Frontmatter;
  body: string;
  html: string;
  headings: Array<{ depth: number; text: string; id: string }>;
  heroImageUrl?: string;
}

const markdownModules = import.meta.glob<string>("/src/generated-content/pages/*/index.md", {
  eager: true,
  import: "default",
  query: "?raw",
});

function parseDocument(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("Markdown front matter is missing");
  return { data: parseYaml(match[1]), content: match[2] };
}

function headingId(text: string, index: number) {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return normalized || `section-${index}`;
}

export function renderMarkdown(source: string, slug: string) {
  const headings: DocPage["headings"] = [];
  let headingIndex = 0;
  const renderer = new marked.Renderer();

  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    const plainText = tokens.map((token) => "text" in token ? String(token.text) : "").join("");
    const id = headingId(plainText, ++headingIndex);
    if (depth === 2) headings.push({ depth, text: plainText, id });
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };

  renderer.image = ({ href, title, text }) => {
    const sourceUrl = href.startsWith("./assets/")
      ? `/content/${encodeURIComponent(slug)}/${href.slice(2)}`
      : href;
    const safeTitle = title ? ` title="${title.replaceAll('"', "&quot;")}"` : "";
    return `<img src="${sourceUrl}" alt="${text.replaceAll('"', "&quot;")}" loading="lazy"${safeTitle}>`;
  };

  const raw = marked.parse(source, { gfm: true, renderer }) as string;
  const html = sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "loading"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: attribs.href?.startsWith("http")
          ? { ...attribs, target: "_blank", rel: "noopener noreferrer" }
          : attribs,
      }),
    },
  });

  return { html, headings };
}

export function loadPages(options: { includeDrafts?: boolean } = {}): DocPage[] {
  return Object.entries(markdownModules)
    .map(([modulePath, source]) => {
      const slug = modulePath.split("/").at(-2) ?? "";
      const filePath = `pages/${slug}/index.md`;
      const parsed = parseDocument(source);
      const data = frontmatterSchema.parse(parsed.data);
      const { html, headings } = renderMarkdown(parsed.content, slug);
      return {
        slug,
        filePath,
        data,
        body: parsed.content,
        html,
        headings,
        heroImageUrl: data.heroImage
          ? `/content/${encodeURIComponent(slug)}/${data.heroImage.slice(2)}`
          : undefined,
      } satisfies DocPage;
    })
    .filter((page) => options.includeDrafts || !page.data.draft)
    .sort((left, right) => left.data.order - right.data.order || left.data.title.localeCompare(right.data.title, "ja"));
}

export function loadPage(slug: string, options?: { includeDrafts?: boolean }) {
  return loadPages(options).find((page) => page.slug === slug);
}
