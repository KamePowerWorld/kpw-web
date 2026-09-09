import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { parse as parseYaml } from "yaml";
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

// Pick fixture pages from the synced kpw-docs checkout so these tests do not depend on
// specific slugs, titles, or images; staging and production docs can differ freely.
function loadSampleContent() {
  const root = "src/generated-content";
  const navigation = parseYaml(readFileSync(`${root}/navigation.yml`, "utf8"));
  const responsiveImages = JSON.parse(readFileSync(`${root}/responsive-images.json`, "utf8"));
  const bySlug = new Map();
  for (const slug of readdirSync(`${root}/pages`)) {
    const source = readFileSync(`${root}/pages/${slug}/index.md`, "utf8");
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const data = parseYaml(match[1]);
    bySlug.set(slug, { slug, data, body: match[2], hasSection: /^## /m.test(match[2]) });
  }
  const byId = new Map([...bySlug.values()].map((page) => [page.data.id, page]));
  const published = [];
  const hidden = [];
  const visit = (nodes, segments, hiddenByDraft) => {
    for (const node of nodes) {
      const page = byId.get(node.id);
      if (!page) continue;
      page.canonicalPath = `/${[...segments, page.slug].join("/")}`;
      page.depth = segments.length;
      (hiddenByDraft || page.data.draft ? hidden : published).push(page);
      visit(node.children ?? [], [...segments, page.slug], hiddenByDraft || page.data.draft);
    }
  };
  visit(navigation.tree, [], false);
  const withHero = published.filter((page) => page.data.heroImage && responsiveImages[`${page.slug}/${page.data.heroImage.slice(2)}`]);
  const hero = withHero.find((page) => page.hasSection) ?? withHero[0];
  const heroAsset = hero ? `/content/${hero.slug}/${hero.data.heroImage.slice(2)}` : undefined;
  const heroSize = hero ? responsiveImages[`${hero.slug}/${hero.data.heroImage.slice(2)}`] : undefined;
  return {
    index: bySlug.get("index"),
    hasTree: navigation.tree.length > 0,
    hero, heroAsset, heroSize,
    regular: published.find((page) => !page.data.heroImage),
    hidden: hidden[0],
  };
}

const sample = loadSampleContent();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("nested routes render and non-canonical paths redirect", async () => {
  const home = await fetch(origin); const homeHtml = await home.text();
  assert.equal(home.status, 200); assert.match(homeHtml, new RegExp(escapeRegExp(sample.index.data.title)));
  if (sample.hasTree) assert.match(homeHtml, /子ページ/);
  assert.ok(sample.hero, "kpw-docs needs at least one published page with a heroImage");
  const page = await fetch(`${origin}${sample.hero.canonicalPath}`); const pageHtml = await page.text();
  assert.equal(page.status, 200); assert.match(pageHtml, new RegExp(escapeRegExp(sample.hero.data.title)));
  assert.match(pageHtml, new RegExp(escapeRegExp(sample.heroAsset)));
  assert.match(pageHtml, /srcset="[^"]+\.webp 320w/); assert.match(pageHtml, /fetchpriority="high"/);
  assert.match(pageHtml, /<link rel="preload" as="image"[^>]+imagesrcset=/);
  assert.match(pageHtml, new RegExp(`width="${sample.heroSize.width}" height="${sample.heroSize.height}"`));
  assert.match(pageHtml, /src="\/generated\/v1\/brand-logo-96\.webp" srcset="\/generated\/v1\/brand-logo-64\.webp 64w/);
  assert.doesNotMatch(pageHtml, /data:image\/png;base64/);
  assert.doesNotMatch(pageHtml, /クレジット|credits|eyebrow/);
  const wrongParent = await fetch(`${origin}/old-parent/${sample.hero.slug}?from=old`, { redirect: "manual" });
  assert.equal(wrongParent.status, 308); assert.equal(wrongParent.headers.get("location"), `${sample.hero.canonicalPath}?from=old`);
  const trailing = await fetch(`${origin}${sample.hero.canonicalPath}/`, { redirect: "manual" });
  assert.equal(trailing.status, 308); assert.equal(trailing.headers.get("location"), sample.hero.canonicalPath);
  if (sample.regular) assert.equal((await fetch(`${origin}${sample.regular.canonicalPath}`)).status, 200);
  if (sample.hidden) assert.equal((await fetch(`${origin}${sample.hidden.canonicalPath}`)).status, 404);
  const image = await fetch(`${origin}${sample.heroAsset}`); assert.equal(image.status, 200); assert.match(image.headers.get("content-type") ?? "", /^image\//);
});

test("site-wide icons and SEO metadata are published", async () => {
  const article = await fetch(`${origin}${sample.hero.canonicalPath}`);
  const articleHtml = await article.text();
  assert.match(articleHtml, new RegExp(`<link rel="canonical" href="${escapeRegExp(`https://docs.kamesuta.com${sample.hero.canonicalPath}`)}"`));
  assert.match(articleHtml, /<meta property="og:type" content="article"/);
  assert.match(articleHtml, new RegExp(`<meta property="og:image" content="${escapeRegExp(`https://docs.kamesuta.com${sample.heroAsset}`)}"`));
  assert.match(articleHtml, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(articleHtml, /<script type="application\/ld\+json">/);
  if (sample.hero.hasSection) assert.match(articleHtml, /class="active" href="#[^"]+" data-heading-id=/);

  const favicon = await fetch(`${origin}/favicon-192.png`);
  assert.equal(favicon.headers.get("cache-control"), "public, max-age=604800");
  const manifest = await fetch(`${origin}/site.webmanifest`);
  assert.equal(manifest.headers.get("cache-control"), "public, max-age=86400");
  const brandLogo = await fetch(`${origin}/generated/v1/brand-logo-96.webp`);
  assert.equal(brandLogo.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(brandLogo.headers.get("content-type"), "image/webp");

  if (sample.regular) {
    const regularHtml = await (await fetch(`${origin}${sample.regular.canonicalPath}`)).text();
    assert.doesNotMatch(regularHtml, /<meta property="og:image"/);
    assert.match(regularHtml, /<meta name="twitter:card" content="summary"/);
  }

  const sitemap = await fetch(`${origin}/sitemap.xml`);
  const sitemapXml = await sitemap.text();
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(sitemapXml, new RegExp(escapeRegExp(`https://docs.kamesuta.com${sample.hero.canonicalPath}`)));
  if (sample.hidden) assert.doesNotMatch(sitemapXml, new RegExp(escapeRegExp(`${sample.hidden.canonicalPath}<`)));
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
  assert.ok(Object.keys(JSON.parse(readFileSync("src/generated-content/responsive-images.json", "utf8"))).length > 0, "responsive image variants were generated");
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
