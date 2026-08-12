import type { APIRoute } from "astro";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GitHubError, assertSameOrigin, getInstallationAccess, getSession, githubConfig, githubFetch, jsonResponse } from "../../../lib/github";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const frontmatterSchema = z.object({
  id: z.uuid(), title: z.string().min(1).max(100), draft: z.boolean(), heroLead: z.string().min(1).max(160),
  heroImage: z.string().regex(/^\.\/assets\/[A-Za-z0-9._-]+$/).optional(), aliases: z.array(slugSchema).default([]),
}).strict();
const assetSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i),
  contentBase64: z.string().max(8_000_000),
});
const pageChangeSchema = z.object({
  id: z.uuid(), originalSlug: slugSchema.optional(), slug: slugSchema,
  content: z.string().min(1).max(1_000_000).optional(), deleted: z.boolean().default(false),
  assets: z.array(assetSchema).max(20).default([]), title: z.string().min(1).max(100),
}).refine((value) => value.deleted || value.content, "content is required for a saved page");
const requestSchema = z.object({
  baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  navigation: z.string().min(1).max(500_000),
  pages: z.array(pageChangeSchema).max(100),
  description: z.string().max(500).default(""),
});

type RefResponse = { object: { sha: string } };
type CommitResponse = { tree: { sha: string } };
type BlobResponse = { sha: string; content?: string; encoding?: string };
type TreeEntry = { path: string; mode: string; type: "blob" | "tree"; sha: string };
type TreeResponse = { sha: string; tree?: TreeEntry[]; truncated?: boolean };
type CreatedCommit = { sha: string; html_url: string };
type ForkRepository = { full_name: string; parent?: { full_name: string }; permissions?: { push?: boolean } };
type CommitTreeEntry = { path: string; mode: "100644"; type: "blob"; sha: string | null };

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pageDataFromMarkdown(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const result = frontmatterSchema.safeParse(parseYaml(match[1]));
  return result.success ? result.data : undefined;
}

async function createBatchCommit(options: {
  token: string; owner: string; repo: string; branch: string; expectedCommitSha?: string;
  message: string; navigation: string; changes: z.infer<typeof pageChangeSchema>[];
}) {
  const { token, owner, repo, branch, expectedCommitSha, message, navigation, changes } = options;
  const ref = await githubFetch<RefResponse>(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (expectedCommitSha && ref.object.sha !== expectedCommitSha) throw new GitHubError(409, "GitHub側に新しい変更があります。編集内容を保持したまま最新版を確認してください。");
  const base = await githubFetch<CommitResponse>(token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
  const currentTree = await githubFetch<TreeResponse>(token, `/repos/${owner}/${repo}/git/trees/${base.tree.sha}?recursive=1`);
  if (currentTree.truncated || !currentTree.tree) throw new GitHubError(409, "Repository tree is too large to update safely.");
  const blobs = currentTree.tree.filter((entry) => entry.type === "blob");

  const existingPages = new Map<string, z.infer<typeof frontmatterSchema>>();
  await Promise.all(blobs.filter((entry) => /^pages\/[^/]+\/index\.md$/.test(entry.path)).map(async (entry) => {
    const blob = await githubFetch<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    const source = blob.encoding === "base64" && blob.content
      ? new TextDecoder().decode(Uint8Array.from(atob(blob.content.replaceAll("\n", "")), (character) => character.charCodeAt(0))) : "";
    const data = pageDataFromMarkdown(source); if (data) existingPages.set(entry.path.split("/")[1], data);
  }));
  for (const change of changes) if (change.originalSlug && existingPages.get(change.originalSlug)?.id !== change.id) {
    throw new GitHubError(409, `${change.originalSlug} のページIDが一致しません。`);
  }

  const finalSlugs = new Set(blobs.filter((entry) => /^pages\/[^/]+\/index\.md$/.test(entry.path)).map((entry) => entry.path.split("/")[1]));
  for (const change of changes) if (change.originalSlug) finalSlugs.delete(change.originalSlug);
  for (const change of changes) {
    if (change.deleted) continue;
    if (finalSlugs.has(change.slug)) throw new GitHubError(409, `slug「${change.slug}」はすでに使われています。`);
    finalSlugs.add(change.slug);
  }
  const finalPages = new Map(existingPages);
  for (const change of changes) if (change.originalSlug) finalPages.delete(change.originalSlug);
  for (const change of changes) if (!change.deleted) {
    const data = pageDataFromMarkdown(change.content!);
    if (!data || data.id !== change.id || data.title !== change.title) throw new GitHubError(400, `${change.slug} のfrontmatterが不正です。`);
    finalPages.set(change.slug, data);
  }
  const finalIds = new Set<string>(); const aliasOwners = new Map<string, string>();
  for (const [slug, data] of finalPages) {
    if (finalIds.has(data.id)) throw new GitHubError(400, `ページID ${data.id} が重複しています。`);
    finalIds.add(data.id);
    for (const alias of data.aliases) {
      if (alias === slug) throw new GitHubError(400, `${slug} のaliasが現在slugと重複しています。`);
      if (aliasOwners.has(alias)) throw new GitHubError(400, `alias「${alias}」が複数ページで重複しています。`);
      aliasOwners.set(alias, slug);
    }
  }
  const navigationData = parseYaml(navigation) as { version?: number; tree?: Array<{ id?: string; children?: unknown[] }> };
  const navigationIds = new Set<string>();
  const visitNavigation = (nodes: Array<{ id?: string; children?: unknown[] }> = []) => {
    for (const node of nodes) {
      if (typeof node.id !== "string" || navigationIds.has(node.id)) throw new GitHubError(400, "ページツリーに重複または不正なページIDがあります。");
      navigationIds.add(node.id); visitNavigation((node.children ?? []) as Array<{ id?: string; children?: unknown[] }>);
    }
  };
  visitNavigation(navigationData.tree);
  const indexId = finalPages.get("index")?.id;
  const expectedIds = new Set([...finalPages.entries()].filter(([slug]) => slug !== "index").map(([, data]) => data.id));
  if (!indexId || finalPages.get("index")?.draft || navigationIds.has(indexId) || navigationIds.size !== expectedIds.size || [...navigationIds].some((id) => !expectedIds.has(id))) {
    throw new GitHubError(400, "ページツリーと保存対象ページが一致しません。");
  }

  const entries: CommitTreeEntry[] = [];
  for (const change of changes) {
    if (change.originalSlug && (change.deleted || change.originalSlug !== change.slug)) {
      for (const entry of blobs.filter((item) => item.path.startsWith(`pages/${change.originalSlug}/`))) {
        entries.push({ path: entry.path, mode: "100644", type: "blob", sha: null });
        if (!change.deleted && entry.path !== `pages/${change.originalSlug}/index.md`) {
          entries.push({ path: entry.path.replace(`pages/${change.originalSlug}/`, `pages/${change.slug}/`), mode: "100644", type: "blob", sha: entry.sha });
        }
      }
    }
    if (change.deleted) continue;
    const pageBlob = await githubFetch<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST", body: JSON.stringify({ content: utf8Base64(change.content!), encoding: "base64" }),
    });
    entries.push({ path: `pages/${change.slug}/index.md`, mode: "100644", type: "blob", sha: pageBlob.sha });
    for (const asset of change.assets) {
      const blob = await githubFetch<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: "POST", body: JSON.stringify({ content: asset.contentBase64, encoding: "base64" }),
      });
      entries.push({ path: `pages/${change.slug}/assets/${asset.name}`, mode: "100644", type: "blob", sha: blob.sha });
    }
  }
  const navigationBlob = await githubFetch<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs`, {
    method: "POST", body: JSON.stringify({ content: utf8Base64(navigation), encoding: "base64" }),
  });
  entries.push({ path: "navigation.yml", mode: "100644", type: "blob", sha: navigationBlob.sha });
  const deduplicatedEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  const tree = await githubFetch<TreeResponse>(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST", body: JSON.stringify({ base_tree: base.tree.sha, tree: deduplicatedEntries }),
  });
  const commit = await githubFetch<CreatedCommit>(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await githubFetch(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit;
}

async function prepareFork(token: string, login: string, owner: string, repo: string, branch: string) {
  let fork: ForkRepository;
  try { fork = await githubFetch<ForkRepository>(token, `/repos/${login}/${repo}`); }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    return { ready: false as const, reason: "fork", actionUrl: `https://github.com/${owner}/${repo}/fork` };
  }
  if (fork.parent?.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new GitHubError(409, `${login}/${repo} exists but is not a fork of ${owner}/${repo}.`);
  const installation = await getInstallationAccess(token, login, repo);
  if (!installation.ready) return { ready: false as const, reason: "installation", actionUrl: installation.actionUrl };
  try { await githubFetch(token, `/repos/${login}/${repo}/merge-upstream`, { method: "POST", body: JSON.stringify({ branch }) }); }
  catch (error) { if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error; }
  return { ready: true as const };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return jsonResponse({ error: "GitHub login is required" }, 401);
    if (request.headers.get("x-csrf-token") !== session.csrfToken) return jsonResponse({ error: "Invalid CSRF token" }, 403);
    const input = requestSchema.parse(await request.json());
    const navigationData = parseYaml(input.navigation);
    if (navigationData?.version !== 1 || !Array.isArray(navigationData.tree)) return jsonResponse({ error: "ページツリーが不正です" }, 400);
    const { owner, repo, branch } = githubConfig();
    const repository = await githubFetch<{ permissions?: { push?: boolean } }>(session.accessToken, `/repos/${owner}/${repo}`);
    const title = input.pages.length === 0 ? "ページツリーを更新" : input.pages.length === 1 ? input.pages[0].title : `${input.pages.length}ページを更新`;
    if (repository.permissions?.push) {
      const installation = await getInstallationAccess(session.accessToken, owner, repo);
      if (!installation.ready) return jsonResponse({ error: "GitHub AppをKamePowerWorldのkpw-docsへインストールしてください。", actionUrl: installation.actionUrl }, 403);
      const commit = await createBatchCommit({ token: session.accessToken, owner, repo, branch, expectedCommitSha: input.baseCommitSha, message: `docs: ${title}`, navigation: input.navigation, changes: input.pages });
      return jsonResponse({ mode: "direct", commitUrl: commit.html_url, commitSha: commit.sha, redirectUrl: "/editor" });
    }
    const fork = await prepareFork(session.accessToken, session.user.login, owner, repo, branch);
    if (!fork.ready) return jsonResponse({ error: fork.reason === "fork" ? "最初にGitHubでkpw-docsをforkしてください。" : "forkへ書き込むため、GitHub Appを個人アカウントへインストールしてください。", actionUrl: fork.actionUrl }, 409);
    const forkRef = await githubFetch<RefResponse>(session.accessToken, `/repos/${session.user.login}/${repo}/git/ref/heads/${branch}`);
    const editBranch = `editor/${session.user.login}/${Date.now()}`;
    await githubFetch(session.accessToken, `/repos/${session.user.login}/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${editBranch}`, sha: forkRef.object.sha }) });
    await createBatchCommit({ token: session.accessToken, owner: session.user.login, repo, branch: editBranch, message: `docs: ${title}`, navigation: input.navigation, changes: input.pages });
    const compare = new URL(`https://github.com/${owner}/${repo}/compare/${branch}...${session.user.login}:${editBranch}`);
    compare.searchParams.set("quick_pull", "1"); compare.searchParams.set("title", title); compare.searchParams.set("body", input.description || "ページエディターからの一括更新提案です。");
    return jsonResponse({ mode: "pull-request", redirectUrl: compare.toString() });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return jsonResponse({ error: "入力内容を確認してください", issues: error.issues }, 400);
    if (error instanceof GitHubError) return jsonResponse({ error: error.message, actionUrl: undefined }, error.status);
    console.error(JSON.stringify({ message: "batch save failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "保存処理に失敗しました" }, 500);
  }
};
