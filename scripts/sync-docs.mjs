import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { validateDocs } from "./validate-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(process.env.KPW_DOCS_DIR || join(root, "..", "kpw-docs"));
const sourcePages = join(docsRoot, "pages");
const sourceSchema = join(docsRoot, "content.schema.json");
const sourceNavigation = join(docsRoot, "navigation.yml");

if (!existsSync(sourcePages) || !existsSync(sourceSchema) || !existsSync(sourceNavigation)) {
  throw new Error(`kpw-docs was not found at ${docsRoot}. Set KPW_DOCS_DIR to its checkout.`);
}
validateDocs(docsRoot);

const contentTarget = join(root, "src", "generated-content");
const publicTarget = join(root, "public", "content");
const generatedAssetTarget = join(root, "public", "generated", "v1");
rmSync(contentTarget, { recursive: true, force: true });
rmSync(publicTarget, { recursive: true, force: true });
rmSync(generatedAssetTarget, { recursive: true, force: true });
mkdirSync(contentTarget, { recursive: true });
mkdirSync(publicTarget, { recursive: true });
mkdirSync(generatedAssetTarget, { recursive: true });
cpSync(sourcePages, join(contentTarget, "pages"), { recursive: true });
cpSync(sourceSchema, join(contentTarget, "content.schema.json"));
cpSync(sourceNavigation, join(contentTarget, "navigation.yml"));
cpSync(sourcePages, publicTarget, {
  recursive: true,
  filter: (source) => !source.endsWith("index.md"),
});

const responsiveWidths = [320, 480, 640, 960, 1280];
const responsiveImages = {};
let originalImageBytes = 0;
let responsiveImageBytes = 0;

for (const pageEntry of readdirSync(join(contentTarget, "pages"), { withFileTypes: true })) {
  const assetsRoot = join(contentTarget, "pages", pageEntry.name, "assets");
  if (!pageEntry.isDirectory() || !existsSync(assetsRoot)) continue;
  for (const assetEntry of readdirSync(assetsRoot, { withFileTypes: true })) {
    if (!assetEntry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(assetEntry.name)) continue;
    const assetPath = join(assetsRoot, assetEntry.name);
    const metadata = await sharp(assetPath).metadata();
    if (!metadata.width || !metadata.height) continue;
    const originalBytes = statSync(assetPath).size;
    const widths = [...new Set([
      ...responsiveWidths.filter((width) => width < metadata.width),
      Math.min(metadata.width, responsiveWidths.at(-1)),
    ])].sort((left, right) => left - right);
    const variants = [];
    for (const width of widths) {
      const variantName = `${basename(assetEntry.name, extname(assetEntry.name))}.${width}w.responsive.webp`;
      const variantPath = join(assetsRoot, variantName);
      await sharp(assetPath)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 74, effort: 4 })
        .toFile(variantPath);
      const bytes = statSync(variantPath).size;
      if (bytes >= originalBytes) {
        rmSync(variantPath);
        continue;
      }
      variants.push({
        width,
        modulePath: `/src/generated-content/pages/${pageEntry.name}/assets/${variantName}`,
      });
      responsiveImageBytes += bytes;
    }
    if (variants.length > 0) {
      responsiveImages[`${pageEntry.name}/assets/${assetEntry.name}`] = {
        width: metadata.width,
        height: metadata.height,
        variants,
      };
      originalImageBytes += originalBytes;
    }
  }
}

for (const width of [64, 96, 128, 192]) {
  await sharp(join(root, "public", "favicon-512.png"))
    .resize({ width })
    .webp({ quality: 86, alphaQuality: 100, smartSubsample: true, effort: 6 })
    .toFile(join(generatedAssetTarget, `brand-logo-${width}.webp`));
}

writeFileSync(
  join(contentTarget, "responsive-images.json"),
  `${JSON.stringify(responsiveImages, null, 2)}\n`,
);

const schema = JSON.parse(readFileSync(sourceSchema, "utf8"));
console.log(`Synced docs from ${docsRoot} using schema ${schema.title}.`);
console.log(`Generated ${Object.keys(responsiveImages).length} responsive image sets (${(originalImageBytes / 1_000_000).toFixed(2)} MB originals, ${(responsiveImageBytes / 1_000_000).toFixed(2)} MB total variants).`);
