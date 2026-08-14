import type { APIRoute } from "astro";
import { getLiveIdentity } from "../../../lib/discord";
import { loadRepositoryWorkspace, pageIdFromMarkdown } from "../../../lib/editor-data";
import { getInstallationToken } from "../../../lib/github-app";
import { ensurePagePolicies, evaluateAccess, loadPolicies, parentMap } from "../../../lib/permissions";
import { jsonResponse } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await getLiveIdentity(request);
    if (!identity) return jsonResponse({ error: "Discord login is required" }, 401);
    const token = await getInstallationToken();
    const workspace = await loadRepositoryWorkspace(token);
    const ids = workspace.pages.map((page) => pageIdFromMarkdown(page.content)).filter((id): id is string => Boolean(id));
    await ensurePagePolicies(ids);
    const policies = await loadPolicies();
    const indexId = workspace.pages.find((page) => page.slug === "index") ? pageIdFromMarkdown(workspace.pages.find((page) => page.slug === "index")!.content) : undefined;
    if (!indexId) return jsonResponse({ error: "トップページが不正です" }, 500);
    const parents = parentMap(workspace.navigation, indexId);
    const access = Object.fromEntries(ids.map((pageId) => [pageId, evaluateAccess({
      pageId, userId: identity.session.user.id, roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, parents,
    })]));
    return jsonResponse({ pages: workspace.pages, navigation: workspace.navigationSource, baseCommitSha: workspace.baseCommitSha, access });
  } catch (error) {
    console.error(JSON.stringify({ message: "workspace load failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "編集データを読み込めませんでした" }, 500);
  }
};
