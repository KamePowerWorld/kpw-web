import type { APIRoute } from "astro";
import { avatarUrl, DiscordError, getGuildMember, getOAuthUser } from "../../../lib/discord";
import { parseCookies, runtimeEnv, secureRandom, sessionCookie, type DiscordSession } from "../../../lib/runtime";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = parseCookies(request).kpw_discord_oauth_state;
  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("OAuth state verification failed", { status: 400 });
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { Accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: runtimeEnv.DISCORD_CLIENT_ID, client_secret: runtimeEnv.DISCORD_CLIENT_SECRET ?? "", grant_type: "authorization_code", code, redirect_uri: new URL("/api/auth/callback", request.url).toString() }),
  });
  const token = await tokenResponse.json<TokenResponse>();
  if (!token.access_token) {
    return new Response(token.error_description || token.error || "Discord authentication failed", { status: 401 });
  }

  const user = await getOAuthUser(token.access_token);
  let member;
  try { member = await getGuildMember(user.id); }
  catch (error) {
    if (error instanceof DiscordError && error.status === 404) return new Response("このDiscordサーバーのメンバーだけが編集できます", { status: 403 });
    throw error;
  }
  if (member.pending) return new Response("Discord server membership screening is not complete", { status: 403 });
  const sessionId = secureRandom(32);
  const session: DiscordSession = {
    expiresAt: Date.now() + (token.expires_in ?? 8 * 60 * 60) * 1000,
    csrfToken: secureRandom(),
    user: { id: user.id, username: user.username, displayName: member.nick || user.global_name || user.username, avatarUrl: avatarUrl(user) },
  };
  await runtimeEnv.SESSIONS.put(`discord-session:${sessionId}`, JSON.stringify(session), { expirationTtl: token.expires_in ?? 8 * 60 * 60 });

  const response = redirect("/editor");
  response.headers.append("set-cookie", sessionCookie(sessionId));
  response.headers.append("set-cookie", "kpw_discord_oauth_state=; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return response;
};
