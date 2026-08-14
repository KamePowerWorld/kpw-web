import { expect, test } from "@playwright/test";

const pageId = "29b1b24f-7a2a-422e-86c3-38cd942715f1";
const indexPageId = "01dc1c48-1880-42a5-ab8b-1777262840c2";
const csrfToken = "e2e-csrf-token";
const commitBefore = "1".repeat(40);
const commitAfter = "2".repeat(40);
const navigation = `version: 1\ntree:\n  - id: cad50ce0-15f4-4d04-8e5b-74950c59fe47\n    children:\n      - id: ${pageId}\n`;
type TestAccess = { canEdit: boolean; canCreateChildren: boolean; childMode: "inherit" | "custom" | null; canManage: boolean; canManageStructure: boolean; inheritedFrom: string | null };
let remoteContent = `---\nid: ${pageId}\ntitle: テスト\ndraft: true\nheroLead: あああ\n---\n\n# テスト\n`;
let remoteCommit = commitBefore;
const fullAccess: TestAccess = { canEdit: true, canCreateChildren: true, childMode: "custom", canManage: true, canManageStructure: true, inheritedFrom: null };
let testPageAccess: TestAccess = fullAccess;
let savedPermissionBody: unknown;

test.beforeEach(async ({ page }) => {
  remoteContent = remoteContent.replace("draft: false", "draft: true");
  remoteCommit = commitBefore;
  testPageAccess = fullAccess; savedPermissionBody = undefined;
  await page.route("**/api/editor/session", (route) => route.fulfill({ json: {
    authenticated: true, isAdmin: true, csrfToken,
    user: { id: "100000000000000001", username: "e2e-user", displayName: "E2E", avatarUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" },
  } }));
  await page.route("**/api/editor/workspace", (route) => route.fulfill({ json: {
    pages: [
      { slug: "index", filePath: "pages/index/index.md", content: `---\nid: 01dc1c48-1880-42a5-ab8b-1777262840c2\ntitle: トップ\ndraft: false\nheroLead: トップです\n---\n\n# トップ\n` },
      { slug: "2026-poikatsu", filePath: "pages/2026-poikatsu/index.md", content: `---\nid: cad50ce0-15f4-4d04-8e5b-74950c59fe47\ntitle: ポイ活\ndraft: false\nheroLead: ポイ活です\n---\n\n# ポイ活\n` },
      { slug: "testtest", filePath: "pages/testtest/index.md", content: remoteContent },
    ], navigation, baseCommitSha: remoteCommit,
    access: { "01dc1c48-1880-42a5-ab8b-1777262840c2": fullAccess, "cad50ce0-15f4-4d04-8e5b-74950c59fe47": fullAccess, [pageId]: testPageAccess },
  } }));
  await page.route("**/api/editor/save", async (route) => {
    const request = route.request();
    expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
    const body = request.postDataJSON();
    const changed = body.pages.find((item: { id: string }) => item.id === pageId);
    expect(changed.content).toContain("draft: false");
    remoteContent = changed.content; remoteCommit = commitAfter;
    await route.fulfill({ json: { mode: "direct", commitSha: commitAfter, redirectUrl: "/editor" } });
  });
  await page.route(`**/api/editor/pages/${pageId}/permissions`, async (route) => {
    if (route.request().method() === "PUT") { savedPermissionBody = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); return; }
    await route.fulfill({ json: { policy: { pageId, accessMode: "inherit", creatorUserId: null, managerUserId: null, revision: 1, grants: [] } } });
  });
  await page.route(`**/api/editor/pages/${indexPageId}/permissions`, async (route) => {
    if (route.request().method() === "PUT") { savedPermissionBody = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); return; }
    await route.fulfill({ json: { policy: { pageId: indexPageId, accessMode: "inherit", creatorUserId: null, managerUserId: null, revision: 1, grants: [] } } });
  });
  await page.route("**/api/discord/roles?*", (route) => route.fulfill({ json: { roles: [{ id: "200000000000000001", name: "editor", color: 65280 }] } }));
  await page.route("**/api/discord/members?*", (route) => route.fulfill({ json: { members: [{ id: "300000000000000001", name: "かめさん", username: "kame", avatarUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }] } }));
});

test("a Discord member without access sees a read-only page", async ({ page }) => {
  testPageAccess = { canEdit: false, canCreateChildren: false, childMode: null, canManage: false, canManageStructure: false, inheritedFrom: null };
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.getByText("このページは読み取り専用です")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "タイトル" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "まだ非公開" })).toBeDisabled();
});

test("a page manager can assign a Discord role in the permission dialog", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  const row = page.locator(".explorer-row", { hasText: "テスト" }); await row.hover();
  await row.getByRole("button", { name: "権限を設定" }).click();
  const dialog = page.getByRole("dialog", { name: "テスト" }); await expect(dialog).toBeVisible();
  await dialog.getByLabel("権限の基準").selectOption("custom");
  await dialog.locator(".permission-add select").selectOption("200000000000000001");
  await dialog.getByRole("button", { name: "ロールを追加" }).click();
  await dialog.getByRole("button", { name: "権限を保存" }).click();
  await expect.poll(() => savedPermissionBody).not.toBeUndefined();
  expect(savedPermissionBody).toMatchObject({ accessMode: "custom", grants: [{ subjectType: "role", subjectId: "200000000000000001", canEdit: true }] });
});

test("existing individual grants show a Discord avatar and nickname instead of a numeric ID", async ({ page, isMobile }) => {
  const memberId = "300000000000000001";
  await page.route(`**/api/editor/pages/${pageId}/permissions`, (route) => route.fulfill({ json: {
    policy: { pageId, accessMode: "custom", creatorUserId: null, managerUserId: null, revision: 1, grants: [
      { subjectType: "user", subjectId: memberId, canEdit: true, createChildrenMode: null },
    ] },
    users: [{ id: memberId, name: "かめっち", username: "kamesuta", avatarUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }],
  } }));
  await page.goto(`/editor?page=${pageId}`);
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  const row = page.locator(".explorer-row", { hasText: "テスト" }); await row.hover();
  await row.getByRole("button", { name: "権限を設定" }).click();
  const subject = page.locator(".permission-subject", { hasText: "かめっち" });
  await expect(subject).toBeVisible();
  await expect(subject.locator("img")).toBeVisible();
  await expect(subject).toContainText("@kamesuta");
  await expect(page.getByRole("dialog", { name: "テスト" })).not.toContainText(memberId);
});

test("an admin can open permissions for the top page", async ({ page, isMobile }) => {
  await page.goto("/editor");
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.getByRole("button", { name: "トップページの権限を設定" }).click();
  await expect(page.getByRole("dialog", { name: "トップ" })).toBeVisible();
});

test("publishing a private page survives an immediate reload", async ({ page }) => {
  await page.goto(`/editor?page=${pageId}`);
  const status = page.locator(".sr-status");
  await expect(status).toContainText("公開側の最新版");
  const draft = page.getByRole("checkbox", { name: "まだ非公開" });
  await expect(draft).toBeChecked();
  await draft.uncheck();
  await expect(draft).not.toBeChecked();
  await page.getByRole("button", { name: /保存＆公開/ }).click();
  await expect(page.getByRole("dialog", { name: "変更内容を確認" })).toBeVisible();
  await expect(page.locator(".diff-added")).toContainText("draft: false");
  await expect(page.locator(".diff-removed")).toContainText("draft: true");
  await page.getByRole("button", { name: "この内容で保存" }).click();
  await expect(status).toContainText("保存しました");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "まだ非公開" })).not.toBeChecked();
  await expect(status).toContainText(/保存した最新版|公開側の最新版/);
});

test("save review uses folded hunks and one review scrollbar", async ({ page }) => {
  remoteContent = `---\nid: ${pageId}\ntitle: テスト\ndraft: true\nheroLead: あああ\n---\n\n${Array.from({ length: 40 }, (_, index) => `変更前ではない行 ${index + 1}`).join("\n")}\n`;
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.locator(".sr-status")).toContainText("公開側の最新版");
  await page.getByRole("textbox", { name: "タイトル" }).fill("変更したテスト");
  await page.getByRole("button", { name: /保存＆公開/ }).click();
  const review = page.getByRole("dialog", { name: "変更内容を確認" });
  await expect(review).toBeVisible();
  const fold = review.getByRole("button", { name: /未変更の\d+行を表示/ }).first();
  await expect(fold).toBeVisible();
  await expect(review.locator(".diff-lines").first()).toHaveCSS("overflow-y", "visible");
  await fold.click();
  await expect(review.getByText("変更前ではない行 20", { exact: true })).toBeVisible();
  await expect(review.locator(".diff-line-number")).not.toHaveCount(0);
});

test("multiple file hunks keep their full height and share one scrollbar", async ({ page, isMobile }) => {
  remoteContent = `---\nid: ${pageId}\ntitle: テスト\ndraft: true\nheroLead: あああ\n---\n\n# テスト\n`;
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.locator(".sr-status")).toContainText("公開側の最新版");
  await page.getByRole("textbox", { name: "タイトル" }).fill("変更したテスト");

  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.locator(".page-name", { hasText: "ポイ活" }).click();
  await page.getByRole("textbox", { name: "タイトル" }).fill("変更したポイ活");

  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.locator(".index-page").click();
  await page.getByRole("textbox", { name: "タイトル" }).fill("変更したトップ");

  await page.getByRole("button", { name: /保存＆公開/ }).click();
  const review = page.getByRole("dialog", { name: "変更内容を確認" });
  const body = review.locator(".save-review-body");
  const cards = body.locator(".diff-card");
  await expect(cards).toHaveCount(3);
  await expect(body).toHaveCSS("overflow-y", "auto");
  const bodyGeometry = await body.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(bodyGeometry.scrollHeight).toBeGreaterThan(bodyGeometry.clientHeight);
  for (const card of await cards.all()) {
    const geometry = await card.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(geometry.clientHeight).toBeGreaterThanOrEqual(geometry.scrollHeight);
    await expect(card.locator(".diff-lines")).toHaveCSS("overflow-y", "visible");
  }
});

test("reverted edits and a cancelled new page are no longer changes", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  const title = page.getByRole("textbox", { name: "タイトル" });
  await expect(title).toHaveValue("テスト");
  await title.fill("変更したタイトル");
  await expect(page.getByRole("button", { name: /保存＆公開 \(1\)/ })).toBeVisible();
  await title.fill("テスト");
  await expect(page.getByRole("button", { name: "保存＆公開" })).toBeVisible();

  const answers = ["一時ページ", "temporary-page"];
  page.on("dialog", async (dialog) => dialog.accept(answers.shift()));
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  await page.getByRole("button", { name: "＋ ルートに追加" }).click();
  await expect(page.getByRole("button", { name: /保存＆公開/ })).toContainText("(2)");
  if (isMobile) await page.getByRole("button", { name: "☰ ページ" }).click();
  const selectedRow = page.locator(".explorer-row.selected");
  await selectedRow.hover();
  await selectedRow.getByTitle("削除").click();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("button", { name: "保存＆公開" })).toBeVisible();
});

test("page and workspace discard actions require confirmation", async ({ page, isMobile }) => {
  await page.goto(`/editor?page=${pageId}`);
  const metaControls = page.locator(".meta-controls");
  const discardCell = page.locator(".discard-page-cell");
  await expect(discardCell.getByRole("button", { name: "編集を破棄" })).toBeVisible();
  await expect(metaControls.getByRole("button", { name: "編集を破棄" })).toHaveCount(0);
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

test("mobile editor controls form two compact header rows and three metadata rows", async ({ page, isMobile }) => {
  test.skip(!isMobile, "スマホ専用レイアウトの確認");
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.locator(".sr-status")).toContainText("公開側の最新版");

  const box = async (selector: string) => {
    const value = await page.locator(selector).boundingBox();
    expect(value).not.toBeNull();
    return value!;
  };
  const brand = await box(".editor-brand");
  const session = await box(".editor-session");
  const pagesButton = await box(".explorer-toggle");
  const viewButton = await box(".topbar-view-page");
  const saveButton = await box(".publish-button");

  expect(Math.abs(brand.y + brand.height / 2 - (session.y + session.height / 2))).toBeLessThan(6);
  expect(Math.max(pagesButton.y, viewButton.y, saveButton.y) - Math.min(pagesButton.y, viewButton.y, saveButton.y)).toBeLessThan(3);
  expect(Math.max(pagesButton.height, viewButton.height, saveButton.height) - Math.min(pagesButton.height, viewButton.height, saveButton.height)).toBeLessThan(3);
  expect(pagesButton.x + pagesButton.width).toBeLessThanOrEqual(viewButton.x);
  expect(viewButton.x + viewButton.width).toBeLessThanOrEqual(saveButton.x);
  await expect(page.getByRole("button", { name: "保存＆公開" })).toBeVisible();

  const titleInput = await page.getByRole("textbox", { name: "タイトル" }).boundingBox();
  const discardButton = await box(".discard-page-button");
  const leadInput = await page.getByRole("textbox", { name: "リード文" }).boundingBox();
  const meta = await box(".editor-meta");
  expect(titleInput).not.toBeNull();
  expect(leadInput).not.toBeNull();
  expect(Math.abs(titleInput!.y - discardButton.y)).toBeLessThan(6);
  expect(titleInput!.x + titleInput!.width).toBeLessThanOrEqual(discardButton.x);
  expect(leadInput!.width).toBeGreaterThan(meta.width - 30);

  const draft = await page.getByRole("checkbox", { name: "まだ非公開" }).boundingBox();
  const source = await page.getByRole("switch", { name: "Markdownソース" }).boundingBox();
  expect(draft).not.toBeNull();
  expect(source).not.toBeNull();
  expect(Math.abs(draft!.y + draft!.height / 2 - (source!.y + source!.height / 2))).toBeLessThan(6);
});

test("desktop metadata stays horizontal without overflowing at laptop width", async ({ page, isMobile }) => {
  test.skip(isMobile, "PC専用レイアウトの確認");
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto(`/editor?page=${pageId}`);
  await expect(page.locator(".sr-status")).toContainText("公開側の最新版");

  const meta = page.locator(".editor-meta");
  const geometry = await meta.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  const title = await page.getByRole("textbox", { name: "タイトル" }).boundingBox();
  const lead = await page.getByRole("textbox", { name: "リード文" }).boundingBox();
  const discard = await page.getByRole("button", { name: "編集を破棄" }).boundingBox();
  expect(title).not.toBeNull();
  expect(lead).not.toBeNull();
  expect(discard).not.toBeNull();
  expect(Math.abs(title!.y - lead!.y)).toBeLessThan(3);
  expect(discard!.y).toBeGreaterThan(title!.y + title!.height);
  expect(Math.abs(discard!.x + discard!.width - (lead!.x + lead!.width))).toBeLessThan(3);
  expect(discard!.width).toBeGreaterThan(discard!.height * 1.5);

  const draft = await page.getByRole("checkbox", { name: "まだ非公開" }).boundingBox();
  const source = await page.getByRole("switch", { name: "Markdownソース" }).boundingBox();
  expect(draft).not.toBeNull();
  expect(source).not.toBeNull();
  expect(Math.abs(draft!.y + draft!.height / 2 - (source!.y + source!.height / 2))).toBeLessThan(6);
  expect(draft!.y).toBeGreaterThan(title!.y + title!.height);
  expect(discard!.y).toBeLessThanOrEqual(draft!.y + draft!.height);
});

test("mobile workspace fills the viewport without trailing app padding", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile layout only");
  await page.goto(`/editor?page=${pageId}`);
  const app = page.locator(".editor-app");
  const pane = page.locator(".editor-pane");
  await expect(app).toHaveCSS("padding-bottom", "0px");
  const geometry = await pane.evaluate((element) => ({ height: element.clientHeight, viewport: window.visualViewport?.height ?? window.innerHeight }));
  expect(geometry.height).toBeGreaterThan(geometry.viewport * 0.82);
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewport);
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

test("Milkdown serializes bullet lists and horizontal rules with hyphens", async ({ page }) => {
  remoteContent = `---\nid: ${pageId}\ntitle: テスト\ndraft: true\nheroLead: あああ\n---\n\n# テスト\n\n- ひとつ\n- ふたつ\n\n---\n\n本文\n`;
  await page.goto(`/editor?page=${pageId}`);
  const editor = page.locator(".milkdown-host .ProseMirror");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("追記");
  await page.locator(".source-switch").click();
  const source = page.locator(".source-editor");
  await expect(source).toHaveValue(/^- ひとつ$/m);
  await expect(source).toHaveValue(/^- ふたつ$/m);
  await expect(source).toHaveValue(/^---$/m);
  await expect(source).not.toHaveValue(/^\* (?:ひとつ|ふたつ)$/m);
  await expect(source).not.toHaveValue(/^\*{3}$/m);
});
