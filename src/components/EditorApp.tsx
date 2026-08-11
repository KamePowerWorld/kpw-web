import { useEffect, useMemo, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

type DocSummary = {
  slug: string;
  filePath: string;
  body: string;
  data: {
    title: string;
    description: string;
    order: number;
    draft: boolean;
    eyebrow: string;
    heroLead: string;
    heroImage?: string;
    credits: string;
  };
};

type Session = {
  authenticated: boolean;
  canPush?: boolean;
  csrfToken?: string;
  user?: { login: string; name: string | null; avatarUrl: string };
};

type AssetDraft = { name: string; contentBase64: string; objectUrl: string };
type ContentResponse = { content: string; baseCommitSha: string; error?: string };
type SaveResponse = { mode?: "direct" | "pull-request"; redirectUrl?: string; actionUrl?: string; error?: string };

const emptyData: DocSummary["data"] = {
  title: "",
  description: "",
  order: 100,
  draft: false,
  eyebrow: "KAMEPOWER WORLD / GUIDE",
  heroLead: "",
  credits: "かめっちイラスト：かふぇ",
};

function parseScalar(value: string) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  return trimmed;
}

function parseDocument(source: string) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: { ...emptyData }, body: source };
  const values: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) values[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }
  return { data: { ...emptyData, ...values } as DocSummary["data"], body: match[2] };
}

function serializeDocument(data: DocSummary["data"], body: string) {
  const fields: Array<[string, unknown]> = [
    ["title", data.title], ["description", data.description], ["order", data.order], ["draft", data.draft],
    ["eyebrow", data.eyebrow], ["heroLead", data.heroLead],
    ...(data.heroImage ? [["heroImage", data.heroImage] as [string, unknown]] : []),
    ["credits", data.credits],
  ];
  const yaml = fields.map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`).join("\n");
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

function toSlug(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function MilkdownSurface({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const crepe = new Crepe({
      root: root.current,
      defaultValue: value,
      features: { [CrepeFeature.AI]: false, [CrepeFeature.Latex]: false, [CrepeFeature.CodeMirror]: false },
    });
    crepe.on((listener) => listener.markdownUpdated((_ctx, markdown) => onChange(markdown)));
    void crepe.create();
    return () => { void crepe.destroy(); };
  }, []);
  return <div className="milkdown-host" ref={root} />;
}

async function fileToDraft(file: File): Promise<AssetDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name: file.name.replace(/[^A-Za-z0-9._-]/g, "-"), contentBase64: btoa(binary), objectUrl: URL.createObjectURL(file) };
}

export default function EditorApp({ initialDocs }: { initialDocs: DocSummary[] }) {
  const requestedPath = new URLSearchParams(location.search).get("path");
  const initial = initialDocs.find((doc) => doc.filePath === requestedPath) ?? null;
  const [path, setPath] = useState(initial?.filePath ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [data, setData] = useState<DocSummary["data"]>(initial?.data ?? { ...emptyData });
  const [body, setBody] = useState(initial?.body ?? "# 新しいガイド\n\nここから書き始めよう。\n");
  const [sourceMode, setSourceMode] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [assets, setAssets] = useState<AssetDraft[]>([]);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [baseCommitSha, setBaseCommitSha] = useState<string | undefined>();
  const [status, setStatus] = useState("下書きはこのブラウザに自動保存されます");
  const [saving, setSaving] = useState(false);

  const draftKey = `kpw-editor:${path || "new"}`;
  useEffect(() => {
    void fetch("/api/github/session").then((response) => response.json() as Promise<Session>).then(setSession).catch(() => undefined);
    const draft = localStorage.getItem(draftKey);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        setData(parsed.data); setBody(parsed.body); setSlug(parsed.slug || slug);
        setStatus("ブラウザに保存された下書きを復元しました");
      } catch { localStorage.removeItem(draftKey); }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(draftKey, JSON.stringify({ data, body, slug })), 250);
    return () => window.clearTimeout(timer);
  }, [data, body, slug, draftKey]);

  useEffect(() => {
    if (!session.authenticated || !path) return;
    void fetch(`/api/github/content?path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        const result = await response.json() as ContentResponse;
        if (!response.ok) throw new Error(result.error);
        return result;
      })
      .then((result) => {
        const parsed = parseDocument(result.content);
        setData(parsed.data); setBody(parsed.body); setBaseCommitSha(result.baseCommitSha); setEditorRevision((value) => value + 1);
        setStatus("GitHub上の最新版を読み込みました");
      })
      .catch((error) => setStatus(`ローカル内容を表示中：${error.message}`));
  }, [session.authenticated, path]);

  const previewHtml = useMemo(() => {
    const pageSlug = slug || toSlug(data.title) || "new-page";
    const objectUrls = new Map(assets.map((asset) => [asset.name, asset.objectUrl]));
    const renderer = new marked.Renderer();
    renderer.image = ({ href, text, title }) => {
      const name = href.startsWith("./assets/") ? href.slice("./assets/".length) : "";
      const src = objectUrls.get(name) ?? (href.startsWith("./assets/")
        ? `https://raw.githubusercontent.com/KamePowerWorld/kpw-docs/master/pages/${pageSlug}/assets/${encodeURIComponent(name)}`
        : href);
      return `<img src="${src}" alt="${text.replaceAll('"', "&quot;")}"${title ? ` title="${title}"` : ""}>`;
    };
    return DOMPurify.sanitize(marked.parse(body, { gfm: true, renderer }) as string, { USE_PROFILES: { html: true } });
  }, [body, assets, slug, data.title]);

  const updateData = <K extends keyof DocSummary["data"]>(key: K, value: DocSummary["data"][K]) => {
    setData((current) => ({ ...current, [key]: value }));
  };

  const choosePage = (filePath: string) => {
    const page = initialDocs.find((doc) => doc.filePath === filePath);
    if (!page) return;
    setPath(page.filePath); setSlug(page.slug); setData(page.data); setBody(page.body); setAssets([]);
    history.replaceState(null, "", `/editor?path=${encodeURIComponent(page.filePath)}`);
    setEditorRevision((value) => value + 1);
  };

  const addAssets = async (files: FileList | null) => {
    if (!files) return;
    const additions = await Promise.all([...files].map(fileToDraft));
    setAssets((current) => [...current, ...additions]);
    const markdown = additions.map((asset) => `![${asset.name}](./assets/${asset.name})`).join("\n\n");
    setBody((current) => `${current.trim()}\n\n${markdown}\n`);
    setEditorRevision((value) => value + 1);
  };

  const save = async () => {
    if (!session.authenticated) { location.href = "/api/auth/login"; return; }
    const finalSlug = slug || toSlug(data.title);
    if (!finalSlug || !data.title || !data.description || !data.heroLead || !data.credits) {
      setStatus("タイトル、slug、説明、リード文、クレジットを入力してください"); return;
    }
    setSaving(true); setStatus("GitHubへ保存しています…");
    try {
      const finalPath = path || `pages/${finalSlug}/index.md`;
      const response = await fetch("/api/github/save", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken ?? "" },
        body: JSON.stringify({
          path: finalPath,
          content: serializeDocument(data, body),
          baseCommitSha,
          title: data.title,
          description: data.description,
          assets: assets.map(({ name, contentBase64 }) => ({ name, contentBase64 })),
        }),
      });
      const result = await response.json() as SaveResponse;
      if (!response.ok && result.actionUrl) {
        setStatus(result.error || "GitHubで準備を続けます。下書きはブラウザに保存されています。");
        window.setTimeout(() => { location.href = result.actionUrl!; }, 900);
        return;
      }
      if (!response.ok || !result.mode || !result.redirectUrl) throw new Error(result.error || "保存に失敗しました");
      const redirectUrl = result.redirectUrl;
      localStorage.removeItem(draftKey);
      setStatus(result.mode === "direct" ? "masterへ保存しました。公開ビルドが始まります。" : "GitHubのPull Request画面を開きます。");
      window.setTimeout(() => { location.href = redirectUrl; }, 600);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存に失敗しました");
      setSaving(false);
    }
  };

  return (
    <div className="editor-app">
      <header className="editor-topbar">
        <a href="/" className="editor-brand">← ガイドへ戻る</a>
        <select aria-label="編集するページ" value={path} onChange={(event) => choosePage(event.target.value)}>
          <option value="">新しいページ</option>
          {initialDocs.map((doc) => <option key={doc.filePath} value={doc.filePath}>{doc.data.title}</option>)}
        </select>
        <div className="editor-session">
          {session.authenticated ? <><img src={session.user?.avatarUrl} alt="" /><span>{session.user?.login}</span></> : <a href="/api/auth/login">GitHubでログイン</a>}
        </div>
        <button className="publish-button" disabled={saving} onClick={save}>
          {saving ? "保存中…" : session.canPush ? "masterへ反映" : "GitHubで提案"}
        </button>
      </header>

      <div className="editor-meta">
        <label>タイトル<input value={data.title} onChange={(event) => updateData("title", event.target.value)} /></label>
        <label>slug<input value={slug} disabled={Boolean(path)} placeholder="english-kebab-case" onChange={(event) => setSlug(toSlug(event.target.value))} /></label>
        <label className="wide">説明<input value={data.description} onChange={(event) => updateData("description", event.target.value)} /></label>
        <label>表示順<input type="number" value={data.order} onChange={(event) => updateData("order", Number(event.target.value))} /></label>
        <label>見出しラベル<input value={data.eyebrow} onChange={(event) => updateData("eyebrow", event.target.value)} /></label>
        <label className="wide">リード文<input value={data.heroLead} onChange={(event) => updateData("heroLead", event.target.value)} /></label>
        <label className="wide">クレジット<input value={data.credits} onChange={(event) => updateData("credits", event.target.value)} /></label>
        <label className="checkbox"><input type="checkbox" checked={data.draft} onChange={(event) => updateData("draft", event.target.checked)} />下書き</label>
      </div>

      <div className="editor-actions">
        <button onClick={() => setSourceMode((value) => !value)}>{sourceMode ? "WYSIWYGに戻る" : "Markdownソース"}</button>
        <label className="asset-button">画像を追加<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => void addAssets(event.target.files)} /></label>
        <span role="status">{status}</span>
      </div>

      <div className="editor-workspace">
        <section className="editor-pane" aria-label="本文エディター">
          {sourceMode
            ? <textarea className="source-editor" value={body} onChange={(event) => setBody(event.target.value)} />
            : <MilkdownSurface key={editorRevision} value={body} onChange={setBody} />}
        </section>
        <section className="preview-pane" aria-label="サイトプレビュー">
          <div className="preview-hero">
            <p>{data.eyebrow}</p><h1>{data.title || "新しいガイド"}</h1><span>{data.heroLead}</span>
          </div>
          <article className="markdown-body notion-article" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </section>
      </div>
    </div>
  );
}
