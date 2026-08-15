import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import navigationSource from "/src/generated-content/navigation.yml?raw";
import responsiveImageManifestSource from "../generated-content/responsive-images.json";

export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const frontmatterSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(100),
  draft: z.boolean(),
  heroLead: z.string().min(1).max(160),
  heroImage: z.string().regex(/^\.\/assets\/[A-Za-z0-9._-]+$/).optional(),
  aliases: z.array(z.string().regex(slugPattern)).default([]),
});

export const navigationNodeSchema: z.ZodType<NavigationNode> = z.lazy(() => z.object({
  id: z.uuid(),
  children: z.array(navigationNodeSchema).optional(),
}));

export const navigationSchema = z.object({ version: z.literal(1), tree: z.array(navigationNodeSchema) });

export type Frontmatter = z.infer<typeof frontmatterSchema>;
export type NavigationNode = { id: string; children?: NavigationNode[] };
export type Navigation = { version: 1; tree: NavigationNode[] };

interface ResponsiveImageManifestEntry {
  width: number;
  height: number;
  variants: Array<{ width: number; modulePath: string }>;
}

export interface ResponsiveImage {
  src: string;
  srcset: string;
  width: number;
  height: number;
}

export interface DocPage {
  id: string;
  slug: string;
  filePath: string;
  data: Frontmatter;
  body: string;
  html: string;
  headings: Array<{ depth: number; text: string; id: string }>;
  heroImageUrl?: string;
  heroImage?: ResponsiveImage;
  canonicalPath: string;
  parentId?: string;
  childIds: string[];
  depth: number;
}

const markdownModules = import.meta.glob<string>("/src/generated-content/pages/*/index.md", {
  eager: true, import: "default", query: "?raw",
});
const responsiveImageModules = import.meta.glob<string>("/src/generated-content/pages/*/assets/*.responsive.webp", {
  eager: true, import: "default", query: "?url",
});
const responsiveImageManifest = responsiveImageManifestSource as Record<string, ResponsiveImageManifestEntry>;

function localAssetUrl(slug: string, assetPath: string) {
  return `/content/${encodeURIComponent(slug)}/${assetPath}`;
}

function getResponsiveImage(slug: string, assetPath: string): ResponsiveImage | undefined {
  const entry = responsiveImageManifest[`${slug}/${assetPath}`];
  if (!entry) return undefined;
  const srcset = entry.variants.map((variant) => {
    const url = responsiveImageModules[variant.modulePath];
    return url ? `${url} ${variant.width}w` : undefined;
  }).filter((item): item is string => Boolean(item)).join(", ");
  if (!srcset) return undefined;
  return { src: localAssetUrl(slug, assetPath), srcset, width: entry.width, height: entry.height };
}

function parseDocument(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("Markdown front matter is missing");
  return { data: parseYaml(match[1]), content: match[2] };
}

function headingId(text: string, index: number) {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/<[^>]+>/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "");
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
    const localAssetPath = href.startsWith("./assets/") ? href.slice(2) : undefined;
    const responsiveImage = localAssetPath ? getResponsiveImage(slug, localAssetPath) : undefined;
    const sourceUrl = localAssetPath ? localAssetUrl(slug, localAssetPath) : href;
    const safeTitle = title ? ` title="${title.replaceAll('"', "&quot;")}"` : "";
    const responsiveAttributes = responsiveImage
      ? ` width="${responsiveImage.width}" height="${responsiveImage.height}" srcset="${responsiveImage.srcset}" sizes="auto, (max-width: 720px) calc(100vw - 48px), 820px"`
      : "";
    return `<img src="${sourceUrl}" alt="${text.replaceAll('"', "&quot;")}" loading="lazy" decoding="async"${responsiveAttributes}${safeTitle}>`;
  };
  const raw = marked.parse(source, { gfm: true, renderer }) as string;
  const html = sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "loading", "decoding", "width", "height", "srcset", "sizes"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"], code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: { a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: attribs.href?.startsWith("http") ? { ...attribs, target: "_blank", rel: "noopener noreferrer" } : attribs,
    }) },
  });
  return { html, headings };
}

export function loadNavigation(): Navigation {
  return navigationSchema.parse(parseYaml(navigationSource));
}

function buildAllPages() {
  const rawPages: DocPage[] = Object.entries(markdownModules).map(([modulePath, source]) => {
    const slug = modulePath.split("/").at(-2) ?? "";
    const parsed = parseDocument(source);
    const data = frontmatterSchema.parse(parsed.data);
    const { html, headings } = renderMarkdown(parsed.content, slug);
    const heroImagePath = data.heroImage?.slice(2);
    return {
      id: data.id, slug, filePath: `pages/${slug}/index.md`, data, body: parsed.content, html, headings,
      heroImageUrl: heroImagePath ? localAssetUrl(slug, heroImagePath) : undefined,
      heroImage: heroImagePath ? getResponsiveImage(slug, heroImagePath) : undefined,
      canonicalPath: slug === "index" ? "/" : `/${slug}`, childIds: [], depth: 0, parentId: undefined,
    } satisfies DocPage;
  });
  const byId = new Map(rawPages.map((page) => [page.id, page]));
  const ordered: DocPage[] = [];
  const visit = (nodes: NavigationNode[], parent: DocPage | undefined, segments: string[], hiddenByDraft: boolean) => {
    for (const node of nodes) {
      const page = byId.get(node.id);
      if (!page) continue;
      page.parentId = parent?.id;
      page.depth = segments.length;
      page.canonicalPath = `/${[...segments, page.slug].join("/")}`;
      page.childIds = (node.children ?? []).map((child) => child.id);
      Object.assign(page, { hiddenByDraft: hiddenByDraft || page.data.draft });
      ordered.push(page);
      visit(node.children ?? [], page, [...segments, page.slug], hiddenByDraft || page.data.draft);
    }
  };
  const index = rawPages.find((page) => page.slug === "index");
  if (index) {
    index.childIds = loadNavigation().tree.map((node) => node.id);
    ordered.push(index);
  }
  visit(loadNavigation().tree, undefined, [], false);
  return { pages: ordered, byId };
}

export function loadPages(options: { includeDrafts?: boolean } = {}): DocPage[] {
  const { pages } = buildAllPages();
  return options.includeDrafts ? pages : pages.filter((page) => !(page as DocPage & { hiddenByDraft?: boolean }).hiddenByDraft);
}

export function loadPageById(id: string, options?: { includeDrafts?: boolean }) {
  return loadPages(options).find((page) => page.id === id);
}

export function loadPageBySlug(slug: string, options?: { includeDrafts?: boolean }) {
  const pages = loadPages(options);
  return pages.find((page) => page.slug === slug) ?? pages.find((page) => page.data.aliases.includes(slug));
}

export function resolvePagePath(pathname: string, options?: { includeDrafts?: boolean }) {
  if (pathname === "/") return loadPages(options).find((page) => page.slug === "index");
  const segments = pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(segments.at(-1) ?? "").toLowerCase();
  if (!slugPattern.test(slug)) return undefined;
  return slug === "index" ? loadPages(options).find((page) => page.slug === "index") : loadPageBySlug(slug, options);
}
