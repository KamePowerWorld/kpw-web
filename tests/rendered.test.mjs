import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { flattenNavigation, normalizeNavigation, removeNavigationNode } from "../src/lib/navigation.ts";

const port = 43123;
const origin = `http://127.0.0.1:${port}`;
let server;
let serverOutput = "";

before(async () => {
  server = spawn("npx", ["wrangler", "dev", "--config", "dist/server/wrangler.json", "--port", String(port), "--local"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(origin); if (response.status < 500) return; } catch { /* retry while Wrangler starts */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Wrangler did not start:\n${serverOutput}`);
});

after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  }
});

test("nested routes render and non-canonical paths redirect", async () => {
  const home = await fetch(origin); const homeHtml = await home.text();
  assert.equal(home.status, 200); assert.match(homeHtml, /かめぱわぁ〜るど 遊びかたガイド/); assert.match(homeHtml, /子ページ/);
  const page = await fetch(`${origin}/2026-poikatsu`); const pageHtml = await page.text();
  assert.equal(page.status, 200); assert.match(pageHtml, /2026 ポイ活生活鯖/); assert.match(pageHtml, /\/content\/2026-poikatsu\/assets\/image-2\.png/);
  assert.match(pageHtml, /srcset="[^"]+\.webp 320w/); assert.match(pageHtml, /fetchpriority="high"/);
  assert.match(pageHtml, /<link rel="preload" as="image"[^>]+imagesrcset=/);
  assert.match(pageHtml, /width="5334" height="2792"/);
  assert.match(pageHtml, /src="\/generated\/v1\/brand-logo-96\.webp" srcset="\/generated\/v1\/brand-logo-64\.webp 64w/);
  assert.doesNotMatch(pageHtml, /data:image\/png;base64/);
  assert.doesNotMatch(pageHtml, /クレジット|credits|eyebrow/);
  const wrongParent = await fetch(`${origin}/old-parent/2026-poikatsu?from=old`, { redirect: "manual" });
  assert.equal(wrongParent.status, 308); assert.equal(wrongParent.headers.get("location"), "/2026-poikatsu?from=old");
  const trailing = await fetch(`${origin}/2026-poikatsu/`, { redirect: "manual" });
  assert.equal(trailing.status, 308); assert.equal(trailing.headers.get("location"), "/2026-poikatsu");
  const testSource = readFileSync(`${process.env.KPW_DOCS_DIR ?? "../kpw-docs"}/pages/testtest/index.md`, "utf8");
  const expectedTestStatus = /^draft:\s*true\s*$/m.test(testSource) ? 404 : 200;
  assert.equal((await fetch(`${origin}/testtest`)).status, expectedTestStatus);
  const image = await fetch(`${origin}/content/2026-poikatsu/assets/image-2.png`); assert.equal(image.status, 200); assert.match(image.headers.get("content-type") ?? "", /image\/png/);
});

test("site-wide icons and SEO metadata are published", async () => {
  const article = await fetch(`${origin}/2026-poikatsu`);
  const articleHtml = await article.text();
  assert.match(articleHtml, /<link rel="canonical" href="https:\/\/docs\.kamesuta\.com\/2026-poikatsu"/);
  assert.match(articleHtml, /<meta property="og:type" content="article"/);
  assert.match(articleHtml, /<meta property="og:image" content="https:\/\/docs\.kamesuta\.com\/content\/2026-poikatsu\/assets\/image-1\.png"/);
  assert.match(articleHtml, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(articleHtml, /<script type="application\/ld\+json">/);
  assert.match(articleHtml, /class="active" href="#ポイントを集めよう"/);

  const favicon = await fetch(`${origin}/favicon-192.png`);
  assert.equal(favicon.headers.get("cache-control"), "public, max-age=604800");
  const manifest = await fetch(`${origin}/site.webmanifest`);
  assert.equal(manifest.headers.get("cache-control"), "public, max-age=86400");
  const brandLogo = await fetch(`${origin}/generated/v1/brand-logo-96.webp`);
  assert.equal(brandLogo.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(brandLogo.headers.get("content-type"), "image/webp");

  const regular = await fetch(`${origin}/testtest`);
  if (regular.status === 200) {
    const regularHtml = await regular.text();
    assert.doesNotMatch(regularHtml, /<meta property="og:image"/);
    assert.match(regularHtml, /<meta name="twitter:card" content="summary"/);
  }

  const sitemap = await fetch(`${origin}/sitemap.xml`);
  const sitemapXml = await sitemap.text();
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(sitemapXml, /https:\/\/docs\.kamesuta\.com\/2026-poikatsu/);
  assert.doesNotMatch(sitemapXml, /\/editor/);

  const robots = await fetch(`${origin}/robots.txt`);
  const robotsText = await robots.text();
  assert.equal(robots.status, 200);
  assert.match(robotsText, /Disallow: \/editor/);
  assert.match(robotsText, /Sitemap: https:\/\/docs\.kamesuta\.com\/sitemap\.xml/);

  for (const iconPath of ["/favicon.ico", "/favicon-192.png", "/favicon-512.png", "/apple-touch-icon.png", "/site.webmanifest"]) {
    assert.equal((await fetch(`${origin}${iconPath}`)).status, 200, `${iconPath} is published`);
  }
});

test("editor and Worker entrypoints are built", () => {
  const editor = readFileSync("src/pages/editor.astro", "utf8"); const styles = readFileSync("src/styles/editor.css", "utf8");
  assert.match(editor, /ガイドエディター/); assert.match(editor, /EditorApp/); assert.match(styles, /\.page-explorer/);
  assert.match(styles, /height: calc\(100svh - 76px\)/); assert.match(styles, /padding: 18px 16px 94px/); assert.match(styles, /\.editor-app \{ padding-bottom: 0; \}/);
  assert.equal(existsSync("dist/server/entry.mjs"), true); assert.equal(existsSync("dist/server/wrangler.json"), true);
  assert.equal(existsSync("src/generated-content/responsive-images.json"), true);
  assert.match(readFileSync("src/generated-content/responsive-images.json", "utf8"), /image-1\.png/);
});

test("tree, batch save, slug reuse, and deletion policies are present", () => {
  const editor = readFileSync("src/components/EditorApp.tsx", "utf8"); const save = readFileSync("src/pages/api/github/save.ts", "utf8");
  assert.match(editor, /保存＆公開/); assert.match(editor, /子ページがあるため削除できません/); assert.match(editor, /releaseAlias/); assert.match(editor, /indexedDB/);
  assert.match(save, /sha: null/); assert.match(save, /navigation\.yml/); assert.match(save, /expectedCommitSha/); assert.match(save, /getLiveIdentity/); assert.match(save, /canManageStructure/);
  assert.match(save, /author: discordGitAuthor\(identity\.session\.user\)/);
  assert.match(save, /committer/); assert.match(save, /getAppBot/);
});

test("corrupted browser trees are repaired without multiplying pages", () => {
  const corrupted = { version: 1, tree: [
    { id: "a", children: [{ id: "b" }, { id: "b" }, { id: "missing" }] },
    { id: "a" }, { id: "b" },
  ] };
  const repaired = normalizeNavigation(corrupted, ["a", "b", "c"]);
  assert.deepEqual(flattenNavigation(repaired.tree).map((item) => item.id), ["a", "b", "c"]);
  const removed = removeNavigationNode(corrupted.tree, "b");
  assert.equal(removed.node?.id, "b");
  assert.equal(flattenNavigation(removed.tree).filter((item) => item.id === "b").length, 0);
});

test("organization spelling and repository split stay canonical", () => {
  const github = readFileSync("src/lib/github-app.ts", "utf8"); const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
  assert.match(github, /KamePowerWorld/); assert.match(workflow, /KamePowerWorld\/kpw-docs/); assert.doesNotMatch(`${github}\n${workflow}`, /KanePowerWorld/);
});
