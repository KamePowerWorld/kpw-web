import type { APIRoute } from "astro";
import { getInstallationAccess, getSession, githubConfig, githubFetch, jsonResponse } from "../../../lib/github";

export const GET: APIRoute = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return jsonResponse({ authenticated: false });
  const { owner, repo } = githubConfig();
  const repository = await githubFetch<{ permissions?: { push?: boolean } }>(session.accessToken, `/repos/${owner}/${repo}`);
  const installation = repository.permissions?.push
    ? await getInstallationAccess(session.accessToken, owner, repo)
    : { ready: true as const, actionUrl: "" };
  return jsonResponse({
    authenticated: true,
    user: session.user,
    canPush: Boolean(repository.permissions?.push && installation.ready),
    installationReady: installation.ready,
    installationUrl: installation.actionUrl,
    csrfToken: session.csrfToken,
  });
};
