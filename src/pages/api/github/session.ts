import type { APIRoute } from "astro";
import { getSession, githubConfig, githubFetch, jsonResponse } from "../../../lib/github";

export const GET: APIRoute = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return jsonResponse({ authenticated: false });
  const { owner, repo } = githubConfig();
  const repository = await githubFetch<{ permissions?: { push?: boolean } }>(session.accessToken, `/repos/${owner}/${repo}`);
  return jsonResponse({
    authenticated: true,
    user: session.user,
    canPush: Boolean(repository.permissions?.push),
    csrfToken: session.csrfToken,
  });
};
