import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Ellipsis, FilePlus2, FileText, GripVertical, Home, Info, LockKeyhole, PencilLine, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewOptionsCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import DOMPurify from "dompurify";
import { diffLines, type Change } from "diff";
import { marked } from "marked";
import Swal from "sweetalert2";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  appendNavigationChild, containsNavigationNode, findNavigationNode,
  insertNavigationRelative, normalizeNavigation, removeNavigationNode,
  type Navigation, type NavigationNode,
} from "../lib/navigation";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "sweetalert2/dist/sweetalert2.min.css";

type DocData = { id: string; title: string; draft: boolean; heroLead: string; heroImage?: string; aliases: string[] };
type DocSummary = {
  id: string; slug: string; filePath: string; body: string; data: DocData;
  canonicalPath: string; parentId?: string; childIds: string[]; depth: number;
};
type PageDraft = DocSummary & { originalSlug?: string; assets: AssetDraft[]; deleted?: boolean; isNew?: boolean };
type AssetDraft = { name: string; contentBase64: string; mime: string };
type Session = {
  authenticated: boolean; isAdmin?: boolean; csrfToken?: string;
  user?: { id: string; username: string; displayName: string; avatarUrl: string };
};
type PageAccess = { canEdit: boolean; canCreateChildren: boolean; childMode: "inherit" | "custom" | null; canManage: boolean; canManageStructure: boolean; inheritedFrom: string | null };
type WorkspaceResponse = { pages: Array<{ slug: string; filePath: string; content: string }>; navigation: string; baseCommitSha: string; access: Record<string, PageAccess>; error?: string };
type SaveResponse = { mode?: "direct"; redirectUrl?: string; commitSha?: string; partial?: boolean; error?: string };
type PageGrant = { subjectType: "role" | "user"; subjectId: string; canEdit: boolean; createChildrenMode: "inherit" | "custom" | null };
type PagePolicy = { pageId: string; accessMode: "inherit" | "custom"; creatorUserId: string | null; managerUserId: string | null; revision: number; grants: PageGrant[] };
type DiscordMemberSummary = { id: string; name: string; username: string; avatarUrl: string };
type PersistedWorkspace = {
  pages: PageDraft[]; navigation: Navigation; dirtyIds: string[]; treeDirty: boolean; baseCommitSha?: string; selectedId: string;
  baselinePages?: PageDraft[]; baselineNavigation?: Navigation;
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspaceStorageKey = (userId: string) => `discord:${userId}`;
const lastSavedCommitKey = (userId: string) => `kpw-editor:last-saved-commit:${userId}`;

function parseDocument(source: string, slug: string): PageDraft {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`${slug}: front matter is missing`);
  const raw = parseYaml(match[1]) as Partial<DocData>;
  if (!raw.id || !raw.title) throw new Error(`${slug}: id or title is missing`);
  const data: DocData = {
    id: raw.id, title: raw.title, draft: Boolean(raw.draft), heroLead: raw.heroLead ?? "",
    heroImage: raw.heroImage, aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
  };
  return {
    id: data.id, slug, originalSlug: slug, filePath: `pages/${slug}/index.md`, data, body: match[2], assets: [],
    canonicalPath: slug === "index" ? "/" : `/${slug}`, childIds: [], depth: 0,
  };
}

function serializeDocument(page: PageDraft) {
  const data: Record<string, unknown> = {
    id: page.id, title: page.data.title, draft: page.data.draft, heroLead: page.data.heroLead,
  };
  if (page.data.heroImage) data.heroImage = page.data.heroImage;
  if (page.data.aliases.length) data.aliases = page.data.aliases;
  return `---\n${stringifyYaml(data).trim()}\n---\n\n${page.body.trim()}\n`;
}

function pageFingerprint(page: PageDraft) {
  return JSON.stringify({ slug: page.slug, deleted: Boolean(page.deleted), content: page.deleted ? "" : serializeDocument(page), assets: page.assets.map(({ name, contentBase64 }) => [name, contentBase64]) });
}

function navigationFingerprint(navigation: Navigation) {
  return stringifyYaml(navigation);
}

function toSlug(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function decoratePages(pages: PageDraft[], navigation: Navigation) {
  const copies = pages.map((page) => ({ ...page, data: { ...page.data }, childIds: [] as string[], depth: 0 }));
  const byId = new Map(copies.map((page) => [page.id, page]));
  const index = copies.find((page) => page.slug === "index");
  if (index) { index.canonicalPath = "/"; index.childIds = navigation.tree.map((node) => node.id); }
  const visit = (nodes: NavigationNode[], parent: PageDraft | undefined, segments: string[]) => {
    for (const node of nodes) {
      const page = byId.get(node.id); if (!page) continue;
      page.parentId = parent?.id; page.depth = segments.length;
      page.canonicalPath = `/${[...segments, page.slug].join("/")}`;
      page.childIds = (node.children ?? []).map((child) => child.id);
      visit(node.children ?? [], page, [...segments, page.slug]);
    }
  };
  visit(navigation.tree, undefined, []);
  return copies;
}

type FlatNavigationEntry = { id: string; depth: number; parentId?: string };
type DropProjection = {
  depth: number;
  parentId?: string;
  beforeId?: string;
  afterId?: string;
  indicatorId: string;
  indicatorEdge: "before" | "after";
};

function flattenVisibleNavigation(nodes: NavigationNode[], collapsedIds: Set<string>, depth = 0, parentId?: string): FlatNavigationEntry[] {
  return nodes.flatMap((node) => [
    { id: node.id, depth, parentId },
    ...(collapsedIds.has(node.id) ? [] : flattenVisibleNavigation(node.children ?? [], collapsedIds, depth + 1, node.id)),
  ]);
}

function projectNavigationDrop(entries: FlatNavigationEntry[], activeId: string, overId: string, offsetX: number, afterOver: boolean): DropProjection | undefined {
  const active = entries.find((entry) => entry.id === activeId);
  const over = entries.find((entry) => entry.id === overId);
  if (!active || !over) return;

  const requestedDepth = Math.max(0, active.depth + Math.round(offsetX / 22));
  if (activeId !== overId && requestedDepth > over.depth) {
    return { depth: over.depth + 1, parentId: over.id, indicatorId: over.id, indicatorEdge: "after" };
  }

  const remaining = entries.filter((entry) => entry.id !== activeId);
  const overIndex = remaining.findIndex((entry) => entry.id === overId);
  const insertionIndex = activeId === overId
    ? Math.min(entries.findIndex((entry) => entry.id === activeId), remaining.length)
    : Math.max(0, overIndex + (afterOver ? 1 : 0));
  const reordered = [...remaining];
  reordered.splice(insertionIndex, 0, active);
  const previous = reordered[insertionIndex - 1];
  const next = reordered[insertionIndex + 1];
  const maximumDepth = previous ? previous.depth + 1 : 0;
  const minimumDepth = next?.depth ?? 0;
  const depth = Math.max(minimumDepth, Math.min(requestedDepth, maximumDepth));

  let parentId: string | undefined;
  if (depth > 0 && previous) {
    if (previous.depth < depth) parentId = previous.id;
    else if (previous.depth === depth) parentId = previous.parentId;
    else parentId = reordered.slice(0, insertionIndex).reverse().find((entry) => entry.depth === depth)?.parentId;
  }

  const nextSibling = reordered.slice(insertionIndex + 1).find((entry) => entry.depth <= depth);
  const previousSibling = reordered.slice(0, insertionIndex).reverse().find((entry) => entry.depth <= depth);
  const beforeId = nextSibling?.depth === depth && nextSibling.parentId === parentId ? nextSibling.id : undefined;
  const afterId = !beforeId && previousSibling?.depth === depth && previousSibling.parentId === parentId ? previousSibling.id : undefined;
  const indicatorId = beforeId ?? afterId ?? parentId ?? over.id;
  return { depth, parentId, beforeId, afterId, indicatorId, indicatorEdge: beforeId ? "before" : "after" };
}

function openWorkspaceDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kpw-editor", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function readPersistedWorkspace(userId: string): Promise<PersistedWorkspace | undefined> {
  const db = await openWorkspaceDb();
  return await new Promise((resolve, reject) => {
    const request = db.transaction("workspace").objectStore("workspace").get(workspaceStorageKey(userId));
    request.onsuccess = () => resolve(request.result as PersistedWorkspace | undefined); request.onerror = () => reject(request.error);
  });
}

async function writePersistedWorkspace(userId: string, value?: PersistedWorkspace) {
  const db = await openWorkspaceDb();
  await new Promise<void>((resolve, reject) => {
    const store = db.transaction("workspace", "readwrite").objectStore("workspace");
    const request = value ? store.put(value, workspaceStorageKey(userId)) : store.delete(workspaceStorageKey(userId));
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

function MilkdownSurface({ value, onChange, onUpload, resolveImage, readOnly }: {
  value: string; onChange: (value: string) => void; onUpload: (file: File) => Promise<string>; resolveImage: (url: string) => string; readOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const uploadRef = useRef(onUpload);
  const resolveRef = useRef(resolveImage);
  uploadRef.current = onUpload;
  resolveRef.current = resolveImage;
  useEffect(() => {
    if (!root.current) return;
    const crepe = new Crepe({ root: root.current, defaultValue: value, features: {
      [CrepeFeature.AI]: false, [CrepeFeature.Latex]: false, [CrepeFeature.CodeMirror]: false,
    }, featureConfigs: { [CrepeFeature.ImageBlock]: {
      onUpload: (file) => uploadRef.current(file),
      proxyDomURL: (url) => resolveRef.current(url),
      inlineUploadButton: "画像を選ぶ", blockUploadButton: "画像を選ぶ",
      inlineUploadPlaceholderText: "画像URL、またはファイルを選択", blockUploadPlaceholderText: "画像URL、またはファイルを選択",
    } } });
    crepe.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (options) => ({
      ...options, bullet: "-" as const, rule: "-" as const, ruleRepetition: 3, ruleSpaces: false,
    })));
    crepe.editor.config((ctx) => ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => !readOnly })));
    crepe.on((listener) => listener.markdownUpdated((_ctx, markdown) => { if (markdown !== value) onChange(markdown); }));
    void crepe.create();
    return () => { void crepe.destroy(); };
  }, [readOnly]);
  return <div className={`milkdown-host ${readOnly ? "read-only" : ""}`} ref={root} />;
}

type DiffRow = {
  kind: "context" | "added" | "removed";
  text: string;
  oldLine?: number;
  newLine?: number;
};
type DiffBlock = { kind: "lines"; rows: DiffRow[] } | { kind: "fold"; rows: DiffRow[]; id: number };

function splitDiffLines(value: string) {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function buildDiffBlocks(changes: Change[], contextSize = 3): DiffBlock[] {
  let oldLine = 1;
  let newLine = 1;
  const rows = changes.flatMap((change): DiffRow[] => splitDiffLines(change.value).map((text) => {
    if (change.added) return { kind: "added", text, newLine: newLine++ };
    if (change.removed) return { kind: "removed", text, oldLine: oldLine++ };
    return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
  }));
  const blocks: DiffBlock[] = [];
  let foldId = 0;
  for (let start = 0; start < rows.length;) {
    if (rows[start].kind !== "context") {
      let end = start + 1;
      while (end < rows.length && rows[end].kind !== "context") end += 1;
      blocks.push({ kind: "lines", rows: rows.slice(start, end) });
      start = end;
      continue;
    }
    let end = start + 1;
    while (end < rows.length && rows[end].kind === "context") end += 1;
    const group = rows.slice(start, end);
    const keepStart = start > 0 ? contextSize : 0;
    const keepEnd = end < rows.length ? contextSize : 0;
    if (group.length <= keepStart + keepEnd) blocks.push({ kind: "lines", rows: group });
    else {
      if (keepStart) blocks.push({ kind: "lines", rows: group.slice(0, keepStart) });
      blocks.push({ kind: "fold", rows: group.slice(keepStart, group.length - keepEnd), id: foldId++ });
      if (keepEnd) blocks.push({ kind: "lines", rows: group.slice(group.length - keepEnd) });
    }
    start = end;
  }
  return blocks;
}

function DiffLines({ changes }: { changes: Change[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const blocks = useMemo(() => buildDiffBlocks(changes), [changes]);
  const renderRows = (rows: DiffRow[], keyPrefix: string) => rows.map((row, index) => <div key={`${keyPrefix}-${index}`} className={`diff-line diff-${row.kind}`}>
    <span className="diff-line-number" aria-hidden="true">{row.oldLine ?? ""}</span>
    <span className="diff-line-number" aria-hidden="true">{row.newLine ?? ""}</span>
    <span className="diff-marker" aria-hidden="true">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
    <code>{row.text || " "}</code>
  </div>);
  return <div className="diff-lines" role="table" aria-label="変更差分">{blocks.map((block, index) => {
    if (block.kind === "lines") return renderRows(block.rows, `lines-${index}`);
    if (expanded.has(block.id)) return <div className="diff-expanded" key={`fold-${block.id}`}>{renderRows(block.rows, `expanded-${block.id}`)}</div>;
    return <button key={`fold-${block.id}`} className="diff-fold" onClick={() => setExpanded((current) => new Set(current).add(block.id))}>⋯ 未変更の{block.rows.length}行を表示</button>;
  })}</div>;
}

async function fileToDraft(file: File): Promise<AssetDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name: file.name.replace(/[^A-Za-z0-9._-]/g, "-"), contentBase64: btoa(binary), mime: file.type };
}

function PageActions({ page, access, onAdd, onRename, onDelete, onPermissions }: {
  page: PageDraft; access: PageAccess; onAdd: () => void; onRename: () => void; onDelete: () => void; onPermissions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canChangePage = page.slug !== "index" && access.canManageStructure;
  const hasMenu = access.canCreateChildren || canChangePage;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeOnResize = () => setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.min(window.innerWidth - menu.width - 10, Math.max(10, button.right - menu.width));
    const below = button.bottom + 6;
    const top = below + menu.height <= window.innerHeight - 10 ? below : Math.max(10, button.top - menu.height - 6);
    setPosition({ top, left });
  }, [open]);

  const run = (action: () => void) => { setOpen(false); action(); };
  return <div className="row-actions">
    {access.canManage && <button className="row-action permission-action" onClick={onPermissions} data-tooltip="権限を設定" aria-label={page.slug === "index" ? "トップページの権限を設定" : `${page.data.title}の権限を設定`}><LockKeyhole aria-hidden="true" /></button>}
    {hasMenu && <button ref={buttonRef} className="row-action more-action" onClick={() => setOpen((value) => !value)} aria-label={`${page.data.title}のその他の操作`} aria-haspopup="menu" aria-expanded={open}><Ellipsis aria-hidden="true" /></button>}
    {open && createPortal(<div ref={menuRef} className="page-action-menu" role="menu" aria-label={`${page.data.title}のページ操作`} style={position}>
      <header><span>ページ操作</span><strong>{page.data.title}</strong></header>
      {access.canCreateChildren && <div className="page-action-menu-group"><button role="menuitem" onClick={() => run(onAdd)}><FilePlus2 aria-hidden="true" />子ページを追加</button></div>}
      {canChangePage && <div className="page-action-menu-group">
        <button role="menuitem" onClick={() => run(onRename)}><PencilLine aria-hidden="true" />タイトル・slugを変更</button>
        <button role="menuitem" className="danger" onClick={() => run(onDelete)}><Trash2 aria-hidden="true" />ページを削除</button>
      </div>}
    </div>, document.body)}
  </div>;
}

function SortablePage({ page, access, selected, dirty, expanded, dropIndicator, onSelect, onToggle, onAdd, onRename, onDelete, onPermissions }: {
  page: PageDraft; access: PageAccess; selected: boolean; dirty: boolean; expanded: boolean; dropIndicator?: Pick<DropProjection, "depth" | "indicatorEdge">;
  onSelect: () => void; onToggle: () => void; onAdd: () => void; onRename: () => void; onDelete: () => void; onPermissions: () => void;
}) {
  const sortable = useSortable({ id: page.id, disabled: !access.canManageStructure });
  return <div ref={sortable.setNodeRef} data-page-id={page.id} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, "--tree-depth": page.depth, "--drop-depth": dropIndicator?.depth ?? page.depth } as React.CSSProperties}
    className={`explorer-row ${selected ? "selected" : ""} ${sortable.isDragging ? "dragging" : ""} ${dropIndicator ? `drop-target drop-${dropIndicator.indicatorEdge}` : ""}`}>
    {page.depth > 0 && <span className="tree-branch" aria-hidden="true" />}
    <button className="drag-handle" disabled={!access.canManageStructure} {...sortable.attributes} {...sortable.listeners} aria-label={`${page.data.title}を移動`}><GripVertical aria-hidden="true" /></button>
    {page.childIds.length
      ? <button className="tree-toggle" onClick={onToggle} aria-label={`${page.data.title}の子ページを${expanded ? "折りたたむ" : "展開する"}`} aria-expanded={expanded}>{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>
      : <span className="tree-page-icon" aria-hidden="true"><FileText /></span>}
    <button className="page-name" onClick={onSelect}><span className="page-title">{page.data.title}</span>{page.data.draft && <span className="draft-mark" aria-label="まだ非公開">◇</span>}{dirty && <span className="dirty-dot" aria-label="未保存の変更" />}</button>
    <PageActions page={page} access={access} onAdd={onAdd} onRename={onRename} onDelete={onDelete} onPermissions={onPermissions} />
  </div>;
}

function roleColor(color?: number) {
  return color ? `#${color.toString(16).padStart(6, "0")}` : "#819184";
}

function MemberIdentity({ member }: { member?: DiscordMemberSummary }) {
  return <strong className="permission-subject">
    {member ? <img src={member.avatarUrl} alt="" /> : <span className="permission-avatar-fallback" aria-hidden="true">?</span>}
    <span>{member?.name ?? "サーバーにいないメンバー"}{member && <small>@{member.username}</small>}</span>
  </strong>;
}

function PermissionsDialog({ page, csrfToken, onClose, onSaved }: { page: PageDraft; csrfToken: string; onClose: () => void; onSaved: () => void }) {
  const [policy, setPolicy] = useState<PagePolicy>();
  const [roles, setRoles] = useState<Array<{ id: string; name: string; color: number }>>([]);
  const [roleId, setRoleId] = useState("");
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<DiscordMemberSummary[]>([]);
  const [knownMembers, setKnownMembers] = useState<Record<string, DiscordMemberSummary>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      fetch(`/api/editor/pages/${page.id}/permissions`).then((response) => response.json() as Promise<{ policy?: PagePolicy; users?: DiscordMemberSummary[] }>),
      fetch(`/api/discord/roles?pageId=${page.id}`).then((response) => response.json() as Promise<{ roles?: Array<{ id: string; name: string; color: number }> }>),
    ]).then(([permissionResult, roleResult]) => {
      setPolicy(permissionResult.policy); setRoles(roleResult.roles ?? []);
      setKnownMembers(Object.fromEntries((permissionResult.users ?? []).map((member) => [member.id, member])));
    });
  }, [page.id]);
  const addGrant = (subjectType: "role" | "user", subjectId: string) => {
    if (!policy || policy.grants.some((grant) => grant.subjectType === subjectType && grant.subjectId === subjectId)) return;
    if (subjectType === "user") {
      const member = members.find((candidate) => candidate.id === subjectId);
      if (member) setKnownMembers((current) => ({ ...current, [member.id]: member }));
    }
    setPolicy({ ...policy, accessMode: "custom", grants: [...policy.grants, { subjectType, subjectId, canEdit: true, createChildrenMode: null }] });
  };
  const updateGrant = (index: number, update: Partial<PageGrant>) => policy && setPolicy({ ...policy, grants: policy.grants.map((grant, position) => position === index ? { ...grant, ...update } : grant) });
  const search = async () => {
    if (query.trim().length < 2) return;
    const result = await fetch(`/api/discord/members?pageId=${page.id}&query=${encodeURIComponent(query.trim())}`).then((response) => response.json() as Promise<{ members?: DiscordMemberSummary[] }>);
    setMembers(result.members ?? []);
  };
  const save = async () => {
    if (!policy) return; setBusy(true);
    const response = await fetch(`/api/editor/pages/${page.id}/permissions`, { method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ accessMode: policy.accessMode, expectedRevision: policy.revision, grants: policy.grants }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) { setBusy(false); await Swal.fire({ icon: "error", title: "保存できませんでした", text: result.error }); return; }
    await Swal.fire({ toast: true, position: "bottom-end", timer: 1800, showConfirmButton: false, icon: "success", title: "ページ権限を保存しました" });
    onSaved();
  };
  return <div className="permission-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title">
      <header><div><span>ページ権限</span><h2 id="permission-title">{page.data.title}</h2></div><button aria-label="閉じる" onClick={onClose}>×</button></header>
      {!policy ? <p className="permission-loading">読み込み中…</p> : <div className="permission-body">
        {policy.managerUserId && <div className="permission-owner"><span>作成者管理</span><MemberIdentity member={knownMembers[policy.managerUserId]} /></div>}
        <label>権限の基準<select value={policy.accessMode} onChange={(event) => setPolicy({ ...policy, accessMode: event.target.value as "inherit" | "custom" })}><option value="inherit">親ページからライブ継承</option><option value="custom">このページで個別設定</option></select></label>
        {policy.accessMode === "custom" && <>
          <div className="permission-add"><select value={roleId} onChange={(event) => setRoleId(event.target.value)}><option value="">ロールを選択</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><button disabled={!roleId} onClick={() => { addGrant("role", roleId); setRoleId(""); }}>ロールを追加</button></div>
          <div className="permission-add"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="メンバー名を2文字以上入力" /><button onClick={() => void search()}>検索</button></div>
          {members.length > 0 && <div className="member-results">{members.map((member) => <button key={member.id} onClick={() => addGrant("user", member.id)}><img src={member.avatarUrl} alt="" />{member.name}<small>@{member.username}</small></button>)}</div>}
          <div className="permission-grants">{policy.grants.map((grant, index) => <div className="permission-grant" key={`${grant.subjectType}:${grant.subjectId}`}>
            {grant.subjectType === "role" ? <strong className="permission-subject"><i className="role-dot" style={{ backgroundColor: roleColor(roles.find((role) => role.id === grant.subjectId)?.color) }} />@{roles.find((role) => role.id === grant.subjectId)?.name ?? "削除されたロール"}</strong> : <MemberIdentity member={knownMembers[grant.subjectId]} />}
            <label><input type="checkbox" checked={grant.canEdit} onChange={(event) => updateGrant(index, { canEdit: event.target.checked })} />このページを編集</label>
            <label>子ページ作成<select value={grant.createChildrenMode ?? "none"} onChange={(event) => updateGrant(index, { createChildrenMode: event.target.value === "none" ? null : event.target.value as "inherit" | "custom" })}><option value="none">許可しない</option><option value="inherit">権限を継承</option><option value="custom">作成者がカスタム可能</option></select></label>
            <button className="remove-grant" onClick={() => setPolicy({ ...policy, grants: policy.grants.filter((_, position) => position !== index) })}>削除</button>
          </div>)}</div>
        </>}
      </div>}
      <footer><button onClick={onClose}>キャンセル</button><button className="save-permissions" disabled={!policy || busy} onClick={() => void save()}>{busy ? "保存中…" : "権限を保存"}</button></footer>
    </section>
  </div>;
}

export default function EditorApp({ initialDocs, initialNavigation }: { initialDocs: DocSummary[]; initialNavigation: Navigation }) {
  const initialPages = initialDocs.map((doc) => ({ ...doc, originalSlug: doc.slug, assets: [], data: { ...doc.data, aliases: doc.data.aliases ?? [] } }));
  const normalizedInitialNavigation = normalizeNavigation(initialNavigation, initialPages.filter((page) => page.slug !== "index").map((page) => page.id));
  const searchParams = new URLSearchParams(location.search);
  const requestedId = searchParams.get("page") ?? initialPages.find((page) => page.filePath === searchParams.get("path"))?.id;
  const [pages, setPages] = useState<PageDraft[]>(initialPages);
  const [navigation, setNavigation] = useState<Navigation>(normalizedInitialNavigation);
  const [baselinePages, setBaselinePages] = useState<PageDraft[]>(initialPages);
  const [baselineNavigation, setBaselineNavigation] = useState<Navigation>(normalizedInitialNavigation);
  const [selectedId, setSelectedId] = useState(requestedId ?? initialPages.find((page) => page.slug === "index")?.id ?? initialPages[0]?.id ?? "");
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [accessByPage, setAccessByPage] = useState<Record<string, PageAccess>>({});
  const [baseCommitSha, setBaseCommitSha] = useState<string>();
  const [status, setStatus] = useState("変更内容はこのブラウザに保存されます");
  const [saving, setSaving] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [activePane, setActivePane] = useState<"edit" | "preview">("edit");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [collapsedPageIds, setCollapsedPageIds] = useState<Set<string>>(() => new Set());
  const [activeDragId, setActiveDragId] = useState<string>();
  const [dropProjection, setDropProjection] = useState<DropProjection>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [permissionPage, setPermissionPage] = useState<PageDraft>();
  const persistenceEpoch = useRef(0);
  const editorPaneRef = useRef<HTMLElement>(null);
  const previewPaneRef = useRef<HTMLElement>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const uploadedImagePreviews = useRef(new Map<string, string>());
  const syncingScroll = useRef(false);
  const scrollRatio = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const allowedNavigationIds = pages.filter((page) => page.slug !== "index" && !page.deleted).map((page) => page.id);
  const safeNavigation = useMemo(() => normalizeNavigation(navigation, allowedNavigationIds), [navigation, pages]);
  const baselineById = useMemo(() => new Map(baselinePages.map((page) => [page.id, page])), [baselinePages]);
  const baselineDecorated = useMemo(() => decoratePages(baselinePages, baselineNavigation), [baselinePages, baselineNavigation]);
  const dirtyIds = useMemo(() => new Set(pages.filter((page) => {
    const baseline = baselineById.get(page.id);
    if (page.isNew && page.deleted) return false;
    return !baseline || pageFingerprint(page) !== pageFingerprint(baseline);
  }).map((page) => page.id)), [pages, baselineById]);
  const baselineAllowedIds = baselinePages.filter((page) => page.slug !== "index" && !page.deleted).map((page) => page.id);
  const treeDirty = navigationFingerprint(safeNavigation) !== navigationFingerprint(normalizeNavigation(baselineNavigation, baselineAllowedIds));
  const decorated = useMemo(() => decoratePages(pages, safeNavigation), [pages, safeNavigation]);
  const current = decorated.find((page) => page.id === selectedId && !page.deleted) ?? decorated.find((page) => page.slug === "index" && !page.deleted) ?? decorated.find((page) => !page.deleted);
  const deniedAccess: PageAccess = { canEdit: false, canCreateChildren: false, childMode: null, canManage: false, canManageStructure: false, inheritedFrom: null };
  const currentAccess = current ? accessByPage[current.id] ?? deniedAccess : deniedAccess;
  const visibleFlatTree = useMemo(() => flattenVisibleNavigation(safeNavigation.tree, collapsedPageIds), [safeNavigation, collapsedPageIds]);
  const dragTreeEntries = useMemo(() => {
    if (!activeDragId) return visibleFlatTree;
    const activeNode = findNavigationNode(safeNavigation.tree, activeDragId);
    return activeNode ? visibleFlatTree.filter((entry) => entry.id === activeDragId || !containsNavigationNode(activeNode, entry.id)) : visibleFlatTree;
  }, [visibleFlatTree, safeNavigation, activeDragId]);
  const treePages = dragTreeEntries.map((entry) => decorated.find((page) => page.id === entry.id)).filter((page): page is PageDraft => Boolean(page && !page.deleted));
  const deletedPages = pages.filter((page) => page.deleted);

  useEffect(() => {
    if (!hydrated || status === "変更内容はこのブラウザに保存されます") return;
    const icon = /失敗|不正|できません|ありません|競合/.test(status) ? "error" : /保存しました/.test(status) ? "success" : "info";
    void Swal.fire({ toast: true, position: "bottom-end", timer: 3200, timerProgressBar: true, showConfirmButton: false, icon, title: status });
  }, [status, hydrated]);

  useEffect(() => {
    void fetch("/api/editor/session").then((response) => response.json() as Promise<Session>).then(async (nextSession) => [nextSession, nextSession.user ? await readPersistedWorkspace(nextSession.user.id).catch(() => undefined) : undefined] as const)
      .then(([nextSession, stored]) => {
        setSession(nextSession);
        if (stored) {
          const storedPages = [...new Map(stored.pages.map((page) => [page.id, page])).values()];
          const repairedNavigation = normalizeNavigation(stored.navigation, storedPages.filter((page) => page.slug !== "index" && !page.deleted).map((page) => page.id));
          setPages(storedPages); setNavigation(repairedNavigation);
          if (stored.baselinePages && stored.baselineNavigation) { setBaselinePages(stored.baselinePages); setBaselineNavigation(stored.baselineNavigation); }
          setBaseCommitSha(stored.baseCommitSha); setSelectedId(stored.selectedId); setStatus("ブラウザに保存された変更内容を復元しました");
        }
        setHydrated(true);
      });
  }, []);

  useEffect(() => {
    if (!hydrated || !session.authenticated) return;
    void fetch("/api/editor/workspace").then(async (response) => {
      const result = await response.json() as WorkspaceResponse; if (!response.ok) throw new Error(result.error); return result;
    }).then((result) => {
      setAccessByPage(result.access);
      const userId = session.user!.id;
      const lastSavedCommit = localStorage.getItem(lastSavedCommitKey(userId));
      if (lastSavedCommit === result.baseCommitSha) {
        persistenceEpoch.current += 1;
        const remotePages = result.pages.map((item) => parseDocument(item.content, item.slug));
        const remoteNavigation = parseYaml(result.navigation) as Navigation;
        const normalizedRemoteNavigation = normalizeNavigation(remoteNavigation, remotePages.filter((page) => page.slug !== "index").map((page) => page.id));
        setPages(remotePages); setNavigation(normalizedRemoteNavigation); setBaselinePages(remotePages); setBaselineNavigation(normalizedRemoteNavigation); setBaseCommitSha(result.baseCommitSha);
        localStorage.removeItem(lastSavedCommitKey(userId)); void writePersistedWorkspace(userId);
        setStatus("保存した最新版を読み込みました"); return;
      }
      if (dirtyIds.size || treeDirty) {
        if (!baseCommitSha) setBaseCommitSha(result.baseCommitSha);
        setStatus("保存済みの編集内容を表示中です。公開側の最新版は一括保存時に競合確認されます。"); return;
      }
      const remotePages = result.pages.map((item) => parseDocument(item.content, item.slug));
      const remoteNavigation = parseYaml(result.navigation) as Navigation;
      const normalizedRemoteNavigation = normalizeNavigation(remoteNavigation, remotePages.filter((page) => page.slug !== "index").map((page) => page.id));
      setPages(remotePages); setNavigation(normalizedRemoteNavigation); setBaselinePages(remotePages); setBaselineNavigation(normalizedRemoteNavigation); setBaseCommitSha(result.baseCommitSha); setStatus("公開側の最新版を読み込みました");
    }).catch((error) => setStatus(`ローカル内容を表示中：${error instanceof Error ? error.message : "取得に失敗しました"}`));
  }, [hydrated, session.authenticated]);

  useEffect(() => {
    if (!hydrated || !session.user) return;
    const epoch = persistenceEpoch.current;
    const timer = window.setTimeout(() => {
      if (epoch !== persistenceEpoch.current) return;
      const hasChanges = dirtyIds.size > 0 || treeDirty;
      void writePersistedWorkspace(session.user!.id, hasChanges ? { pages, navigation: safeNavigation, dirtyIds: [...dirtyIds], treeDirty, baseCommitSha, selectedId, baselinePages, baselineNavigation } : undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pages, safeNavigation, dirtyIds, treeDirty, baseCommitSha, selectedId, hydrated, baselinePages, baselineNavigation, session.user?.id]);

  const updatePage = (id: string, updater: (page: PageDraft) => PageDraft) => {
    setPages((currentPages) => currentPages.map((page) => page.id === id ? updater(page) : page));
  };
  const selectPage = (id: string) => {
    setSelectedId(id); setEditorRevision((value) => value + 1); setExplorerOpen(false);
    history.replaceState(null, "", `/editor?page=${encodeURIComponent(id)}`);
  };

  const releaseAlias = (slug: string, exceptId: string) => {
    setPages((currentPages) => currentPages.map((page) => {
      if (page.id === exceptId || !page.data.aliases.includes(slug)) return page;
      return { ...page, data: { ...page.data, aliases: page.data.aliases.filter((alias) => alias !== slug) } };
    }));
  };

  const createPage = (parentId?: string) => {
    const index = pages.find((page) => page.slug === "index");
    const effectiveParentId = parentId ?? index?.id;
    const parentAccess = effectiveParentId ? accessByPage[effectiveParentId] : undefined;
    if (!effectiveParentId || !parentAccess?.canCreateChildren || !parentAccess.childMode) { setStatus("この場所に子ページを作る権限がありません"); return; }
    const title = window.prompt("新しいページのタイトル"); if (!title?.trim()) return;
    const proposed = window.prompt("slug（英小文字・数字・ハイフン）", toSlug(title)); if (!proposed) return;
    const slug = toSlug(proposed);
    if (!slugPattern.test(slug) || slug === "index") { setStatus("使用できないslugです"); return; }
    if (pages.some((page) => !page.deleted && page.slug === slug)) { setStatus(`slug「${slug}」はすでに使われています`); return; }
    const id = crypto.randomUUID(); releaseAlias(slug, id);
    const page: PageDraft = {
      id, slug, filePath: `pages/${slug}/index.md`, data: { id, title: title.trim(), draft: true, heroLead: "ここにページの説明を書きます。", aliases: [] },
      body: `# ${title.trim()}\n\nここから書き始めよう。\n`, assets: [], canonicalPath: `/${slug}`, childIds: [], depth: 0, isNew: true,
    };
    setPages((value) => [...value, page]);
    setAccessByPage((value) => ({ ...value, [id]: parentAccess.childMode === "custom"
      ? { canEdit: true, canCreateChildren: true, childMode: "custom", canManage: true, canManageStructure: true, inheritedFrom: null }
      : { ...parentAccess, canEdit: true, canManage: false, canManageStructure: false } }));
    setNavigation((value) => normalizeNavigation({ ...value, tree: parentId ? appendNavigationChild(value.tree, parentId, { id }) : [...value.tree, { id }] }, [...allowedNavigationIds, id]));
    if (effectiveParentId) setCollapsedPageIds((currentIds) => { const nextIds = new Set(currentIds); nextIds.delete(effectiveParentId); return nextIds; });
    selectPage(id); setStatus("新しいページを追加しました。まだ公開側には保存されていません。");
  };

  const renameSlug = (page: PageDraft) => {
    if (page.slug === "index") return;
    const title = window.prompt("新しいタイトル", page.data.title); if (!title?.trim()) return;
    const input = window.prompt("新しいslug", page.slug); if (!input) return;
    const slug = toSlug(input); if (!slugPattern.test(slug) || slug === "index") { setStatus("使用できないslugです"); return; }
    if (pages.some((item) => item.id !== page.id && !item.deleted && item.slug === slug)) { setStatus(`slug「${slug}」はすでに使われています`); return; }
    releaseAlias(slug, page.id);
    updatePage(page.id, (item) => ({ ...item, slug, filePath: `pages/${slug}/index.md`, data: { ...item.data, title: title.trim(), aliases: [...new Set([...item.data.aliases.filter((alias) => alias !== slug), item.slug])] } }));
    setStatus(`タイトルとslugを変更しました。slugは「${slug}」です。`);
  };

  const deletePage = async (page: PageDraft) => {
    if (page.slug === "index") { setStatus("トップページは削除できません"); return; }
    if (page.childIds.length) { setStatus("子ページがあるため削除できません。先に子ページを移動してください。"); return; }
    const confirmation = await Swal.fire({ icon: "warning", title: `「${page.data.title}」を削除しますか？`, text: page.isNew ? "まだ保存されていないページを破棄します。" : "一括保存前なら取り消せます。", showCancelButton: true, confirmButtonText: "削除する", cancelButtonText: "やめる", confirmButtonColor: "#b42318" });
    if (!confirmation.isConfirmed) return;
    setPages((value) => page.isNew ? value.filter((item) => item.id !== page.id) : value.map((item) => item.id === page.id ? { ...item, deleted: true } : item));
    setNavigation((value) => ({ ...value, tree: removeNavigationNode(value.tree, page.id).tree }));
    const index = pages.find((item) => item.slug === "index"); if (index) selectPage(index.id);
  };

  const undoDelete = (page: PageDraft) => {
    setPages((value) => value.map((item) => item.id === page.id ? { ...item, deleted: false } : item));
    setNavigation((value) => normalizeNavigation({ ...value, tree: [...value.tree, { id: page.id }] }, [...allowedNavigationIds, page.id]));
  };

  const droppedAfterTarget = (active: DragMoveEvent["active"], over: NonNullable<DragMoveEvent["over"]>) => {
    const translated = active.rect.current.translated;
    const activeCenter = translated ? translated.top + translated.height / 2 : (active.rect.current.initial?.top ?? 0);
    return activeCenter >= over.rect.top + over.rect.height / 2;
  };

  const handleDragStart = ({ active }: DragStartEvent) => { setActiveDragId(String(active.id)); setDropProjection(undefined); };
  const handleDragMove = ({ active, over, delta }: DragMoveEvent) => {
    if (!over) { setDropProjection(undefined); return; }
    setDropProjection(projectNavigationDrop(dragTreeEntries, String(active.id), String(over.id), delta.x, droppedAfterTarget(active, over)));
  };

  const handleDragEnd = ({ active, over, delta }: DragEndEvent) => {
    setActiveDragId(undefined);
    setDropProjection(undefined);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeNode = findNavigationNode(safeNavigation.tree, activeId);
    if (activeId !== overId && activeNode && containsNavigationNode(activeNode, overId)) { setStatus("子孫ページの中へは移動できません"); return; }
    const projection = projectNavigationDrop(dragTreeEntries, activeId, overId, delta.x, droppedAfterTarget(active, over));
    if (!projection) return;
    const removed = removeNavigationNode(safeNavigation.tree, activeId); if (!removed.node) return;
    let tree: NavigationNode[];
    if (projection.beforeId) tree = insertNavigationRelative(removed.tree, projection.beforeId, removed.node, false);
    else if (projection.afterId) tree = insertNavigationRelative(removed.tree, projection.afterId, removed.node, true);
    else if (projection.parentId) tree = appendNavigationChild(removed.tree, projection.parentId, removed.node);
    else tree = [...removed.tree, removed.node];
    setNavigation(normalizeNavigation({ version: 1, tree }, allowedNavigationIds)); setStatus("ページツリーを変更しました。まとめて保存できます。");
    if (projection.parentId) setCollapsedPageIds((currentIds) => { const nextIds = new Set(currentIds); nextIds.delete(projection.parentId!); return nextIds; });
  };

  const uploadImage = async (file: File) => {
    if (!current) throw new Error("ページが選択されていません");
    const draft = await fileToDraft(file);
    const extensionAt = draft.name.lastIndexOf(".");
    const stem = extensionAt > 0 ? draft.name.slice(0, extensionAt) : draft.name;
    const extension = extensionAt > 0 ? draft.name.slice(extensionAt) : "";
    const usedNames = new Set(current.assets.map((asset) => asset.name));
    let name = draft.name;
    for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${stem}-${suffix}${extension}`;
    updatePage(current.id, (page) => ({ ...page, assets: [...page.assets, { ...draft, name }] }));
    uploadedImagePreviews.current.set(`${current.id}/${name}`, `data:${draft.mime};base64,${draft.contentBase64}`);
    setStatus(`画像「${name}」を追加しました`);
    return `./assets/${name}`;
  };

  const resolveEditorImage = (url: string) => {
    if (!current || !url.startsWith("./assets/")) return url;
    const name = decodeURIComponent(url.slice("./assets/".length));
    const asset = current.assets.find((item) => item.name === name);
    return uploadedImagePreviews.current.get(`${current.id}/${name}`) ?? (asset ? `data:${asset.mime};base64,${asset.contentBase64}` : `/content/${encodeURIComponent(current.slug)}/assets/${encodeURIComponent(name)}`);
  };

  const discardCurrent = async () => {
    if (!current) return;
    if (!dirtyIds.has(current.id)) return;
    const confirmation = await Swal.fire({ icon: "warning", title: "このページの編集を破棄しますか？", text: "保存していない本文・設定・画像の変更を元に戻します。", showCancelButton: true, confirmButtonText: "編集を破棄", cancelButtonText: "戻る", confirmButtonColor: "#b42318" });
    if (!confirmation.isConfirmed) return;
    const baseline = baselineById.get(current.id);
    if (baseline) setPages((value) => value.map((page) => page.id === current.id ? { ...baseline, data: { ...baseline.data }, assets: [] } : page));
    else {
      setPages((value) => value.filter((page) => page.id !== current.id));
      setNavigation((value) => ({ ...value, tree: removeNavigationNode(value.tree, current.id).tree }));
      const fallback = baselinePages.find((page) => page.slug === "index") ?? baselinePages[0];
      if (fallback) selectPage(fallback.id);
    }
    setEditorRevision((value) => value + 1);
    setStatus("このページの編集を破棄しました");
  };

  const discardAll = async () => {
    if (!dirtyIds.size && !treeDirty) return;
    const confirmation = await Swal.fire({ icon: "warning", title: "すべての変更を破棄しますか？", text: "ページ、画像、削除予定、ツリーの未保存変更をすべて元に戻します。", showCancelButton: true, confirmButtonText: "すべて破棄", cancelButtonText: "戻る", confirmButtonColor: "#b42318" });
    if (!confirmation.isConfirmed) return;
    const nextPages = baselinePages.map((page) => ({ ...page, data: { ...page.data }, assets: [] }));
    setPages(nextPages); setNavigation(baselineNavigation); persistenceEpoch.current += 1; if (session.user) await writePersistedWorkspace(session.user.id);
    const selectedStillExists = nextPages.some((page) => page.id === selectedId);
    if (!selectedStillExists) selectPage(nextPages.find((page) => page.slug === "index")?.id ?? nextPages[0]?.id ?? "");
    setEditorRevision((value) => value + 1); setStatus("すべての変更を破棄しました");
  };

  const syncScroll = (source: HTMLElement, target: HTMLElement) => {
    if (syncingScroll.current) return;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    if (sourceRange <= 0) return;
    scrollRatio.current = source.scrollTop / sourceRange;
    if (targetRange <= 0) return;
    syncingScroll.current = true;
    target.scrollTop = scrollRatio.current * targetRange;
    requestAnimationFrame(() => { syncingScroll.current = false; });
  };

  const switchPane = (pane: "edit" | "preview") => {
    if (pane === activePane) return;
    const editScroller = sourceMode ? sourceEditorRef.current : editorPaneRef.current;
    const source = activePane === "edit" ? editScroller : previewPaneRef.current;
    const target = pane === "edit" ? editScroller : previewPaneRef.current;
    if (source && target) syncScroll(source, target);
    setActivePane(pane);
    requestAnimationFrame(() => { if (source && target) syncScroll(source, target); });
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = activePane === "preview" ? previewPaneRef.current : sourceMode ? sourceEditorRef.current : editorPaneRef.current;
      if (!target) return;
      target.scrollTop = scrollRatio.current * Math.max(0, target.scrollHeight - target.clientHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [activePane, sourceMode]);

  const previewHtml = useMemo(() => {
    if (!current) return "";
    const assets = new Map(current.assets.map((asset) => [asset.name, `data:${asset.mime};base64,${asset.contentBase64}`]));
    const renderer = new marked.Renderer();
    renderer.image = ({ href, text, title }) => {
      const name = href.startsWith("./assets/") ? href.slice(9) : "";
      const src = assets.get(name) ?? (href.startsWith("./assets/") ? `https://raw.githubusercontent.com/KamePowerWorld/kpw-docs/master/pages/${current.slug}/assets/${encodeURIComponent(name)}` : href);
      return `<img src="${src}" alt="${text.replaceAll('"', "&quot;")}"${title ? ` title="${title}"` : ""}>`;
    };
    return DOMPurify.sanitize(marked.parse(current.body, { gfm: true, renderer }) as string, { USE_PROFILES: { html: true } });
  }, [current?.body, current?.assets, current?.slug]);

  const reviewChanges = useMemo(() => pages.filter((page) => dirtyIds.has(page.id)).map((page) => {
    const baseline = baselineById.get(page.id);
    const before = baseline ? serializeDocument(baseline) : "";
    const after = page.deleted ? "" : serializeDocument(page);
    return { page, baseline, changes: diffLines(before, after) };
  }), [pages, dirtyIds, baselineById]);
  const navigationChanges = useMemo(() => treeDirty ? diffLines(navigationFingerprint(baselineNavigation), navigationFingerprint(safeNavigation)) : [], [treeDirty, baselineNavigation, safeNavigation]);

  const openSaveReview = () => {
    if (!session.authenticated) { location.href = "/api/auth/login"; return; }
    if (!baseCommitSha) { setStatus("公開側の最新版を読み込んでから保存してください"); return; }
    if (!dirtyIds.size && !treeDirty) { setStatus("保存する変更はありません"); return; }
    setReviewOpen(true);
  };

  const saveAll = async () => {
    if (!session.authenticated) { location.href = "/api/auth/login"; return; }
    if (!baseCommitSha) { setStatus("公開側の最新版を読み込んでから保存してください"); return; }
    if (!dirtyIds.size && !treeDirty) { setStatus("保存する変更はありません"); return; }
    const changed = pages.filter((page) => dirtyIds.has(page.id));
    if (changed.some((page) => !page.deleted && (!page.data.title.trim() || !page.data.heroLead.trim()))) { setStatus("変更ページのタイトルとリード文を入力してください"); return; }
    setReviewOpen(false); setSaving(true); setStatus(`${changed.length}ページとツリーを保存しています…`);
    try {
      const response = await fetch("/api/editor/save", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken ?? "" }, body: JSON.stringify({
        baseCommitSha, navigation: stringifyYaml(safeNavigation), description: "ページエディターからの一括更新です。",
        pages: changed.map((page) => ({ id: page.id, originalSlug: page.isNew ? undefined : page.originalSlug, slug: page.slug, content: page.deleted ? undefined : serializeDocument(page), deleted: Boolean(page.deleted), assets: page.assets.map(({ name, contentBase64 }) => ({ name, contentBase64 })), title: page.data.title })),
      }) });
      const result = await response.json() as SaveResponse;
      if (!response.ok || !result.mode) throw new Error(result.error ?? "保存に失敗しました");
      const savedPages = pages.filter((page) => !page.deleted).map((page) => ({ ...page, originalSlug: page.slug, isNew: false, assets: [] }));
      persistenceEpoch.current += 1;
      if (result.commitSha && session.user) localStorage.setItem(lastSavedCommitKey(session.user.id), result.commitSha);
      setPages(savedPages); setBaselinePages(savedPages); setBaselineNavigation(safeNavigation); setBaseCommitSha(result.commitSha); if (session.user) await writePersistedWorkspace(session.user.id);
      setStatus("保存しました。自動デプロイ完了後に公開サイトへ反映されます。"); setSaving(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : "保存に失敗しました"); setSaving(false); }
  };

  if (!current) return <p>編集できるページがありません。</p>;
  const exitPath = baselineDecorated.find((page) => page.id === current.id)?.canonicalPath ?? "/";
  const indexPage = decorated.find((page) => page.slug === "index" && !page.deleted)!;
  const indexAccess = accessByPage[indexPage.id] ?? deniedAccess;
  const activeDragPage = treePages.find((page) => page.id === activeDragId);
  return <div className="editor-app">
    <header className="editor-topbar">
      <a href={exitPath} className="editor-brand">← 編集をやめる</a>
      <button className="explorer-toggle" onClick={() => setExplorerOpen((value) => !value)}>☰ ページ</button>
      <a className="topbar-view-page" href={current.canonicalPath} target="_blank" rel="noreferrer">ページを見る ↗</a>
      <div className="editor-session">{session.authenticated ? <><img src={session.user?.avatarUrl} alt="" /><span>{session.user?.displayName}</span></> : <a href="/api/auth/login">Discordでログイン</a>}</div>
      <button className="publish-button" disabled={saving} onClick={openSaveReview}>{saving ? "保存中…" : `保存＆公開${dirtyIds.size || treeDirty ? ` (${dirtyIds.size + (treeDirty ? 1 : 0)})` : ""}`}</button>
      <span className="sr-status" role="status" aria-live="polite">{status}</span>
    </header>
    <div className="editor-layout">
      <aside className={`page-explorer ${explorerOpen ? "open" : ""}`}>
        <header className="explorer-heading">
          <span><small>KPW EDITOR</small><strong>ページ</strong></span>
          <button disabled={!indexAccess.canCreateChildren} onClick={() => createPage()}><Plus aria-hidden="true" />新規ページ</button>
        </header>
        <div className={`index-row explorer-row top-page ${current.slug === "index" ? "selected" : ""}`} data-page-id={indexPage.id} style={{ "--tree-depth": 0 } as React.CSSProperties}>
          <span className="tree-leading" aria-hidden="true" />
          <button className="index-page page-name" onClick={() => selectPage(indexPage.id)}><Home aria-hidden="true" /><span className="page-title">トップページ</span>{dirtyIds.has(indexPage.id) && <span className="dirty-dot" aria-label="未保存の変更" />}</button>
          <PageActions page={indexPage} access={indexAccess} onAdd={() => createPage(indexPage.id)} onRename={() => undefined} onDelete={() => undefined} onPermissions={() => setPermissionPage(indexPage)} />
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragCancel={() => { setActiveDragId(undefined); setDropProjection(undefined); }} onDragEnd={handleDragEnd}>
          <SortableContext items={treePages.map((page) => page.id)} strategy={verticalListSortingStrategy}>
            <div className="explorer-tree">{treePages.map((page) => <SortablePage key={page.id} page={page} access={accessByPage[page.id] ?? deniedAccess} selected={page.id === current.id} dirty={dirtyIds.has(page.id)} expanded={!collapsedPageIds.has(page.id)} dropIndicator={dropProjection?.indicatorId === page.id ? dropProjection : undefined} onSelect={() => selectPage(page.id)} onToggle={() => setCollapsedPageIds((currentIds) => { const nextIds = new Set(currentIds); if (nextIds.has(page.id)) nextIds.delete(page.id); else nextIds.add(page.id); return nextIds; })} onAdd={() => createPage(page.id)} onRename={() => renameSlug(page)} onDelete={() => void deletePage(page)} onPermissions={() => setPermissionPage(page)} />)}</div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>{activeDragPage && <div className="explorer-drag-overlay"><GripVertical aria-hidden="true" /><span>{activeDragPage.data.title}</span>{activeDragPage.childIds.length > 0 && <small>子ページ {activeDragPage.childIds.length}件</small>}</div>}</DragOverlay>
        </DndContext>
        {deletedPages.length > 0 && <div className="deleted-pages"><strong>削除予定</strong>{deletedPages.map((page) => <button key={page.id} onClick={() => undoDelete(page)}><s>{page.data.title}</s><span>取り消す</span></button>)}</div>}
        <div className="explorer-footer">
          <p className="explorer-help"><Info aria-hidden="true" /><span>ハンドルを上下へドラッグして並べ替え、左右へ動かすと階層を変更できます。親を動かすと子も一緒に移動します。</span></p>
          <p className="explorer-legend"><span className="dirty-dot" aria-hidden="true" />未保存の変更</p>
          <button className="discard-all-button" disabled={!dirtyIds.size && !treeDirty} onClick={() => void discardAll()}><RotateCcw aria-hidden="true" />すべての変更を破棄</button>
        </div>
      </aside>
      {explorerOpen && <button className="explorer-backdrop" aria-label="ページ一覧を閉じる" onClick={() => setExplorerOpen(false)} />}
      <div className="editor-content">
        {!currentAccess.canEdit && <div className="read-only-notice">このページは読み取り専用です。Discordのロールまたはページ権限が必要です。</div>}
        <div className="editor-meta">
          <label>タイトル<input disabled={!currentAccess.canEdit} value={current.data.title} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, title: event.target.value } }))} /></label>
          <label className="wide">リード文<input disabled={!currentAccess.canEdit} value={current.data.heroLead} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, heroLead: event.target.value } }))} /></label>
          <div className="meta-controls">
            <label className="checkbox"><input type="checkbox" checked={current.data.draft} disabled={current.slug === "index" || !currentAccess.canEdit} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, draft: event.target.checked } }))} />まだ非公開</label>
            <label className="source-switch"><input type="checkbox" role="switch" checked={sourceMode} onChange={(event) => { setSourceMode(event.target.checked); switchPane("edit"); }} /><span aria-hidden="true"></span>Markdownソース</label>
          </div>
          <div className="discard-page-cell">
            <button className="discard-page-button" disabled={!dirtyIds.has(current.id)} onClick={() => void discardCurrent()}>編集を破棄</button>
          </div>
        </div>
        <div className="editor-workspace">
          <section ref={editorPaneRef} onScroll={(event) => { if (previewPaneRef.current) syncScroll(event.currentTarget, previewPaneRef.current); }} className={`editor-pane ${activePane === "edit" ? "is-active" : ""}`} aria-label="本文エディター">
            {sourceMode ? <textarea readOnly={!currentAccess.canEdit} ref={sourceEditorRef} onScroll={(event) => { if (previewPaneRef.current) syncScroll(event.currentTarget, previewPaneRef.current); }} className="source-editor" value={current.body} onChange={(event) => updatePage(current.id, (page) => ({ ...page, body: event.target.value }))} />
              : <MilkdownSurface key={`${current.id}-${editorRevision}-${currentAccess.canEdit}`} readOnly={!currentAccess.canEdit} value={current.body} onChange={(body) => currentAccess.canEdit && updatePage(current.id, (page) => ({ ...page, body }))} onUpload={uploadImage} resolveImage={resolveEditorImage} />}
          </section>
          <section ref={previewPaneRef} onScroll={(event) => { if (editorPaneRef.current) syncScroll(event.currentTarget, editorPaneRef.current); }} className={`preview-pane ${activePane === "preview" ? "is-active" : ""}`} aria-label="サイトプレビュー">
            <div className="preview-hero"><h1>{current.data.title || "新しいガイド"}</h1><span>{current.data.heroLead}</span></div>
            <article className="markdown-body notion-article" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </section>
        </div>
      </div>
    </div>
    <nav className="mobile-pane-switcher" aria-label="編集表示の切り替え"><button className={activePane === "edit" ? "active" : ""} onClick={() => switchPane("edit")}>編集</button><button className={activePane === "preview" ? "active" : ""} onClick={() => switchPane("preview")}>プレビュー</button></nav>
    {reviewOpen && <div className="save-review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewOpen(false); }}>
      <section className="save-review" role="dialog" aria-modal="true" aria-labelledby="save-review-title">
        <header><div><span>保存前の確認</span><h2 id="save-review-title">変更内容を確認</h2></div><button aria-label="閉じる" onClick={() => setReviewOpen(false)}>×</button></header>
        <div className="save-review-body">
          {reviewChanges.map(({ page, baseline, changes }) => <section className="diff-card" key={page.id}>
            <h3>{page.deleted ? "削除：" : baseline ? "変更：" : "追加："}{page.data.title}</h3>
            {baseline && baseline.slug !== page.slug && <p className="slug-diff"><del>/{baseline.slug}</del><ins>/{page.slug}</ins></p>}
            {page.assets.length > 0 && <p className="asset-diff">追加画像：{page.assets.map((asset) => asset.name).join("、")}</p>}
            <DiffLines changes={changes} />
          </section>)}
          {treeDirty && <section className="diff-card"><h3>ページツリー</h3><DiffLines changes={navigationChanges} /></section>}
        </div>
        <footer><button className="review-cancel" onClick={() => setReviewOpen(false)}>編集に戻る</button><button className="review-save" onClick={() => void saveAll()}>この内容で保存</button></footer>
      </section>
    </div>}
    {permissionPage && session.csrfToken && <PermissionsDialog page={permissionPage} csrfToken={session.csrfToken} onClose={() => setPermissionPage(undefined)} onSaved={() => { setPermissionPage(undefined); setStatus("ページ権限を保存しました。最新の権限は次回読み込み時に反映されます。"); }} />}
  </div>;
}
