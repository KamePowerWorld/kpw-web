import type { APIRoute } from "astro";
import { getSession, githubConfig, githubFetch, jsonResponse } from "../../../lib/github";

const contentPath = /^pages\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.md$/;

export const GET: APIRoute = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return jsonResponse({ error: "GitHub login is required" }, 401);
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!contentPath.test(path)) return jsonResponse({ error: "Invalid content path" }, 400);

  const { owner, repo, branch } = githubConfig();
  const [file, ref] = await Promise.all([
    githubFetch<{ content: string; sha: string }>(session.accessToken, `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`),
    githubFetch<{ object: { sha: string } }>(session.accessToken, `/repos/${owner}/${repo}/git/ref/heads/${branch}`),
  ]);
  const bytes = Uint8Array.from(atob(file.content.replaceAll("\n", "")), (character) => character.charCodeAt(0));
  return jsonResponse({
    path,
    content: new TextDecoder().decode(bytes),
    fileSha: file.sha,
    baseCommitSha: ref.object.sha,
  });
};
