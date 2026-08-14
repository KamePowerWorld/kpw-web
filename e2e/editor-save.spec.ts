import { expect, test } from "@playwright/test";

const pageId = "29b1b24f-7a2a-422e-86c3-38cd942715f1";
const csrfToken = "e2e-csrf-token";
const commitBefore = "1".repeat(40);
const commitAfter = "2".repeat(40);
const navigation = `version: 1\ntree:\n  - id: cad50ce0-15f4-4d04-8e5b-74950c59fe47\n    children:\n      - id: ${pageId}\n`;
let remoteContent = `---\nid: ${pageId}\ntitle: テスト\ndraft: true\nheroLead: あああ\n---\n\n# テスト\n`;
let remoteCommit = commitBefore;

test.beforeEach(async ({ page }) => {
  remoteContent = remoteContent.replace("draft: false", "draft: true");
  remoteCommit = commitBefore;
  await page.route("**/api/github/session", (route) => route.fulfill({ json: {
    authenticated: true, canPush: true, installationReady: true, csrfToken,
    user: { login: "e2e-user", name: "E2E", avatarUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" },
  } }));
  await page.route("**/api/github/workspace", (route) => route.fulfill({ json: {
    pages: [
      { slug: "index", filePath: "pages/index/index.md", content: `---\nid: 01dc1c48-1880-42a5-ab8b-1777262840c2\ntitle: トップ\ndraft: false\nheroLead: トップです\n---\n\n# トップ\n` },
      { slug: "2026-poikatsu", filePath: "pages/2026-poikatsu/index.md", content: `---\nid: cad50ce0-15f4-4d04-8e5b-74950c59fe47\ntitle: ポイ活\ndraft: false\nheroLead: ポイ活です\n---\n\n# ポイ活\n` },
      { slug: "testtest", filePath: "pages/testtest/index.md", content: remoteContent },
    ], navigation, baseCommitSha: remoteCommit,
  } }));
  await page.route("**/api/github/save", async (route) => {
    const request = route.request();
    expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
    const body = request.postDataJSON();
    const changed = body.pages.find((item: { id: string }) => item.id === pageId);
    expect(changed.content).toContain("draft: false");
    remoteContent = changed.content; remoteCommit = commitAfter;
    await route.fulfill({ json: { mode: "direct", commitSha: commitAfter, redirectUrl: "/editor" } });
  });
});

test("publishing a private page survives an immediate reload", async ({ page }) => {
  await page.goto(`/editor?page=${pageId}`);
  const status = page.locator(".sr-status");
  await expect(status).toContainText("GitHub上の最新版");
  const draft = page.getByRole("checkbox", { name: "まだ非公開" });
  await expect(draft).toBeChecked();
  await draft.uncheck();
  await expect(draft).not.toBeChecked();
  await page.getByRole("button", { name: /変更をまとめて保存/ }).click();
  await expect(page.getByRole("dialog", { name: "変更内容を確認" })).toBeVisible();
  await expect(page.locator(".diff-added")).toContainText("draft: false");
  await expect(page.locator(".diff-removed")).toContainText("draft: true");
  await page.getByRole("button", { name: "この内容で保存" }).click();
  await expect(status).toContainText("GitHubへ保存しました");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "まだ非公開" })).not.toBeChecked();
  await expect(status).toContainText(/保存したGitHub上の最新版|GitHub上の最新版/);
});

test("reverted edits and a cancelled new page are no longer changes", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  const title = page.getByRole("textbox", { name: "タイトル" });
  await expect(title).toHaveValue("テスト");
  await title.fill("変更したタイトル");
  await expect(page.getByRole("button", { name: /変更をまとめて保存 \(1\)/ })).toBeVisible();
  await title.fill("テスト");
  await expect(page.getByRole("button", { name: "変更をまとめて保存" })).toBeVisible();

  const answers = ["一時ページ", "temporary-page"];
  page.on("dialog", async (dialog) => dialog.accept(answers.shift()));
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.getByRole("button", { name: "＋ ルートに追加" }).click();
  await expect(page.getByRole("button", { name: /変更をまとめて保存/ })).toContainText("(2)");
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  const selectedRow = page.locator(".explorer-row.selected");
  await selectedRow.hover();
  await selectedRow.getByTitle("削除").click();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("button", { name: "変更をまとめて保存" })).toBeVisible();
});

test("page and workspace discard actions require confirmation", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  const title = page.getByRole("textbox", { name: "タイトル" });
  await title.fill("破棄するタイトル");
  await page.getByRole("button", { name: "編集を破棄" }).click();
  await expect(page.getByText("このページの編集を破棄しますか？")).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(title).toHaveValue("破棄するタイトル");
  await page.getByRole("button", { name: "編集を破棄" }).click();
  await page.getByRole("button", { name: "編集を破棄", exact: true }).last().click();
  await expect(title).toHaveValue("テスト");

  await title.fill("全部破棄するタイトル");
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.getByRole("button", { name: "変更をすべて破棄" }).click();
  await expect(page.getByText("すべての変更を破棄しますか？")).toBeVisible();
  await page.getByRole("button", { name: "すべて破棄" }).click();
  await expect(title).toHaveValue("テスト");
  await expect(page.locator(".swal2-toast")).toContainText("すべての変更を破棄しました");
});

test("editor and preview keep proportional scroll position", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  await page.locator(".source-switch").click();
  const source = page.locator(".source-editor");
  const preview = page.locator(".preview-pane");
  await source.fill("## 長い見出し\n\n長い本文です。\n\n".repeat(120));
  await expect(preview.locator("h2")).toHaveCount(120);
  await source.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.55; element.dispatchEvent(new Event("scroll")); });
  if (isMobile) await page.getByRole("button", { name: "プレビュー" }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight))).toBeGreaterThan(0.35);

  if (isMobile) await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.locator(".source-switch").click();
  const visualEditor = page.locator(".editor-pane");
  await expect(visualEditor.locator("h2")).toHaveCount(120);
  await visualEditor.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.4; element.dispatchEvent(new Event("scroll")); });
  if (isMobile) await page.getByRole("button", { name: "プレビュー" }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight))).toBeGreaterThan(0.25);
});

test("top navigation, source switch and Milkdown image upload are integrated", async ({ page }) => {
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.getByRole("link", { name: "編集をやめる" })).toHaveAttribute("href", "/2026-poikatsu/testtest");
  await expect(page.getByRole("link", { name: /ページを見る/ })).toHaveAttribute("href", "/2026-poikatsu/testtest");
  await expect(page.getByRole("switch", { name: "Markdownソース" })).toBeVisible();
  await expect(page.getByText("画像を追加", { exact: true })).toHaveCount(0);

  const editor = page.locator(".milkdown-host .ProseMirror");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await page.getByText("Image", { exact: true }).click();
  await page.locator('.milkdown-host input[type="file"]').last().setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
  await expect(page.locator(".milkdown-host img")).toHaveAttribute("src", /^data:image\/png;base64,/);
});
