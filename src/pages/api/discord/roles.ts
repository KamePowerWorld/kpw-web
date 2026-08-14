import type { APIRoute } from "astro";
import { getGuildRoles, getLiveIdentity } from "../../../lib/discord";
import { loadRepositoryWorkspace, pageIdFromMarkdown } from "../../../lib/editor-data";
import { getInstallationToken } from "../../../lib/github-app";
import { evaluateAccess, loadPolicies, parentMap } from "../../../lib/permissions";
import { jsonResponse, runtimeEnv } from "../../../lib/runtime";

export const GET: APIRoute = async ({ request }) => {
  try {
    const identity = await getLiveIdentity(request); if (!identity) return jsonResponse({ error: "Discord login is required" }, 401);
    const pageId = new URL(request.url).searchParams.get("pageId"); if (!pageId) return jsonResponse({ error: "pageId is required" }, 400);
    const token = await getInstallationToken(); const workspace = await loadRepositoryWorkspace(token);
    const indexId = pageIdFromMarkdown(workspace.pages.find((page) => page.slug === "index")?.content ?? "");
    const policies = await loadPolicies();
    if (!indexId || !evaluateAccess({ pageId, userId: identity.session.user.id, roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, parents: parentMap(workspace.navigation, indexId) }).canManage) return jsonResponse({ error: "Forbidden" }, 403);
    const roles = (await getGuildRoles()).filter((role) => !role.managed || role.id === runtimeEnv.DISCORD_GUILD_ID).sort((a, b) => b.position - a.position);
    return jsonResponse({ roles: roles.map(({ id, name, color }) => ({ id, name, color })) });
  } catch { return jsonResponse({ error: "ロールを取得できませんでした" }, 500); }
};
