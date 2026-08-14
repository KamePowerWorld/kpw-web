import type { APIRoute } from "astro";
import { getLiveIdentity } from "../../../lib/discord";
import { jsonResponse } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await getLiveIdentity(request);
    if (!identity) return jsonResponse({ authenticated: false });
    return jsonResponse({ authenticated: true, user: identity.session.user, isAdmin: identity.isAdmin, csrfToken: identity.session.csrfToken });
  } catch (error) {
    console.error(JSON.stringify({ message: "discord session check failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ authenticated: false, error: "Discordの所属とロールを確認できませんでした" }, 503);
  }
};
