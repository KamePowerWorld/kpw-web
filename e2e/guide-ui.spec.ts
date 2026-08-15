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
    const currentPage = navigation.getByRole("link", { name: "テスト" });
    await expect(currentPage).toHaveAttribute("aria-current", "page");
    const [sidebarBox, currentPageBox] = await Promise.all([sidebar.boundingBox(), currentPage.boundingBox()]);
    expect(sidebarBox).not.toBeNull();
    expect(currentPageBox).not.toBeNull();
    expect(Math.abs(currentPageBox!.x - sidebarBox!.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(currentPageBox!.x + currentPageBox!.width - sidebarBox!.x - sidebarBox!.width)).toBeLessThanOrEqual(3);
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

test("desktop hero uses the compact presentation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop presentation only");
  await page.goto("/2026-poikatsu");
  const hero = page.locator(".hero");
  await expect(page.locator(".breadcrumbs")).toHaveCSS("margin-bottom", "0px");
  await expect(hero).toHaveCSS("min-height", "350px");
  await expect(hero).toHaveCSS("padding-top", "38px");
  await expect(hero).toHaveCSS("padding-bottom", "38px");
});

test("mobile hero is compact with breathing room below the poster", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile presentation only");
  await page.goto("/2026-poikatsu");
  const hero = page.locator(".hero");
  await expect(hero).toHaveCSS("min-height", "560px");
  await expect(hero).toHaveCSS("padding-top", "12px");
  await expect(hero).toHaveCSS("padding-bottom", "34px");
  await expect(hero.locator(".hero-poster")).toHaveCSS("margin-top", "50px");
});

test("mobile regular pages omit the mascot artwork without leaving an empty hero", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile presentation only");
  await page.goto("/2026-poikatsu/testtest");
  const hero = page.locator(".hero");
  await expect(hero.locator(".hero-art")).toBeHidden();
  await expect(hero).toHaveCSS("min-height", "0px");
  await expect(hero).toHaveCSS("padding-bottom", "34px");
});

test("contents highlights the heading currently in view", async ({ page, isMobile }) => {
  test.skip(isMobile, "contents sidebar is a desktop feature");
  await page.goto("/2026-poikatsu");
  const links = page.locator(".heading-tree [data-heading-id]");
  test.skip(await links.count() < 2, "the current fixture needs at least two headings");
  const second = links.nth(1);
  await second.click();
  await expect(second).toHaveClass(/active/);
  const [sidebarBox, activeHeadingBox] = await Promise.all([
    page.locator("#page-navigation").boundingBox(),
    second.boundingBox(),
  ]);
  expect(sidebarBox).not.toBeNull();
  expect(activeHeadingBox).not.toBeNull();
  expect(Math.abs(activeHeadingBox!.x - sidebarBox!.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(activeHeadingBox!.x + activeHeadingBox!.width - sidebarBox!.x - sidebarBox!.width)).toBeLessThanOrEqual(3);
});

test("footer stays at the viewport bottom on short pages", async ({ page }) => {
  await page.goto("/testtest");
  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  const bottomGap = await footer.evaluate((element) => Math.round(window.innerHeight - element.getBoundingClientRect().bottom));
  expect(bottomGap).toBeLessThanOrEqual(1);
});
