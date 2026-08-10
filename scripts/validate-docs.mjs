import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const frontmatterSchema = z.object({
  title: z.string().min(1).max(100), description: z.string().min(1).max(200),
  order: z.number().int().nonnegative(), draft: z.boolean(),
  eyebrow: z.string().min(1).max(100), heroLead: z.string().min(1).max(160),
  heroImage: z.string().regex(/^\.\/assets\/[A-Za-z0-9._-]+$/).optional(),
  credits: z.string().min(1).max(200),
}).strict();

export function validateDocs(docsRoot) {
  const pagesRoot = join(docsRoot, "pages");
  const errors = [];
  if (!existsSync(pagesRoot)) throw new Error(`pages directory was not found in ${docsRoot}`);
  for (const entry of readdirSync(pagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      errors.push(`${entry.name}: only kebab-case page directories are allowed`); continue;
    }
    const pageRoot = join(pagesRoot, entry.name);
    for (const child of readdirSync(pageRoot, { withFileTypes: true })) {
      if (child.isSymbolicLink()) { errors.push(`${entry.name}/${child.name}: symbolic links are not allowed`); continue; }
      if (child.name === "index.md" && child.isFile()) continue;
      if (child.name === "assets" && child.isDirectory()) continue;
      errors.push(`${entry.name}/${child.name}: only index.md and assets/ are allowed`);
    }
    const markdownPath = join(pageRoot, "index.md");
    if (!existsSync(markdownPath)) { errors.push(`${entry.name}: index.md is missing`); continue; }
    const source = readFileSync(markdownPath, "utf8");
    if (Buffer.byteLength(source) > 1_000_000) errors.push(`${entry.name}: Markdown exceeds 1 MB`);
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) { errors.push(`${entry.name}: front matter is missing`); continue; }
    const result = frontmatterSchema.safeParse(parseYaml(match[1]));
    if (!result.success) errors.push(...result.error.issues.map((issue) => `${entry.name}${issue.path.join(".")}: ${issue.message}`));
    if (/<\/?(?:script|iframe|object|embed|style|svg|div|img)\b/i.test(match[2])) errors.push(`${entry.name}: raw HTML is not allowed`);
    const assetsRoot = join(pageRoot, "assets");
    if (existsSync(assetsRoot)) {
      for (const asset of readdirSync(assetsRoot, { withFileTypes: true })) {
        const assetPath = resolve(assetsRoot, asset.name);
        if (!assetPath.startsWith(`${resolve(assetsRoot)}${sep}`) || !asset.isFile() || lstatSync(assetPath).isSymbolicLink()) {
          errors.push(`${entry.name}/assets/${asset.name}: unsafe asset`); continue;
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i.test(asset.name)) errors.push(`${entry.name}/assets/${asset.name}: unsupported asset type`);
        if (lstatSync(assetPath).size > 5_000_000) errors.push(`${entry.name}/assets/${asset.name}: asset exceeds 5 MB`);
      }
    }
  }
  if (errors.length) throw new Error(errors.map((error) => `- ${error}`).join("\n"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const docsRoot = resolve(process.argv[2] || process.env.KPW_DOCS_DIR || "../kpw-docs");
  validateDocs(docsRoot);
  console.log(`Validated docs from ${docsRoot}.`);
}
