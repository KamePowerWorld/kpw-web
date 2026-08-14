import type { APIRoute } from "astro";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getLiveIdentity } from "../../../lib/discord";
import { discordGitAuthor, githubAppCommitter } from "../../../lib/git-author";
import { loadRepositoryWorkspace, pageIdFromMarkdown } from "../../../lib/editor-data";
import { GitHubError, getAppBot, getInstallationToken, githubConfig, githubFetch } from "../../../lib/github-app";
import type { Navigation } from "../../../lib/navigation";
import { createPolicyForPage, ensurePagePolicies, evaluateAccess, loadPolicies, parentMap, recordContentAudit, removePolicies, resolveNewPageModes } from "../../../lib/permissions";
import { assertSameOrigin, jsonResponse } from "../../../lib/runtime";

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
  author: { name: string; email: string };
  committer: { name: string; email: string };
}) {
  const { token, owner, repo, branch, expectedCommitSha, message, navigation, changes, author, committer } = options;
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
    method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha], author, committer }),
  });
  await githubFetch(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit;
}

function siblingPositions(navigation: Navigation) {
  const result = new Map<string, number>();
  const visit = (nodes: Navigation["tree"]) => { nodes.forEach((node, index) => { result.set(node.id, index); visit(node.children ?? []); }); };
  visit(navigation.tree); return result;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    assertSameOrigin(request);
    const identity = await getLiveIdentity(request);
    if (!identity) return jsonResponse({ error: "Discord login is required" }, 401);
    if (request.headers.get("x-csrf-token") !== identity.session.csrfToken) return jsonResponse({ error: "Invalid CSRF token" }, 403);
    const input = requestSchema.parse(await request.json());
    const navigationData = parseYaml(input.navigation) as Navigation;
    if (navigationData?.version !== 1 || !Array.isArray(navigationData.tree)) return jsonResponse({ error: "ページツリーが不正です" }, 400);
    const { owner, repo, branch } = githubConfig();
    const token = await getInstallationToken();
    const committer = githubAppCommitter(await getAppBot(token));
    const workspace = await loadRepositoryWorkspace(token);
    if (workspace.baseCommitSha !== input.baseCommitSha) return jsonResponse({ error: "GitHub側に新しい変更があります。編集内容を保持したまま最新版を確認してください。" }, 409);
    const existingById = new Map(workspace.pages.flatMap((page) => { const id = pageIdFromMarkdown(page.content); return id ? [[id, page] as const] : []; }));
    const indexId = pageIdFromMarkdown(workspace.pages.find((page) => page.slug === "index")?.content ?? "");
    if (!indexId) return jsonResponse({ error: "トップページが不正です" }, 500);
    await ensurePagePolicies([...existingById.keys()]);
    const policies = await loadPolicies();
    const oldParents = parentMap(workspace.navigation, indexId); const newParents = parentMap(navigationData, indexId);
    const oldPositions = siblingPositions(workspace.navigation); const newPositions = siblingPositions(navigationData);
    const accessFor = (pageId: string) => evaluateAccess({ pageId, userId: identity.session.user.id, roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, parents: oldParents });
    const newPageIds = new Set(input.pages.filter((change) => !existingById.has(change.id) && !change.deleted).map((change) => change.id));
    const newPageModes = resolveNewPageModes({
      newPageIds, existingPageIds: new Set(existingById.keys()), userId: identity.session.user.id,
      roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, oldParents, newParents,
    });

    for (const change of input.pages) {
      const existing = existingById.get(change.id);
      if (!existing) {
        if (change.deleted) continue;
        if (!newPageModes.has(change.id)) return jsonResponse({ error: `「${change.title}」をこの場所に作成する権限がありません` }, 403);
        continue;
      }
      const access = accessFor(change.id);
      const structural = change.deleted || change.slug !== existing.slug;
      if (structural ? !access.canManageStructure : !access.canEdit) return jsonResponse({ error: `「${change.title}」を変更する権限がありません` }, 403);
      if (!structural && !access.canManageStructure) {
        const before = pageDataFromMarkdown(existing.content); const after = pageDataFromMarkdown(change.content ?? "");
        if (!before || !after || JSON.stringify(before.aliases) !== JSON.stringify(after.aliases)) return jsonResponse({ error: "リダイレクト設定の変更にはページ管理権限が必要です" }, 403);
      }
      if (change.deleted && [...oldParents.values()].includes(change.id)) return jsonResponse({ error: "子ページがあるページは削除できません" }, 400);
    }
    for (const pageId of existingById.keys()) {
      if (pageId === indexId || input.pages.some((change) => change.id === pageId && change.deleted)) continue;
      const oldParent = oldParents.get(pageId); const newParent = newParents.get(pageId);
      const moved = oldParent !== newParent || oldPositions.get(pageId) !== newPositions.get(pageId);
      if (!moved) continue;
      if (!accessFor(pageId).canManageStructure) return jsonResponse({ error: "ページを並べ替える権限がありません" }, 403);
      if (oldParent !== newParent && (!newParent || !accessFor(newParent).canCreateChildren)) return jsonResponse({ error: "移動先に子ページを作る権限がありません" }, 403);
    }
    const title = input.pages.length === 0 ? "ページツリーを更新" : input.pages.length === 1 ? input.pages[0].title : `${input.pages.length}ページを更新`;
    const commit = await createBatchCommit({
      token, owner, repo, branch, expectedCommitSha: input.baseCommitSha, message: `docs: ${title}`,
      navigation: input.navigation, changes: input.pages, author: discordGitAuthor(identity.session.user), committer,
    });
    try {
      for (const [pageId, mode] of newPageModes) await createPolicyForPage(pageId, identity.session.user.id, mode);
      const deletedIds = input.pages.filter((change) => change.deleted).map((change) => change.id);
      await removePolicies(deletedIds, identity.session.user.id, commit.sha);
      await recordContentAudit(identity.session.user.id, input.pages.filter((change) => !change.deleted).map((change) => change.id), commit.sha);
    } catch (error) {
      console.error(JSON.stringify({ message: "content saved but permission audit failed", commitSha: commit.sha, error: error instanceof Error ? error.message : String(error) }));
      return jsonResponse({ mode: "direct", commitUrl: commit.html_url, commitSha: commit.sha, partial: true, error: "本文は保存されましたが、権限情報の更新に失敗しました。adminへ連絡してください。" }, 500);
    }
    return jsonResponse({ mode: "direct", commitUrl: commit.html_url, commitSha: commit.sha, redirectUrl: "/editor" });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return jsonResponse({ error: "入力内容を確認してください", issues: error.issues }, 400);
    if (error instanceof GitHubError) return jsonResponse({ error: error.message, actionUrl: undefined }, error.status);
    console.error(JSON.stringify({ message: "batch save failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "保存処理に失敗しました" }, 500);
  }
};
