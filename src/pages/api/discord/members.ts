import type { APIRoute } from "astro";
import { avatarUrl, getLiveIdentity, searchGuildMembers } from "../../../lib/discord";
import { loadRepositoryWorkspace, pageIdFromMarkdown } from "../../../lib/editor-data";
import { getInstallationToken } from "../../../lib/github-app";
import { evaluateAccess, loadPolicies, parentMap } from "../../../lib/permissions";
import { jsonResponse } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await getLiveIdentity(request); if (!identity) return jsonResponse({ error: "Discord login is required" }, 401);
    const url = new URL(request.url); const pageId = url.searchParams.get("pageId"); const query = url.searchParams.get("query")?.trim() ?? "";
    if (!pageId || query.length < 2 || query.length > 32) return jsonResponse({ error: "2〜32文字で検索してください" }, 400);
    const token = await getInstallationToken(); const workspace = await loadRepositoryWorkspace(token);
    const indexId = pageIdFromMarkdown(workspace.pages.find((page) => page.slug === "index")?.content ?? ""); const policies = await loadPolicies();
    if (!indexId || !evaluateAccess({ pageId, userId: identity.session.user.id, roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, parents: parentMap(workspace.navigation, indexId) }).canManage) return jsonResponse({ error: "Forbidden" }, 403);
    const members = await searchGuildMembers(query);
    return jsonResponse({ members: members.flatMap((member) => member.user ? [{ id: member.user.id, name: member.nick || member.user.global_name || member.user.username, username: member.user.username, avatarUrl: avatarUrl(member.user) }] : []) });
  } catch { return jsonResponse({ error: "メンバーを検索できませんでした" }, 500); }
};
