import { parse as parseYaml } from "yaml";
import { githubConfig, githubFetch } from "./github-app";
import type { Navigation } from "./navigation";

type ContentItem = { type: "file" | "dir"; name: string; path: string };
type FileResponse = { content: string; sha: string };

export function decodeBase64(value: string) {
  const bytes = Uint8Array.from(atob(value.replaceAll("\n", "")), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function pageIdFromMarkdown(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const data = match ? parseYaml(match[1]) : undefined;
  return typeof data?.id === "string" ? data.id : undefined;
}

export async function loadRepositoryWorkspace(token: string) {
  const { owner, repo, branch } = githubConfig();
  const [entries, navigationFile, ref] = await Promise.all([
    githubFetch<ContentItem[]>(token, `/repos/${owner}/${repo}/contents/pages?ref=${encodeURIComponent(branch)}`),
    githubFetch<FileResponse>(token, `/repos/${owner}/${repo}/contents/navigation.yml?ref=${encodeURIComponent(branch)}`),
    githubFetch<{ object: { sha: string } }>(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`),
  ]);
  const directories = entries.filter((entry) => entry.type === "dir" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name));
  const pages = await Promise.all(directories.map(async (entry) => {
    const file = await githubFetch<FileResponse>(token, `/repos/${owner}/${repo}/contents/${entry.path}/index.md?ref=${encodeURIComponent(branch)}`);
    return { slug: entry.name, filePath: `${entry.path}/index.md`, content: decodeBase64(file.content) };
  }));
  const navigationSource = decodeBase64(navigationFile.content);
  return { pages, navigation: parseYaml(navigationSource) as Navigation, navigationSource, baseCommitSha: ref.object.sha };
}
