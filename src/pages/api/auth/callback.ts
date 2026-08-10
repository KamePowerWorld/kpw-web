import type { APIRoute } from "astro";
import { githubFetch, parseCookies, runtimeEnv, secureRandom, sessionCookie, type GitHubSession } from "../../../lib/github";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = parseCookies(request).kpw_oauth_state;
  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("OAuth state verification failed", { status: 400 });
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: runtimeEnv.GITHUB_CLIENT_ID,
      client_secret: runtimeEnv.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/api/auth/callback", request.url).toString(),
    }),
  });
  const token = await tokenResponse.json<TokenResponse>();
  if (!token.access_token) {
    return new Response(token.error_description || token.error || "GitHub authentication failed", { status: 401 });
  }

  const user = await githubFetch<{ login: string; name: string | null; avatar_url: string }>(token.access_token, "/user");
  const sessionId = secureRandom(32);
  const session: GitHubSession = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 8 * 60 * 60) * 1000,
    csrfToken: secureRandom(),
    user: { login: user.login, name: user.name, avatarUrl: user.avatar_url },
  };
  await runtimeEnv.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: token.expires_in ?? 8 * 60 * 60 });

  const response = redirect("/editor");
  response.headers.append("set-cookie", sessionCookie(sessionId));
  response.headers.append("set-cookie", "kpw_oauth_state=; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return response;
};
