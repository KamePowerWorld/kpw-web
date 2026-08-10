import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("guide and 2026 pages are prerendered", () => {
  const guide = readFileSync("dist/client/index.html", "utf8");
  const lifeServer = readFileSync("dist/client/2026-poikatsu/index.html", "utf8");
  assert.match(guide, /かめぱわぁ〜るど 遊びかたガイド/);
  assert.match(lifeServer, /2026 ポイ活生活鯖/);
  assert.match(lifeServer, /\/content\/pages\/2026-poikatsu\/assets\/image-2\.png/);
  assert.doesNotMatch(lifeServer, /<article[^>]*>[\s\S]*?<script/i);
});

test("editor and Worker entrypoints are built", () => {
  const editor = readFileSync("dist/client/editor/index.html", "utf8");
  assert.match(editor, /ガイドエディター/);
  assert.match(editor, /EditorApp/);
  assert.equal(existsSync("dist/server/entry.mjs"), true);
  assert.equal(existsSync("dist/server/wrangler.json"), true);
});

test("organization spelling and repository split stay canonical", () => {
  const github = readFileSync("src/lib/github.ts", "utf8");
  const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
  assert.match(github, /KamePowerWorld/);
  assert.match(workflow, /KamePowerWorld\/kpw-docs/);
  assert.doesNotMatch(`${github}\n${workflow}`, /KanePowerWorld/);
});
