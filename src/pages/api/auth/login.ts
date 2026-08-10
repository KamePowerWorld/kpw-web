import type { APIRoute } from "astro";
import { runtimeEnv, secureRandom } from "../../../lib/github";

export const GET: APIRoute = async ({ request, redirect }) => {
  if (!runtimeEnv.GITHUB_CLIENT_ID) return new Response("GitHub App is not configured", { status: 503 });
  const state = secureRandom();
  const callback = new URL("/api/auth/callback", request.url).toString();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", runtimeEnv.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);

  const response = redirect(authorize.toString());
  response.headers.append("set-cookie", `kpw_oauth_state=${state}; Path=/api/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return response;
};
