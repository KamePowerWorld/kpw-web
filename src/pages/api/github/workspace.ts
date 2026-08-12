import type { APIRoute } from "astro";
import { getSession, githubConfig, githubFetch, jsonResponse } from "../../../lib/github";

type ContentItem = { type: "file" | "dir"; name: string; path: string };
type FileResponse = { content: string; sha: string };

function decodeBase64(value: string) {
  const bytes = Uint8Array.from(atob(value.replaceAll("\n", "")), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const GET: APIRoute = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return jsonResponse({ error: "GitHub login is required" }, 401);
  const { owner, repo, branch } = githubConfig();
  const [entries, navigationFile, ref] = await Promise.all([
    githubFetch<ContentItem[]>(session.accessToken, `/repos/${owner}/${repo}/contents/pages?ref=${encodeURIComponent(branch)}`),
    githubFetch<FileResponse>(session.accessToken, `/repos/${owner}/${repo}/contents/navigation.yml?ref=${encodeURIComponent(branch)}`),
    githubFetch<{ object: { sha: string } }>(session.accessToken, `/repos/${owner}/${repo}/git/ref/heads/${branch}`),
  ]);
  const directories = entries.filter((entry) => entry.type === "dir" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name));
  const pages = await Promise.all(directories.map(async (entry) => {
    const file = await githubFetch<FileResponse>(session.accessToken, `/repos/${owner}/${repo}/contents/${entry.path}/index.md?ref=${encodeURIComponent(branch)}`);
    return { slug: entry.name, filePath: `${entry.path}/index.md`, content: decodeBase64(file.content) };
  }));
  return jsonResponse({ pages, navigation: decodeBase64(navigationFile.content), baseCommitSha: ref.object.sha });
};
