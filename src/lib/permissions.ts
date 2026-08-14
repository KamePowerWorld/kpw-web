import { runtimeEnv } from "./runtime";
import type { AccessMode, ChildMode, PageGrant, PagePolicy, SubjectType } from "./access-control";
export { evaluateAccess, parentMap, resolveNewPageModes } from "./access-control";
export type { AccessMode, ChildMode, PageAccess, PageGrant, PagePolicy, SubjectType } from "./access-control";

type PolicyRow = { page_id: string; access_mode: AccessMode; creator_user_id: string | null; manager_user_id: string | null; revision: number };
type GrantRow = { page_id: string; subject_type: SubjectType; subject_id: string; can_edit: number; create_children_mode: ChildMode | null };

export async function ensurePagePolicies(pageIds: string[]) {
  if (!pageIds.length) return;
  await runtimeEnv.AUTH_DB.batch(pageIds.map((id) => runtimeEnv.AUTH_DB.prepare(
    "INSERT OR IGNORE INTO page_policies (page_id, access_mode) VALUES (?, 'inherit')",
  ).bind(id)));
}

export async function loadPolicies(): Promise<Map<string, PagePolicy>> {
  const [policyResult, grantResult] = await runtimeEnv.AUTH_DB.batch<PolicyRow | GrantRow>([
    runtimeEnv.AUTH_DB.prepare("SELECT page_id, access_mode, creator_user_id, manager_user_id, revision FROM page_policies"),
    runtimeEnv.AUTH_DB.prepare("SELECT page_id, subject_type, subject_id, can_edit, create_children_mode FROM page_grants"),
  ]);
  const policies = new Map<string, PagePolicy>();
  for (const row of policyResult.results as PolicyRow[]) policies.set(row.page_id, {
    pageId: row.page_id, accessMode: row.access_mode, creatorUserId: row.creator_user_id,
    managerUserId: row.manager_user_id, revision: row.revision, grants: [],
  });
  for (const row of grantResult.results as GrantRow[]) policies.get(row.page_id)?.grants.push({
    subjectType: row.subject_type, subjectId: row.subject_id, canEdit: Boolean(row.can_edit), createChildrenMode: row.create_children_mode,
  });
  return policies;
}

export async function savePolicy(options: {
  pageId: string; actorUserId: string; accessMode: AccessMode; expectedRevision: number; grants: PageGrant[];
}) {
  const before = await runtimeEnv.AUTH_DB.prepare("SELECT * FROM page_policies WHERE page_id = ?").bind(options.pageId).first();
  const statements = [runtimeEnv.AUTH_DB.prepare(
    "UPDATE page_policies SET access_mode = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE page_id = ? AND revision = ?",
  ).bind(options.accessMode, options.pageId, options.expectedRevision), runtimeEnv.AUTH_DB.prepare(
    "DELETE FROM page_grants WHERE page_id = ? AND EXISTS (SELECT 1 FROM page_policies WHERE page_id = ? AND revision = ?)",
  ).bind(options.pageId, options.pageId, options.expectedRevision + 1)];
  if (options.accessMode === "custom") for (const grant of options.grants) statements.push(runtimeEnv.AUTH_DB.prepare(
    "INSERT INTO page_grants (page_id, subject_type, subject_id, can_edit, create_children_mode) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM page_policies WHERE page_id = ? AND revision = ?)",
  ).bind(options.pageId, grant.subjectType, grant.subjectId, grant.canEdit ? 1 : 0, grant.createChildrenMode, options.pageId, options.expectedRevision + 1));
  statements.push(runtimeEnv.AUTH_DB.prepare(
    "INSERT INTO audit_events (actor_user_id, action, page_id, before_json, after_json) SELECT ?, 'permissions.update', ?, ?, ? WHERE EXISTS (SELECT 1 FROM page_policies WHERE page_id = ? AND revision = ?)",
  ).bind(options.actorUserId, options.pageId, JSON.stringify(before), JSON.stringify({ accessMode: options.accessMode, grants: options.grants }), options.pageId, options.expectedRevision + 1));
  const [update] = await runtimeEnv.AUTH_DB.batch(statements);
  if (!update.meta.changes) throw new PermissionConflictError();
}

export async function createPolicyForPage(pageId: string, creatorUserId: string, mode: ChildMode) {
  await runtimeEnv.AUTH_DB.prepare(
    "INSERT OR IGNORE INTO page_policies (page_id, access_mode, creator_user_id, manager_user_id) VALUES (?, 'inherit', ?, ?)",
  ).bind(pageId, creatorUserId, mode === "custom" ? creatorUserId : null).run();
}

export async function removePolicies(pageIds: string[], actorUserId: string, gitCommitSha: string) {
  if (!pageIds.length) return;
  const statements = pageIds.flatMap((pageId) => [
    runtimeEnv.AUTH_DB.prepare("INSERT INTO audit_events (actor_user_id, action, page_id, git_commit_sha) VALUES (?, 'page.delete', ?, ?)").bind(actorUserId, pageId, gitCommitSha),
    runtimeEnv.AUTH_DB.prepare("DELETE FROM page_grants WHERE page_id = ?").bind(pageId),
    runtimeEnv.AUTH_DB.prepare("DELETE FROM page_policies WHERE page_id = ?").bind(pageId),
  ]);
  await runtimeEnv.AUTH_DB.batch(statements);
}

export async function recordContentAudit(actorUserId: string, pageIds: string[], gitCommitSha: string) {
  if (!pageIds.length) return;
  await runtimeEnv.AUTH_DB.batch(pageIds.map((pageId) => runtimeEnv.AUTH_DB.prepare(
    "INSERT INTO audit_events (actor_user_id, action, page_id, git_commit_sha) VALUES (?, 'page.save', ?, ?)",
  ).bind(actorUserId, pageId, gitCommitSha)));
}

export class PermissionConflictError extends Error {}
