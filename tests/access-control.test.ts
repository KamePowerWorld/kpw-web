import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAccess, parentMap, resolveNewPageModes, type PagePolicy } from "../src/lib/access-control";

const index = "index"; const parent = "parent"; const child = "child"; const grandchild = "grandchild";
const parents = parentMap({ version: 1, tree: [{ id: parent, children: [{ id: child, children: [{ id: grandchild }] }] }] }, index);
const policy = (pageId: string, partial: Partial<PagePolicy> = {}): PagePolicy => ({ pageId, accessMode: "inherit", creatorUserId: null, managerUserId: null, revision: 1, grants: [], ...partial });

test("admin role bypass receives every capability", () => {
  const access = evaluateAccess({ pageId: grandchild, userId: "user", roleIds: [], isAdmin: true, policies: new Map(), parents });
  assert.deepEqual(access, { canEdit: true, canCreateChildren: true, childMode: "custom", canManage: true, canManageStructure: true, inheritedFrom: null });
});

test("role and individual grants are combined with custom child mode winning", () => {
  const policies = new Map([[parent, policy(parent, { accessMode: "custom", grants: [
    { subjectType: "role", subjectId: "role-a", canEdit: true, createChildrenMode: "inherit" },
    { subjectType: "user", subjectId: "user", canEdit: false, createChildrenMode: "custom" },
  ] })]]);
  const access = evaluateAccess({ pageId: child, userId: "user", roleIds: ["role-a"], isAdmin: false, policies, parents });
  assert.equal(access.canEdit, true); assert.equal(access.childMode, "custom"); assert.equal(access.inheritedFrom, parent);
});

test("nearest custom policy replaces an ancestor and is inherited live", () => {
  const policies = new Map([
    [index, policy(index, { accessMode: "custom", grants: [{ subjectType: "role", subjectId: "old", canEdit: true, createChildrenMode: null }] })],
    [child, policy(child, { accessMode: "custom", grants: [{ subjectType: "role", subjectId: "new", canEdit: true, createChildrenMode: "inherit" }] })],
  ]);
  assert.equal(evaluateAccess({ pageId: grandchild, userId: "user", roleIds: ["old"], isAdmin: false, policies, parents }).canEdit, false);
  const current = evaluateAccess({ pageId: grandchild, userId: "user", roleIds: ["new"], isAdmin: false, policies, parents });
  assert.equal(current.canEdit, true); assert.equal(current.inheritedFrom, child);
});

test("inherited-page creator can edit only their page without managing ACL", () => {
  const policies = new Map([[child, policy(child, { creatorUserId: "creator" })]]);
  const own = evaluateAccess({ pageId: child, userId: "creator", roleIds: [], isAdmin: false, policies, parents });
  const below = evaluateAccess({ pageId: grandchild, userId: "creator", roleIds: [], isAdmin: false, policies, parents });
  assert.equal(own.canEdit, true); assert.equal(own.canManage, false); assert.equal(below.canEdit, false);
});

test("custom-page creator manages the complete subtree", () => {
  const policies = new Map([[parent, policy(parent, { managerUserId: "creator" })]]);
  const access = evaluateAccess({ pageId: grandchild, userId: "creator", roleIds: [], isAdmin: false, policies, parents });
  assert.equal(access.canManage, true); assert.equal(access.canManageStructure, true); assert.equal(access.childMode, "custom"); assert.equal(access.inheritedFrom, parent);
});

test("missing policies fail closed", () => {
  const access = evaluateAccess({ pageId: child, userId: "user", roleIds: ["unknown"], isAdmin: false, policies: new Map(), parents });
  assert.deepEqual(access, { canEdit: false, canCreateChildren: false, childMode: null, canManage: false, canManageStructure: false, inheritedFrom: null });
});

test("nested new pages are authorized parent-first regardless of request order", () => {
  const newParent = "new-parent"; const newChild = "new-child";
  const policies = new Map([[index, policy(index, { accessMode: "custom", grants: [
    { subjectType: "role", subjectId: "builders", canEdit: false, createChildrenMode: "custom" },
  ] })]]);
  const modes = resolveNewPageModes({
    newPageIds: new Set([newChild, newParent]), existingPageIds: new Set([index]), userId: "user", roleIds: ["builders"], isAdmin: false,
    policies, oldParents: new Map(), newParents: new Map([[newParent, index], [newChild, newParent]]),
  });
  assert.deepEqual([...modes.entries()].sort(), [[newChild, "custom"], [newParent, "custom"]]);
});

test("nested new pages fail closed when their root parent denies creation", () => {
  const modes = resolveNewPageModes({
    newPageIds: new Set(["new-child", "new-parent"]), existingPageIds: new Set([index]), userId: "user", roleIds: [], isAdmin: false,
    policies: new Map([[index, policy(index, { accessMode: "custom" })]]), oldParents: new Map(),
    newParents: new Map([["new-parent", index], ["new-child", "new-parent"]]),
  });
  assert.equal(modes.size, 0);
});
