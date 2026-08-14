import type { APIRoute } from "astro";
import { assertSameOrigin, jsonResponse, parseCookies, runtimeEnv, sessionCookie } from "../../../lib/runtime";

export const POST: APIRoute = async ({ request }) => {
  assertSameOrigin(request);
  const sessionId = parseCookies(request).kpw_discord_session;
  if (sessionId) await runtimeEnv.SESSIONS.delete(`discord-session:${sessionId}`);
  return jsonResponse({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
};
