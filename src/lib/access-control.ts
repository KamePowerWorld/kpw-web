import type { Navigation } from "./navigation";

export type SubjectType = "role" | "user";
export type ChildMode = "inherit" | "custom";
export type AccessMode = "inherit" | "custom";
export type PageGrant = { subjectType: SubjectType; subjectId: string; canEdit: boolean; createChildrenMode: ChildMode | null };
export type PagePolicy = { pageId: string; accessMode: AccessMode; creatorUserId: string | null; managerUserId: string | null; revision: number; grants: PageGrant[] };
export type PageAccess = { canEdit: boolean; canCreateChildren: boolean; childMode: ChildMode | null; canManage: boolean; canManageStructure: boolean; inheritedFrom: string | null };

export function parentMap(navigation: Navigation, indexId: string) {
  const result = new Map<string, string>();
  const visit = (nodes: Navigation["tree"], parentId: string) => {
    for (const node of nodes) { result.set(node.id, parentId); visit(node.children ?? [], node.id); }
  };
  visit(navigation.tree, indexId);
  return result;
}

function ancestry(pageId: string, parents: Map<string, string>) {
  const result = [pageId]; const seen = new Set(result); let current = pageId;
  while (parents.has(current)) { current = parents.get(current)!; if (seen.has(current)) break; seen.add(current); result.unshift(current); }
  return result;
}

export function evaluateAccess(options: { pageId: string; userId: string; roleIds: string[]; isAdmin: boolean; policies: Map<string, PagePolicy>; parents: Map<string, string> }): PageAccess {
  const { pageId, userId, roleIds, isAdmin, policies, parents } = options;
  if (isAdmin) return { canEdit: true, canCreateChildren: true, childMode: "custom", canManage: true, canManageStructure: true, inheritedFrom: null };
  const chain = ancestry(pageId, parents);
  const managerRoot = chain.find((id) => policies.get(id)?.managerUserId === userId);
  if (managerRoot) return { canEdit: true, canCreateChildren: true, childMode: "custom", canManage: true, canManageStructure: true, inheritedFrom: managerRoot === pageId ? null : managerRoot };
  let source: PagePolicy | undefined;
  for (const id of [...chain].reverse()) { const candidate = policies.get(id); if (candidate?.accessMode === "custom") { source = candidate; break; } }
  let canEdit = policies.get(pageId)?.creatorUserId === userId; let childMode: ChildMode | null = null;
  for (const grant of source?.grants ?? []) {
    const matches = grant.subjectType === "user" ? grant.subjectId === userId : roleIds.includes(grant.subjectId);
    if (!matches) continue;
    canEdit ||= grant.canEdit;
    if (grant.createChildrenMode === "custom" || (grant.createChildrenMode === "inherit" && !childMode)) childMode = grant.createChildrenMode;
  }
  return { canEdit, canCreateChildren: childMode !== null, childMode, canManage: false, canManageStructure: false, inheritedFrom: source && source.pageId !== pageId ? source.pageId : null };
}

export function resolveNewPageModes(options: {
  newPageIds: Set<string>; existingPageIds: Set<string>; userId: string; roleIds: string[]; isAdmin: boolean;
  policies: Map<string, PagePolicy>; oldParents: Map<string, string>; newParents: Map<string, string>;
}) {
  const { newPageIds, existingPageIds, userId, roleIds, isAdmin, oldParents, newParents } = options;
  const workingPolicies = new Map(options.policies);
  const modes = new Map<string, ChildMode>();
  const resolving = new Set<string>();
  const resolve = (pageId: string): ChildMode | undefined => {
    const resolved = modes.get(pageId);
    if (resolved) return resolved;
    if (resolving.has(pageId)) return undefined;
    resolving.add(pageId);
    const parentId = newParents.get(pageId);
    let parentAccess: PageAccess | undefined;
    if (parentId && newPageIds.has(parentId)) {
      if (resolve(parentId)) parentAccess = evaluateAccess({ pageId: parentId, userId, roleIds, isAdmin, policies: workingPolicies, parents: newParents });
    } else if (parentId && existingPageIds.has(parentId)) {
      parentAccess = evaluateAccess({ pageId: parentId, userId, roleIds, isAdmin, policies: workingPolicies, parents: oldParents });
    }
    resolving.delete(pageId);
    if (!parentAccess?.canCreateChildren || !parentAccess.childMode) return undefined;
    const mode = parentAccess.childMode;
    modes.set(pageId, mode);
    workingPolicies.set(pageId, {
      pageId, accessMode: "inherit", creatorUserId: userId,
      managerUserId: mode === "custom" ? userId : null, revision: 1, grants: [],
    });
    return mode;
  };
  for (const pageId of newPageIds) resolve(pageId);
  return modes;
}
