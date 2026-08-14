import { useEffect, useMemo, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import DOMPurify from "dompurify";
import { diffLines, type Change } from "diff";
import { marked } from "marked";
import Swal from "sweetalert2";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  appendNavigationChild, containsNavigationNode, findNavigationNode, flattenNavigation,
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
  authenticated: boolean; canPush?: boolean; installationReady?: boolean; installationUrl?: string; csrfToken?: string;
  user?: { login: string; name: string | null; avatarUrl: string };
};
type WorkspaceResponse = { pages: Array<{ slug: string; filePath: string; content: string }>; navigation: string; baseCommitSha: string; error?: string };
type SaveResponse = { mode?: "direct" | "pull-request"; redirectUrl?: string; actionUrl?: string; commitSha?: string; error?: string };
type PersistedWorkspace = {
  pages: PageDraft[]; navigation: Navigation; dirtyIds: string[]; treeDirty: boolean; baseCommitSha?: string; selectedId: string;
  baselinePages?: PageDraft[]; baselineNavigation?: Navigation;
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspaceStorageKey = "current";
const lastSavedCommitKey = "kpw-editor:last-saved-commit";

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

function openWorkspaceDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kpw-editor", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function readPersistedWorkspace(): Promise<PersistedWorkspace | undefined> {
  const db = await openWorkspaceDb();
  return await new Promise((resolve, reject) => {
    const request = db.transaction("workspace").objectStore("workspace").get(workspaceStorageKey);
    request.onsuccess = () => resolve(request.result as PersistedWorkspace | undefined); request.onerror = () => reject(request.error);
  });
}

async function writePersistedWorkspace(value?: PersistedWorkspace) {
  const db = await openWorkspaceDb();
  await new Promise<void>((resolve, reject) => {
    const store = db.transaction("workspace", "readwrite").objectStore("workspace");
    const request = value ? store.put(value, workspaceStorageKey) : store.delete(workspaceStorageKey);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}

function MilkdownSurface({ value, onChange, onUpload, resolveImage }: {
  value: string; onChange: (value: string) => void; onUpload: (file: File) => Promise<string>; resolveImage: (url: string) => string;
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
    crepe.on((listener) => listener.markdownUpdated((_ctx, markdown) => { if (markdown !== value) onChange(markdown); }));
    void crepe.create();
    return () => { void crepe.destroy(); };
  }, []);
  return <div className="milkdown-host" ref={root} />;
}

function DiffLines({ changes }: { changes: Change[] }) {
  return <pre className="diff-lines">{changes.map((change, index) => <span key={index} className={change.added ? "diff-added" : change.removed ? "diff-removed" : ""}>{change.value}</span>)}</pre>;
}

async function fileToDraft(file: File): Promise<AssetDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name: file.name.replace(/[^A-Za-z0-9._-]/g, "-"), contentBase64: btoa(binary), mime: file.type };
}

function SortablePage({ page, selected, dirty, onSelect, onAdd, onRename, onDelete, onIndent, onOutdent }: {
  page: PageDraft; selected: boolean; dirty: boolean; onSelect: () => void; onAdd: () => void; onRename: () => void; onDelete: () => void;
  onIndent: () => void; onOutdent: () => void;
}) {
  const sortable = useSortable({ id: page.id });
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, "--tree-depth": page.depth } as React.CSSProperties}
    className={`explorer-row ${selected ? "selected" : ""} ${sortable.isDragging ? "dragging" : ""}`}>
    <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} aria-label={`${page.data.title}を移動`}>⠿</button>
    <button className="page-name" onClick={onSelect}>{dirty && <span className="dirty-dot" aria-label="変更済み">●</span>}{page.data.draft && <span aria-label="まだ非公開">◇</span>}{page.data.title}</button>
    <div className="row-actions"><button onClick={onOutdent} title="ひとつ外側へ" aria-label="ひとつ外側へ">←</button><button onClick={onIndent} title="ひとつ内側へ" aria-label="ひとつ内側へ">→</button><button onClick={onAdd} title="子ページを追加">＋</button><button onClick={onRename} title="slugを変更">⋯</button><button onClick={onDelete} title="削除">×</button></div>
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
  const [baseCommitSha, setBaseCommitSha] = useState<string>();
  const [status, setStatus] = useState("変更内容はこのブラウザに保存されます");
  const [saving, setSaving] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [activePane, setActivePane] = useState<"edit" | "preview">("edit");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
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
  const flatTree = useMemo(() => flattenNavigation(safeNavigation.tree), [safeNavigation]);
  const treePages = flatTree.map((entry) => decorated.find((page) => page.id === entry.id)).filter((page): page is PageDraft => Boolean(page && !page.deleted));
  const deletedPages = pages.filter((page) => page.deleted);

  useEffect(() => {
    if (!hydrated || status === "変更内容はこのブラウザに保存されます") return;
    const icon = /失敗|不正|できません|ありません|競合/.test(status) ? "error" : /保存しました/.test(status) ? "success" : "info";
    void Swal.fire({ toast: true, position: "bottom-end", timer: 3200, timerProgressBar: true, showConfirmButton: false, icon, title: status });
  }, [status, hydrated]);

  useEffect(() => {
    void Promise.all([fetch("/api/github/session").then((response) => response.json() as Promise<Session>), readPersistedWorkspace().catch(() => undefined)])
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
    void fetch("/api/github/workspace").then(async (response) => {
      const result = await response.json() as WorkspaceResponse; if (!response.ok) throw new Error(result.error); return result;
    }).then((result) => {
      const lastSavedCommit = localStorage.getItem(lastSavedCommitKey);
      if (lastSavedCommit === result.baseCommitSha) {
        persistenceEpoch.current += 1;
        const remotePages = result.pages.map((item) => parseDocument(item.content, item.slug));
        const remoteNavigation = parseYaml(result.navigation) as Navigation;
        const normalizedRemoteNavigation = normalizeNavigation(remoteNavigation, remotePages.filter((page) => page.slug !== "index").map((page) => page.id));
        setPages(remotePages); setNavigation(normalizedRemoteNavigation); setBaselinePages(remotePages); setBaselineNavigation(normalizedRemoteNavigation); setBaseCommitSha(result.baseCommitSha);
        localStorage.removeItem(lastSavedCommitKey); void writePersistedWorkspace();
        setStatus("保存したGitHub上の最新版を読み込みました"); return;
      }
      if (dirtyIds.size || treeDirty) {
        if (!baseCommitSha) setBaseCommitSha(result.baseCommitSha);
        setStatus("保存済みの編集内容を表示中です。GitHubの最新版は一括保存時に競合確認されます。"); return;
      }
      const remotePages = result.pages.map((item) => parseDocument(item.content, item.slug));
      const remoteNavigation = parseYaml(result.navigation) as Navigation;
      const normalizedRemoteNavigation = normalizeNavigation(remoteNavigation, remotePages.filter((page) => page.slug !== "index").map((page) => page.id));
      setPages(remotePages); setNavigation(normalizedRemoteNavigation); setBaselinePages(remotePages); setBaselineNavigation(normalizedRemoteNavigation); setBaseCommitSha(result.baseCommitSha); setStatus("GitHub上の最新版を読み込みました");
    }).catch((error) => setStatus(`ローカル内容を表示中：${error instanceof Error ? error.message : "取得に失敗しました"}`));
  }, [hydrated, session.authenticated]);

  useEffect(() => {
    if (!hydrated) return;
    const epoch = persistenceEpoch.current;
    const timer = window.setTimeout(() => {
      if (epoch !== persistenceEpoch.current) return;
      const hasChanges = dirtyIds.size > 0 || treeDirty;
      void writePersistedWorkspace(hasChanges ? { pages, navigation: safeNavigation, dirtyIds: [...dirtyIds], treeDirty, baseCommitSha, selectedId, baselinePages, baselineNavigation } : undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pages, safeNavigation, dirtyIds, treeDirty, baseCommitSha, selectedId, hydrated, baselinePages, baselineNavigation]);

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
    setNavigation((value) => normalizeNavigation({ ...value, tree: parentId ? appendNavigationChild(value.tree, parentId, { id }) : [...value.tree, { id }] }, [...allowedNavigationIds, id]));
    selectPage(id); setStatus("新しいページを追加しました。まだGitHubには保存されていません。");
  };

  const renameSlug = (page: PageDraft) => {
    if (page.slug === "index") return;
    const input = window.prompt("新しいslug", page.slug); if (!input) return;
    const slug = toSlug(input); if (!slugPattern.test(slug) || slug === "index") { setStatus("使用できないslugです"); return; }
    if (pages.some((item) => item.id !== page.id && !item.deleted && item.slug === slug)) { setStatus(`slug「${slug}」はすでに使われています`); return; }
    releaseAlias(slug, page.id);
    updatePage(page.id, (item) => ({ ...item, slug, filePath: `pages/${slug}/index.md`, data: { ...item.data, aliases: [...new Set([...item.data.aliases.filter((alias) => alias !== slug), item.slug])] } }));
    setStatus(`slugを「${slug}」へ変更しました。一括保存時に画像も移動します。`);
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

  const handleDragEnd = ({ active, over, delta }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeNode = findNavigationNode(safeNavigation.tree, String(active.id));
    if (activeNode && containsNavigationNode(activeNode, String(over.id))) { setStatus("子孫ページの中へは移動できません"); return; }
    const removed = removeNavigationNode(safeNavigation.tree, String(active.id)); if (!removed.node) return;
    let tree = removed.tree;
    if (delta.x > 34) tree = appendNavigationChild(tree, String(over.id), removed.node);
    else tree = insertNavigationRelative(tree, String(over.id), removed.node, delta.y > 0);
    setNavigation(normalizeNavigation({ version: 1, tree }, allowedNavigationIds)); setStatus("ページツリーを変更しました。まとめて保存できます。");
  };

  const indentPage = (page: PageDraft) => {
    const position = flatTree.findIndex((item) => item.id === page.id);
    const previous = position > 0 ? flatTree[position - 1] : undefined;
    if (!previous || previous.id === page.parentId) { setStatus("このページを内側へ移動できる直前のページがありません"); return; }
    const activeNode = findNavigationNode(safeNavigation.tree, page.id);
    if (!activeNode || containsNavigationNode(activeNode, previous.id)) return;
    const removed = removeNavigationNode(safeNavigation.tree, page.id);
    setNavigation(normalizeNavigation({ version: 1, tree: appendNavigationChild(removed.tree, previous.id, removed.node!) }, allowedNavigationIds));
    setStatus("ページをひとつ内側へ移動しました");
  };

  const outdentPage = (page: PageDraft) => {
    if (!page.parentId) { setStatus("このページはすでに最上位です"); return; }
    const removed = removeNavigationNode(safeNavigation.tree, page.id); if (!removed.node) return;
    setNavigation(normalizeNavigation({ version: 1, tree: insertNavigationRelative(removed.tree, page.parentId, removed.node, true) }, allowedNavigationIds));
    setStatus("ページをひとつ外側へ移動しました");
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
    setPages(nextPages); setNavigation(baselineNavigation); persistenceEpoch.current += 1; await writePersistedWorkspace();
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
    if (session.installationReady === false && session.installationUrl) { location.href = session.installationUrl; return; }
    if (!baseCommitSha) { setStatus("GitHubの最新版を読み込んでから保存してください"); return; }
    if (!dirtyIds.size && !treeDirty) { setStatus("保存する変更はありません"); return; }
    setReviewOpen(true);
  };

  const saveAll = async () => {
    if (!session.authenticated) { location.href = "/api/auth/login"; return; }
    if (session.installationReady === false && session.installationUrl) { location.href = session.installationUrl; return; }
    if (!baseCommitSha) { setStatus("GitHubの最新版を読み込んでから保存してください"); return; }
    if (!dirtyIds.size && !treeDirty) { setStatus("保存する変更はありません"); return; }
    const changed = pages.filter((page) => dirtyIds.has(page.id));
    if (changed.some((page) => !page.deleted && (!page.data.title.trim() || !page.data.heroLead.trim()))) { setStatus("変更ページのタイトルとリード文を入力してください"); return; }
    setReviewOpen(false); setSaving(true); setStatus(`${changed.length}ページとツリーをGitHubへ保存しています…`);
    try {
      const response = await fetch("/api/github/save", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken ?? "" }, body: JSON.stringify({
        baseCommitSha, navigation: stringifyYaml(safeNavigation), description: "ページエディターからの一括更新です。",
        pages: changed.map((page) => ({ id: page.id, originalSlug: page.isNew ? undefined : page.originalSlug, slug: page.slug, content: page.deleted ? undefined : serializeDocument(page), deleted: Boolean(page.deleted), assets: page.assets.map(({ name, contentBase64 }) => ({ name, contentBase64 })), title: page.data.title })),
      }) });
      const result = await response.json() as SaveResponse;
      if (!response.ok && result.actionUrl) { setStatus(result.error ?? "GitHubで準備を続けてください"); window.setTimeout(() => { location.href = result.actionUrl!; }, 900); return; }
      if (!response.ok || !result.mode) throw new Error(result.error ?? "保存に失敗しました");
      if (result.mode === "pull-request") { setStatus("GitHubのPull Request作成画面を開きます"); window.setTimeout(() => { location.href = result.redirectUrl!; }, 600); return; }
      const savedPages = pages.filter((page) => !page.deleted).map((page) => ({ ...page, originalSlug: page.slug, isNew: false, assets: [] }));
      persistenceEpoch.current += 1;
      if (result.commitSha) localStorage.setItem(lastSavedCommitKey, result.commitSha);
      setPages(savedPages); setBaselinePages(savedPages); setBaselineNavigation(safeNavigation); setBaseCommitSha(result.commitSha); await writePersistedWorkspace();
      setStatus("GitHubへ保存しました。自動デプロイ完了後に公開サイトへ反映されます。"); setSaving(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : "保存に失敗しました"); setSaving(false); }
  };

  if (!current) return <p>編集できるページがありません。</p>;
  const exitPath = baselineDecorated.find((page) => page.id === current.id)?.canonicalPath ?? "/";
  return <div className="editor-app">
    <header className="editor-topbar">
      <a href={exitPath} className="editor-brand">← 編集をやめる</a>
      <button className="explorer-toggle" onClick={() => setExplorerOpen((value) => !value)}>☰ ページ</button>
      <a className="topbar-view-page" href={current.canonicalPath} target="_blank" rel="noreferrer">ページを見る ↗</a>
      <div className="editor-session">{session.authenticated ? <><img src={session.user?.avatarUrl} alt="" /><span>{session.user?.login}</span></> : <a href="/api/auth/login">GitHubでログイン</a>}</div>
      <button className="publish-button" disabled={saving} onClick={openSaveReview}>{saving ? "保存中…" : session.installationReady === false ? "GitHub Appを設定" : `変更をまとめて保存${dirtyIds.size || treeDirty ? ` (${dirtyIds.size + (treeDirty ? 1 : 0)})` : ""}`}</button>
      <span className="sr-status" role="status" aria-live="polite">{status}</span>
    </header>
    <div className="editor-layout">
      <aside className={`page-explorer ${explorerOpen ? "open" : ""}`}>
        <div className="explorer-heading"><strong>ページ</strong><button onClick={() => createPage()}>＋ ルートに追加</button></div>
        <button className="discard-all-button" disabled={!dirtyIds.size && !treeDirty} onClick={() => void discardAll()}>変更をすべて破棄</button>
        <button className={`index-page ${current.slug === "index" ? "selected" : ""}`} onClick={() => selectPage(pages.find((page) => page.slug === "index")!.id)}>
          {dirtyIds.has(pages.find((page) => page.slug === "index")!.id) && <span className="dirty-dot">●</span>}⌂ トップページ
        </button>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={treePages.map((page) => page.id)} strategy={verticalListSortingStrategy}>
            <div className="explorer-tree">{treePages.map((page) => <SortablePage key={page.id} page={page} selected={page.id === current.id} dirty={dirtyIds.has(page.id)} onSelect={() => selectPage(page.id)} onAdd={() => createPage(page.id)} onRename={() => renameSlug(page)} onDelete={() => deletePage(page)} onIndent={() => indentPage(page)} onOutdent={() => outdentPage(page)} />)}</div>
          </SortableContext>
        </DndContext>
        {deletedPages.length > 0 && <div className="deleted-pages"><strong>削除予定</strong>{deletedPages.map((page) => <button key={page.id} onClick={() => undoDelete(page)}><s>{page.data.title}</s><span>取り消す</span></button>)}</div>}
        <p className="explorer-help">左右へドラッグすると親を変更できます。● は未保存の変更です。</p>
      </aside>
      {explorerOpen && <button className="explorer-backdrop" aria-label="ページ一覧を閉じる" onClick={() => setExplorerOpen(false)} />}
      <div className="editor-content">
        <div className="editor-meta">
          <label>タイトル<input value={current.data.title} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, title: event.target.value } }))} /></label>
          <label className="wide">リード文<input value={current.data.heroLead} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, heroLead: event.target.value } }))} /></label>
          <div className="meta-controls">
            <label className="checkbox"><input type="checkbox" checked={current.data.draft} disabled={current.slug === "index"} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, draft: event.target.checked } }))} />まだ非公開</label>
            <label className="source-switch"><input type="checkbox" role="switch" checked={sourceMode} onChange={(event) => { setSourceMode(event.target.checked); switchPane("edit"); }} /><span aria-hidden="true"></span>Markdownソース</label>
            <button className="discard-page-button" disabled={!dirtyIds.has(current.id)} onClick={() => void discardCurrent()}>編集を破棄</button>
          </div>
        </div>
        <div className="editor-workspace">
          <section ref={editorPaneRef} onScroll={(event) => { if (previewPaneRef.current) syncScroll(event.currentTarget, previewPaneRef.current); }} className={`editor-pane ${activePane === "edit" ? "is-active" : ""}`} aria-label="本文エディター">
            {sourceMode ? <textarea ref={sourceEditorRef} onScroll={(event) => { if (previewPaneRef.current) syncScroll(event.currentTarget, previewPaneRef.current); }} className="source-editor" value={current.body} onChange={(event) => updatePage(current.id, (page) => ({ ...page, body: event.target.value }))} />
              : <MilkdownSurface key={`${current.id}-${editorRevision}`} value={current.body} onChange={(body) => updatePage(current.id, (page) => ({ ...page, body }))} onUpload={uploadImage} resolveImage={resolveEditorImage} />}
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
  </div>;
}
