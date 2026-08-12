export type NavigationNode = { id: string; children?: NavigationNode[] };
export type Navigation = { version: 1; tree: NavigationNode[] };

export function flattenNavigation(nodes: NavigationNode[], depth = 0, parentId?: string): Array<{ id: string; depth: number; parentId?: string }> {
  return nodes.flatMap((node) => [{ id: node.id, depth, parentId }, ...flattenNavigation(node.children ?? [], depth + 1, node.id)]);
}

export function normalizeNavigation(navigation: Navigation, allowedIds: string[]): Navigation {
  const allowed = new Set(allowedIds);
  const seen = new Set<string>();
  const visit = (nodes: NavigationNode[]): NavigationNode[] => {
    const normalized: NavigationNode[] = [];
    for (const node of nodes) {
      if (!allowed.has(node.id) || seen.has(node.id)) continue;
      seen.add(node.id);
      const children = visit(Array.isArray(node.children) ? node.children : []);
      normalized.push({ id: node.id, ...(children.length ? { children } : {}) });
    }
    return normalized;
  };
  const tree = visit(Array.isArray(navigation?.tree) ? navigation.tree : []);
  for (const id of allowedIds) if (!seen.has(id)) tree.push({ id });
  return { version: 1, tree };
}

export function containsNavigationNode(node: NavigationNode, id: string): boolean {
  return node.id === id || (node.children ?? []).some((child) => containsNavigationNode(child, id));
}

export function findNavigationNode(nodes: NavigationNode[], id: string): NavigationNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNavigationNode(node.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

export function removeNavigationNode(nodes: NavigationNode[], id: string): { tree: NavigationNode[]; node?: NavigationNode } {
  let found: NavigationNode | undefined;
  const tree: NavigationNode[] = [];
  for (const item of nodes) {
    if (item.id === id) { if (!found) found = item; continue; }
    const nested = removeNavigationNode(item.children ?? [], id);
    if (nested.node && !found) found = nested.node;
    tree.push({ id: item.id, ...(nested.tree.length ? { children: nested.tree } : {}) });
  }
  return { tree, node: found };
}

export function insertNavigationRelative(nodes: NavigationNode[], targetId: string, node: NavigationNode, after: boolean): NavigationNode[] {
  const result: NavigationNode[] = [];
  for (const item of nodes) {
    if (item.id === targetId && !after) result.push(node);
    result.push({ id: item.id, ...(item.children?.length ? { children: insertNavigationRelative(item.children, targetId, node, after) } : {}) });
    if (item.id === targetId && after) result.push(node);
  }
  return result;
}

export function appendNavigationChild(nodes: NavigationNode[], parentId: string, node: NavigationNode): NavigationNode[] {
  return nodes.map((item) => item.id === parentId
    ? { id: item.id, children: [...(item.children ?? []), node] }
    : { id: item.id, ...(item.children?.length ? { children: appendNavigationChild(item.children, parentId, node) } : {}) });
}
