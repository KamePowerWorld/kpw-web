import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
rmSync(contentTarget, { recursive: true, force: true });
rmSync(publicTarget, { recursive: true, force: true });
mkdirSync(contentTarget, { recursive: true });
mkdirSync(publicTarget, { recursive: true });
cpSync(sourcePages, join(contentTarget, "pages"), { recursive: true });
cpSync(sourceSchema, join(contentTarget, "content.schema.json"));
cpSync(sourceNavigation, join(contentTarget, "navigation.yml"));
cpSync(sourcePages, publicTarget, {
  recursive: true,
  filter: (source) => !source.endsWith("index.md"),
});

const schema = JSON.parse(readFileSync(sourceSchema, "utf8"));
console.log(`Synced docs from ${docsRoot} using schema ${schema.title}.`);
