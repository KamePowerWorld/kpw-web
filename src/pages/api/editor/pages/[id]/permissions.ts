import type { APIRoute } from "astro";
import { z } from "zod";
import { avatarUrl, getGuildMember, getLiveIdentity } from "../../../../../lib/discord";
import { loadRepositoryWorkspace, pageIdFromMarkdown } from "../../../../../lib/editor-data";
import { getInstallationToken } from "../../../../../lib/github-app";
import { ensurePagePolicies, evaluateAccess, loadPolicies, parentMap, PermissionConflictError, savePolicy } from "../../../../../lib/permissions";
import { assertSameOrigin, jsonResponse } from "../../../../../lib/runtime";

const inputSchema = z.object({
  accessMode: z.enum(["inherit", "custom"]),
  expectedRevision: z.number().int().positive(),
  grants: z.array(z.object({
    subjectType: z.enum(["role", "user"]), subjectId: z.string().regex(/^\d{16,20}$/),
    canEdit: z.boolean(), createChildrenMode: z.enum(["inherit", "custom"]).nullable(),
  })).max(100),
}).refine((value) => new Set(value.grants.map((grant) => `${grant.subjectType}:${grant.subjectId}`)).size === value.grants.length, "同じ対象を重複して設定できません");

async function context(request: Request, pageId: string) {
  const identity = await getLiveIdentity(request);
  if (!identity) throw new Response("Discord login is required", { status: 401 });
  const token = await getInstallationToken();
  const workspace = await loadRepositoryWorkspace(token);
  const index = workspace.pages.find((page) => page.slug === "index");
  const indexId = index && pageIdFromMarkdown(index.content);
  if (!indexId || !workspace.pages.some((page) => pageIdFromMarkdown(page.content) === pageId)) throw new Response("Page not found", { status: 404 });
  await ensurePagePolicies(workspace.pages.map((page) => pageIdFromMarkdown(page.content)).filter((id): id is string => Boolean(id)));
  const policies = await loadPolicies();
  const access = evaluateAccess({ pageId, userId: identity.session.user.id, roleIds: identity.roleIds, isAdmin: identity.isAdmin, policies, parents: parentMap(workspace.navigation, indexId) });
  if (!access.canManage) throw new Response("Permission management is not allowed", { status: 403 });
  return { identity, policy: policies.get(pageId) };
}

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const pageId = params.id!;
    const { policy } = await context(request, pageId);
    if (!policy) return jsonResponse({ error: "権限設定が見つかりません" }, 404);
    const userIds = new Set([
      ...policy.grants.filter((grant) => grant.subjectType === "user").map((grant) => grant.subjectId),
      ...(policy.creatorUserId ? [policy.creatorUserId] : []),
      ...(policy.managerUserId ? [policy.managerUserId] : []),
    ]);
    const users = (await Promise.all([...userIds].map(async (userId) => {
      try {
        const member = await getGuildMember(userId); const user = member.user;
        return user ? { id: user.id, name: member.nick || user.global_name || user.username, username: user.username, avatarUrl: avatarUrl(user) } : undefined;
      } catch { return undefined; }
    }))).filter((user) => user !== undefined);
    return jsonResponse({ policy, users });
  } catch (error) { return error instanceof Response ? error : jsonResponse({ error: "権限設定を取得できませんでした" }, 500); }
};

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    assertSameOrigin(request);
    const pageId = params.id!;
    const { identity } = await context(request, pageId);
    if (request.headers.get("x-csrf-token") !== identity.session.csrfToken) return jsonResponse({ error: "Invalid CSRF token" }, 403);
    const input = inputSchema.parse(await request.json());
    await savePolicy({ pageId, actorUserId: identity.session.user.id, ...input });
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof PermissionConflictError) return jsonResponse({ error: "別の人が権限を更新しました。読み込み直してください。" }, 409);
    if (error instanceof z.ZodError) return jsonResponse({ error: "権限設定が不正です", issues: error.issues }, 400);
    return jsonResponse({ error: "権限設定を保存できませんでした" }, 500);
  }
};
