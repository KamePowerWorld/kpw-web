import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const frontmatterSchema = z.object({
  id: z.uuid(), title: z.string().min(1).max(100), draft: z.boolean(), heroLead: z.string().min(1).max(160),
  heroImage: z.string().regex(/^\.\/assets\/[A-Za-z0-9._-]+$/).optional(),
  aliases: z.array(z.string().regex(slugPattern)).default([]),
}).strict();

export function validateDocs(docsRoot) {
  const pagesRoot = join(docsRoot, "pages"); const errors = []; const pagesById = new Map(); const currentSlugs = new Set(); const aliasOwners = new Map();
  if (!existsSync(pagesRoot)) throw new Error(`pages directory was not found in ${docsRoot}`);
  for (const entry of readdirSync(pagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !slugPattern.test(entry.name)) { errors.push(`${entry.name}: only kebab-case page directories are allowed`); continue; }
    currentSlugs.add(entry.name); const pageRoot = join(pagesRoot, entry.name);
    for (const child of readdirSync(pageRoot, { withFileTypes: true })) {
      if (child.isSymbolicLink()) { errors.push(`${entry.name}/${child.name}: symbolic links are not allowed`); continue; }
      if (child.name === "index.md" && child.isFile()) continue;
      if (child.name === "assets" && child.isDirectory()) continue;
      errors.push(`${entry.name}/${child.name}: only index.md and assets/ are allowed`);
    }
    const markdownPath = join(pageRoot, "index.md"); if (!existsSync(markdownPath)) { errors.push(`${entry.name}: index.md is missing`); continue; }
    const source = readFileSync(markdownPath, "utf8"); if (Buffer.byteLength(source) > 1_000_000) errors.push(`${entry.name}: Markdown exceeds 1 MB`);
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/); if (!match) { errors.push(`${entry.name}: front matter is missing`); continue; }
    const result = frontmatterSchema.safeParse(parseYaml(match[1]));
    if (!result.success) errors.push(...result.error.issues.map((issue) => `${entry.name}${issue.path.join(".")}: ${issue.message}`));
    else {
      if (pagesById.has(result.data.id)) errors.push(`${entry.name}: duplicate page id ${result.data.id}`);
      pagesById.set(result.data.id, { slug: entry.name, data: result.data });
      for (const alias of result.data.aliases) {
        if (alias === entry.name) errors.push(`${entry.name}: alias duplicates its current slug`);
        if (aliasOwners.has(alias)) errors.push(`${entry.name}: alias ${alias} is already owned by ${aliasOwners.get(alias)}`);
        aliasOwners.set(alias, entry.name);
      }
    }
    if (/<\/?(?:script|iframe|object|embed|style|svg|div|img)\b/i.test(match[2])) errors.push(`${entry.name}: raw HTML is not allowed`);
    const assetsRoot = join(pageRoot, "assets");
    if (existsSync(assetsRoot)) for (const asset of readdirSync(assetsRoot, { withFileTypes: true })) {
      const assetPath = resolve(assetsRoot, asset.name);
      if (!assetPath.startsWith(`${resolve(assetsRoot)}${sep}`) || !asset.isFile() || lstatSync(assetPath).isSymbolicLink()) { errors.push(`${entry.name}/assets/${asset.name}: unsafe asset`); continue; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i.test(asset.name)) errors.push(`${entry.name}/assets/${asset.name}: unsupported asset type`);
      if (lstatSync(assetPath).size > 5_000_000) errors.push(`${entry.name}/assets/${asset.name}: asset exceeds 5 MB`);
    }
  }
  const index = [...pagesById.values()].find((page) => page.slug === "index");
  if (!index) errors.push("pages/index/index.md is required"); else if (index.data.draft) errors.push("index: top page cannot be private");
  const navigationPath = join(docsRoot, "navigation.yml");
  if (!existsSync(navigationPath)) errors.push("navigation.yml is required");
  else {
    const navigation = parseYaml(readFileSync(navigationPath, "utf8")); const seen = new Set();
    if (navigation?.version !== 1 || !Array.isArray(navigation.tree)) errors.push("navigation.yml: version 1 and tree array are required");
    const visit = (nodes) => { for (const node of nodes ?? []) {
      if (!node || typeof node.id !== "string" || (node.children !== undefined && !Array.isArray(node.children))) { errors.push("navigation.yml: invalid node"); continue; }
      if (seen.has(node.id)) errors.push(`navigation.yml: duplicate page id ${node.id}`); seen.add(node.id);
      const page = pagesById.get(node.id); if (!page) errors.push(`navigation.yml: unknown page id ${node.id}`); if (page?.slug === "index") errors.push("navigation.yml: index must not be included");
      visit(node.children);
    } }; visit(navigation?.tree);
    for (const [id, page] of pagesById) if (page.slug !== "index" && !seen.has(id)) errors.push(`${page.slug}: page is missing from navigation.yml`);
  }
  if (errors.length) throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const docsRoot = resolve(process.argv[2] || process.env.KPW_DOCS_DIR || "../kpw-docs"); validateDocs(docsRoot); console.log(`Validated docs from ${docsRoot}.`);
}
