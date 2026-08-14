import type { APIRoute } from "astro";
import { runtimeEnv, secureRandom } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request, redirect }) => {
  if (!runtimeEnv.DISCORD_CLIENT_ID || !runtimeEnv.DISCORD_CLIENT_SECRET) return new Response("Discord OAuth is not configured", { status: 503 });
  const state = secureRandom();
  const callback = new URL("/api/auth/callback", request.url).toString();
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", runtimeEnv.DISCORD_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");

  const response = redirect(authorize.toString());
  response.headers.append("set-cookie", `kpw_discord_oauth_state=${state}; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return response;
};
