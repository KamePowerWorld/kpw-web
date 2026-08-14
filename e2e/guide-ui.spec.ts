import { expect, test } from "@playwright/test";

test("page tree exposes the active branch and mobile navigation opens from the header", async ({ page, isMobile }) => {
  await page.goto("/2026-poikatsu/testtest");
  if (isMobile) {
    const navigation = page.locator("#mobile-page-navigation");
    await expect(navigation).not.toHaveAttribute("open", "");
    await page.getByRole("link", { name: "ページ一覧" }).click();
    await expect(navigation).toHaveAttribute("open", "");
    await expect(navigation).toHaveClass(/is-highlighted/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(navigation.getByRole("link", { name: "テスト" })).toBeVisible();
  } else {
    const sidebar = page.locator("#page-navigation");
    const navigation = sidebar.locator(".page-tree");
    await expect(navigation.getByRole("link", { name: "ポイ活" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "テスト" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("EDIT ON GITHUB")).toHaveCount(0);
    await page.getByRole("link", { name: "ページ一覧" }).click();
    await expect(sidebar).toHaveClass(/is-highlighted/);
    await expect(sidebar).toHaveCSS("animation-name", "desktop-pages-highlight");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  }
});

test("mobile navigation and breadcrumbs share the hero background", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile presentation only");
  await page.goto("/");
  const region = page.locator(".hero-region");
  await expect(region.locator("#mobile-page-navigation")).toHaveCount(1);
  await expect(region.getByRole("navigation", { name: "パンくず" })).toHaveCount(1);
  await expect(region).toHaveCSS("background-image", /linear-gradient/);
});

test("contents highlights the heading currently in view", async ({ page, isMobile }) => {
  test.skip(isMobile, "contents sidebar is a desktop feature");
  await page.goto("/2026-poikatsu");
  const links = page.locator(".heading-tree [data-heading-id]");
  test.skip(await links.count() < 2, "the current fixture needs at least two headings");
  const second = links.nth(1);
  await second.click();
  await expect(second).toHaveClass(/active/);
});

test("footer stays at the viewport bottom on short pages", async ({ page }) => {
  await page.goto("/testtest");
  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  const bottomGap = await footer.evaluate((element) => Math.round(window.innerHeight - element.getBoundingClientRect().bottom));
  expect(bottomGap).toBeLessThanOrEqual(1);
});
