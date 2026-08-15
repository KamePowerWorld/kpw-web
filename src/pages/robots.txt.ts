import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site, url }) => {
  const origin = site ?? new URL(url.origin);
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /editor",
    "Disallow: /api/",
    `Sitemap: ${new URL("/sitemap.xml", origin).href}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
