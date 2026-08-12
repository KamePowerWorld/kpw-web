import { useEffect, useMemo, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import DOMPurify from "dompurify";
import { marked } from "marked";
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
type PersistedWorkspace = { pages: PageDraft[]; navigation: Navigation; dirtyIds: string[]; treeDirty: boolean; baseCommitSha?: string; selectedId: string };

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspaceStorageKey = "current";

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

function MilkdownSurface({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const crepe = new Crepe({ root: root.current, defaultValue: value, features: {
      [CrepeFeature.AI]: false, [CrepeFeature.Latex]: false, [CrepeFeature.CodeMirror]: false,
    } });
    crepe.on((listener) => listener.markdownUpdated((_ctx, markdown) => { if (markdown !== value) onChange(markdown); }));
    void crepe.create();
    return () => { void crepe.destroy(); };
  }, []);
  return <div className="milkdown-host" ref={root} />;
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
  const searchParams = new URLSearchParams(location.search);
  const requestedId = searchParams.get("page") ?? initialPages.find((page) => page.filePath === searchParams.get("path"))?.id;
  const [pages, setPages] = useState<PageDraft[]>(initialPages);
  const [navigation, setNavigation] = useState<Navigation>(() => normalizeNavigation(initialNavigation, initialPages.filter((page) => page.slug !== "index").map((page) => page.id)));
  const [selectedId, setSelectedId] = useState(requestedId ?? initialPages.find((page) => page.slug === "index")?.id ?? initialPages[0]?.id ?? "");
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [treeDirty, setTreeDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [baseCommitSha, setBaseCommitSha] = useState<string>();
  const [status, setStatus] = useState("変更内容はこのブラウザに保存されます");
  const [saving, setSaving] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [activePane, setActivePane] = useState<"edit" | "preview">("edit");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const allowedNavigationIds = pages.filter((page) => page.slug !== "index" && !page.deleted).map((page) => page.id);
  const safeNavigation = useMemo(() => normalizeNavigation(navigation, allowedNavigationIds), [navigation, pages]);
  const decorated = useMemo(() => decoratePages(pages, safeNavigation), [pages, safeNavigation]);
  const current = decorated.find((page) => page.id === selectedId && !page.deleted) ?? decorated.find((page) => page.slug === "index" && !page.deleted) ?? decorated.find((page) => !page.deleted);
  const flatTree = useMemo(() => flattenNavigation(safeNavigation.tree), [safeNavigation]);
  const treePages = flatTree.map((entry) => decorated.find((page) => page.id === entry.id)).filter((page): page is PageDraft => Boolean(page && !page.deleted));
  const deletedPages = pages.filter((page) => page.deleted);

  useEffect(() => {
    void Promise.all([fetch("/api/github/session").then((response) => response.json() as Promise<Session>), readPersistedWorkspace().catch(() => undefined)])
      .then(([nextSession, stored]) => {
        setSession(nextSession);
        if (stored) {
          const storedPages = [...new Map(stored.pages.map((page) => [page.id, page])).values()];
          const repairedNavigation = normalizeNavigation(stored.navigation, storedPages.filter((page) => page.slug !== "index" && !page.deleted).map((page) => page.id));
          const repaired = stringifyYaml(repairedNavigation) !== stringifyYaml(stored.navigation);
          setPages(storedPages); setNavigation(repairedNavigation); setDirtyIds(new Set(stored.dirtyIds)); setTreeDirty(stored.treeDirty || repaired);
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
      if (dirtyIds.size || treeDirty) {
        if (!baseCommitSha) setBaseCommitSha(result.baseCommitSha);
        setStatus("保存済みの編集内容を表示中です。GitHubの最新版は一括保存時に競合確認されます。"); return;
      }
      const remotePages = result.pages.map((item) => parseDocument(item.content, item.slug));
      const remoteNavigation = parseYaml(result.navigation) as Navigation;
      setPages(remotePages); setNavigation(normalizeNavigation(remoteNavigation, remotePages.filter((page) => page.slug !== "index").map((page) => page.id))); setBaseCommitSha(result.baseCommitSha); setStatus("GitHub上の最新版を読み込みました");
    }).catch((error) => setStatus(`ローカル内容を表示中：${error instanceof Error ? error.message : "取得に失敗しました"}`));
  }, [hydrated, session.authenticated]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      const hasChanges = dirtyIds.size > 0 || treeDirty;
      void writePersistedWorkspace(hasChanges ? { pages, navigation: safeNavigation, dirtyIds: [...dirtyIds], treeDirty, baseCommitSha, selectedId } : undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [pages, safeNavigation, dirtyIds, treeDirty, baseCommitSha, selectedId, hydrated]);

  const markDirty = (id: string) => setDirtyIds((currentIds) => new Set(currentIds).add(id));
  const updatePage = (id: string, updater: (page: PageDraft) => PageDraft) => {
    setPages((currentPages) => currentPages.map((page) => page.id === id ? updater(page) : page)); markDirty(id);
  };
  const selectPage = (id: string) => {
    setSelectedId(id); setEditorRevision((value) => value + 1); setExplorerOpen(false);
    history.replaceState(null, "", `/editor?page=${encodeURIComponent(id)}`);
  };

  const releaseAlias = (slug: string, exceptId: string) => {
    const affected: string[] = [];
    setPages((currentPages) => currentPages.map((page) => {
      if (page.id === exceptId || !page.data.aliases.includes(slug)) return page;
      affected.push(page.id); return { ...page, data: { ...page.data, aliases: page.data.aliases.filter((alias) => alias !== slug) } };
    }));
    if (affected.length) setDirtyIds((ids) => new Set([...ids, ...affected]));
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
    setDirtyIds((ids) => new Set(ids).add(id)); setTreeDirty(true); selectPage(id); setStatus("新しいページを追加しました。まだGitHubには保存されていません。");
  };

  const renameSlug = (page: PageDraft) => {
    if (page.slug === "index") return;
    const input = window.prompt("新しいslug", page.slug); if (!input) return;
    const slug = toSlug(input); if (!slugPattern.test(slug) || slug === "index") { setStatus("使用できないslugです"); return; }
    if (pages.some((item) => item.id !== page.id && !item.deleted && item.slug === slug)) { setStatus(`slug「${slug}」はすでに使われています`); return; }
    releaseAlias(slug, page.id);
    updatePage(page.id, (item) => ({ ...item, slug, filePath: `pages/${slug}/index.md`, data: { ...item.data, aliases: [...new Set([...item.data.aliases.filter((alias) => alias !== slug), item.slug])] } }));
    setTreeDirty(true); setStatus(`slugを「${slug}」へ変更しました。一括保存時に画像も移動します。`);
  };

  const deletePage = (page: PageDraft) => {
    if (page.slug === "index") { setStatus("トップページは削除できません"); return; }
    if (page.childIds.length) { setStatus("子ページがあるため削除できません。先に子ページを移動してください。"); return; }
    if (!window.confirm(`「${page.data.title}」を削除予定にしますか？\n一括保存前なら取り消せます。`)) return;
    setPages((value) => value.map((item) => item.id === page.id ? { ...item, deleted: true } : item));
    setNavigation((value) => ({ ...value, tree: removeNavigationNode(value.tree, page.id).tree }));
    setDirtyIds((ids) => new Set(ids).add(page.id)); setTreeDirty(true);
    const index = pages.find((item) => item.slug === "index"); if (index) selectPage(index.id);
  };

  const undoDelete = (page: PageDraft) => {
    setPages((value) => value.map((item) => item.id === page.id ? { ...item, deleted: false } : item));
    setNavigation((value) => normalizeNavigation({ ...value, tree: [...value.tree, { id: page.id }] }, [...allowedNavigationIds, page.id])); setTreeDirty(true); markDirty(page.id);
  };

  const handleDragEnd = ({ active, over, delta }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeNode = findNavigationNode(safeNavigation.tree, String(active.id));
    if (activeNode && containsNavigationNode(activeNode, String(over.id))) { setStatus("子孫ページの中へは移動できません"); return; }
    const removed = removeNavigationNode(safeNavigation.tree, String(active.id)); if (!removed.node) return;
    let tree = removed.tree;
    if (delta.x > 34) tree = appendNavigationChild(tree, String(over.id), removed.node);
    else tree = insertNavigationRelative(tree, String(over.id), removed.node, delta.y > 0);
    setNavigation(normalizeNavigation({ version: 1, tree }, allowedNavigationIds)); setTreeDirty(true); setStatus("ページツリーを変更しました。まとめて保存できます。");
  };

  const indentPage = (page: PageDraft) => {
    const position = flatTree.findIndex((item) => item.id === page.id);
    const previous = position > 0 ? flatTree[position - 1] : undefined;
    if (!previous || previous.id === page.parentId) { setStatus("このページを内側へ移動できる直前のページがありません"); return; }
    const activeNode = findNavigationNode(safeNavigation.tree, page.id);
    if (!activeNode || containsNavigationNode(activeNode, previous.id)) return;
    const removed = removeNavigationNode(safeNavigation.tree, page.id);
    setNavigation(normalizeNavigation({ version: 1, tree: appendNavigationChild(removed.tree, previous.id, removed.node!) }, allowedNavigationIds)); setTreeDirty(true);
    setStatus("ページをひとつ内側へ移動しました");
  };

  const outdentPage = (page: PageDraft) => {
    if (!page.parentId) { setStatus("このページはすでに最上位です"); return; }
    const removed = removeNavigationNode(safeNavigation.tree, page.id); if (!removed.node) return;
    setNavigation(normalizeNavigation({ version: 1, tree: insertNavigationRelative(removed.tree, page.parentId, removed.node, true) }, allowedNavigationIds)); setTreeDirty(true);
    setStatus("ページをひとつ外側へ移動しました");
  };

  const addAssets = async (files: FileList | null) => {
    if (!files || !current) return; const additions = await Promise.all([...files].map(fileToDraft));
    updatePage(current.id, (page) => ({ ...page, assets: [...page.assets, ...additions], body: `${page.body.trim()}\n\n${additions.map((asset) => `![${asset.name}](./assets/${asset.name})`).join("\n\n")}\n` }));
    setEditorRevision((value) => value + 1);
  };

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

  const saveAll = async () => {
    if (!session.authenticated) { location.href = "/api/auth/login"; return; }
    if (session.installationReady === false && session.installationUrl) { location.href = session.installationUrl; return; }
    if (!baseCommitSha) { setStatus("GitHubの最新版を読み込んでから保存してください"); return; }
    if (!dirtyIds.size && !treeDirty) { setStatus("保存する変更はありません"); return; }
    const changed = pages.filter((page) => dirtyIds.has(page.id));
    if (changed.some((page) => !page.deleted && (!page.data.title.trim() || !page.data.heroLead.trim()))) { setStatus("変更ページのタイトルとリード文を入力してください"); return; }
    setSaving(true); setStatus(`${changed.length}ページとツリーをGitHubへ保存しています…`);
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
      setPages(savedPages); setDirtyIds(new Set()); setTreeDirty(false); setBaseCommitSha(result.commitSha); await writePersistedWorkspace();
      setStatus("まとめて保存しました。公開後に「ページを見る」から確認できます。"); setSaving(false);
    } catch (error) { setStatus(error instanceof Error ? error.message : "保存に失敗しました"); setSaving(false); }
  };

  if (!current) return <p>編集できるページがありません。</p>;
  return <div className="editor-app">
    <header className="editor-topbar">
      <a href="/" className="editor-brand">← ガイドへ戻る</a>
      <button className="explorer-toggle" onClick={() => setExplorerOpen((value) => !value)}>☰ ページ</button>
      <div className="editor-session">{session.authenticated ? <><img src={session.user?.avatarUrl} alt="" /><span>{session.user?.login}</span></> : <a href="/api/auth/login">GitHubでログイン</a>}</div>
      <button className="publish-button" disabled={saving} onClick={saveAll}>{saving ? "保存中…" : session.installationReady === false ? "GitHub Appを設定" : `変更をまとめて保存${dirtyIds.size || treeDirty ? ` (${dirtyIds.size + (treeDirty ? 1 : 0)})` : ""}`}</button>
    </header>
    <div className="editor-layout">
      <aside className={`page-explorer ${explorerOpen ? "open" : ""}`}>
        <div className="explorer-heading"><strong>ページ</strong><button onClick={() => createPage()}>＋ ルートに追加</button></div>
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
          <label className="checkbox"><input type="checkbox" checked={current.data.draft} disabled={current.slug === "index"} onChange={(event) => updatePage(current.id, (page) => ({ ...page, data: { ...page.data, draft: event.target.checked } }))} />まだ非公開</label>
        </div>
        <div className="editor-actions">
          <button onClick={() => { setSourceMode((value) => !value); setActivePane("edit"); }}>{sourceMode ? "通常編集に戻る" : "Markdownソース"}</button>
          <label className="asset-button">画像を追加<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => void addAssets(event.target.files)} /></label>
          <a className="view-page-button" href={current.canonicalPath} target="_blank" rel="noreferrer">ページを見る ↗</a>
          <span role="status">{status}</span>
        </div>
        <div className="editor-workspace">
          <section className={`editor-pane ${activePane === "edit" ? "is-active" : ""}`} aria-label="本文エディター">
            {sourceMode ? <textarea className="source-editor" value={current.body} onChange={(event) => updatePage(current.id, (page) => ({ ...page, body: event.target.value }))} />
              : <MilkdownSurface key={`${current.id}-${editorRevision}`} value={current.body} onChange={(body) => updatePage(current.id, (page) => ({ ...page, body }))} />}
          </section>
          <section className={`preview-pane ${activePane === "preview" ? "is-active" : ""}`} aria-label="サイトプレビュー">
            <div className="preview-hero"><h1>{current.data.title || "新しいガイド"}</h1><span>{current.data.heroLead}</span></div>
            <article className="markdown-body notion-article" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </section>
        </div>
      </div>
    </div>
    <nav className="mobile-pane-switcher" aria-label="編集表示の切り替え"><button className={activePane === "edit" ? "active" : ""} onClick={() => setActivePane("edit")}>編集</button><button className={activePane === "preview" ? "active" : ""} onClick={() => setActivePane("preview")}>プレビュー</button></nav>
  </div>;
}
