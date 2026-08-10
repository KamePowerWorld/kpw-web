import type { APIRoute } from "astro";
import { assertSameOrigin, jsonResponse, parseCookies, runtimeEnv, sessionCookie } from "../../../lib/github";

export const POST: APIRoute = async ({ request }) => {
  assertSameOrigin(request);
  const sessionId = parseCookies(request).kpw_session;
  if (sessionId) await runtimeEnv.SESSIONS.delete(`session:${sessionId}`);
  return jsonResponse({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
};
