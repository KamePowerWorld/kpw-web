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
  const status = page.locator(".editor-actions [role=status]");
  await expect(status).toContainText("GitHub上の最新版");
  const draft = page.getByRole("checkbox", { name: "まだ非公開" });
  await expect(draft).toBeChecked();
  await draft.uncheck();
  await expect(draft).not.toBeChecked();
  await page.getByRole("button", { name: /変更をまとめて保存/ }).click();
  await expect(status).toContainText("GitHubへ保存しました");
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "まだ非公開" })).not.toBeChecked();
  await expect(status).toContainText(/保存したGitHub上の最新版|GitHub上の最新版/);
});
