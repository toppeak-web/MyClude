import { useEffect, useMemo, useRef, useState } from "react";

type Album = {
  id: string;
  title: string;
  description: string;
};

type AlbumItem = {
  imageId: string;
  itemType: "image" | "text";
  createdAt: string;
  originalName?: string;
  thumbUrl?: string;
  previewUrl?: string;
  contentUrl?: string;
  contentMime?: string;
};

type User = {
  id: string;
  username: string;
};

const apiBase = import.meta.env.VITE_API_BASE as string;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function toErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  try {
    const parsed = JSON.parse(err.message) as { error?: string };
    return parsed.error ?? err.message;
  } catch {
    return err.message;
  }
}

async function compressImage(file: File, width: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const ratio = bitmap.width / bitmap.height;
  const targetW = Math.min(width, bitmap.width);
  const targetH = Math.round(targetW / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("failed to compress image"))),
      "image/webp",
      quality
    );
  });
}

function paginateText(input: string, fontSize: number): string[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const pageInnerWidth = 640;
  const pageInnerHeight = 800;
  const charsPerLine = Math.max(14, Math.floor(pageInnerWidth / (fontSize * 0.95)));
  const maxVisualLines = Math.max(8, Math.floor(pageInnerHeight / (fontSize * 1.65)));
  const pages: string[] = [];
  let current = "";
  let currentVisualLines = 0;

  function visualLineCount(text: string): number {
    if (!text) return 1;
    return Math.max(1, Math.ceil(text.length / charsPerLine));
  }

  for (const line of lines) {
    const lineVisualLines = visualLineCount(line);
    const nextVisualLines = currentVisualLines + lineVisualLines;
    if (nextVisualLines > maxVisualLines && current) {
      pages.push(current);
      current = line;
      currentVisualLines = lineVisualLines;
    } else {
      current = current ? `${current}\n${line}` : line;
      currentVisualLines = nextVisualLines;
    }
  }
  if (current.trim().length > 0) pages.push(current);
  return pages.length > 0 ? pages : [""];
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [status, setStatus] = useState("Checking session...");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumQuery, setAlbumQuery] = useState("");
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");

  const [items, setItems] = useState<AlbumItem[]>([]);
  const [itemQuery, setItemQuery] = useState("");
  const [sortBy, setSortBy] = useState<"new" | "old" | "name">("new");
  const [selectedImages, setSelectedImages] = useState<string[]>([]);

  const [newAlbumTitle, setNewAlbumTitle] = useState("");
  const [newAlbumDescription, setNewAlbumDescription] = useState("");

  const [activeIndex, setActiveIndex] = useState(0);
  const [savedImageId, setSavedImageId] = useState<string | null>(null);
  const [savedProgress, setSavedProgress] = useState(0);

  const [busy, setBusy] = useState(false);
  const [uploadDone, setUploadDone] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [textPreview, setTextPreview] = useState("");
  const [textPage, setTextPage] = useState(0);
  const [novelMode, setNovelMode] = useState(false);
  const [novelTheme, setNovelTheme] = useState<"light" | "dark">("light");
  const [fontSize, setFontSize] = useState(22);
  const [fontFamily, setFontFamily] = useState<string>("RIDIBatang");
  const [customFontLabel, setCustomFontLabel] = useState<string>("");
  const [customFontFamily, setCustomFontFamily] = useState<string>("");
  const [pageInput, setPageInput] = useState("");
  const customFontInputRef = useRef<HTMLInputElement | null>(null);

  const selectedAlbum = useMemo(
    () => albums.find((a) => a.id === selectedAlbumId) ?? null,
    [albums, selectedAlbumId]
  );

  const filteredAlbums = useMemo(() => {
    const q = albumQuery.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => `${a.title} ${a.description}`.toLowerCase().includes(q));
  }, [albums, albumQuery]);

  const filteredItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    let list = !q ? [...items] : items.filter((x) => x.imageId.toLowerCase().includes(q));
    if (sortBy === "new") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (sortBy === "old") list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sortBy === "name") list.sort((a, b) => a.imageId.localeCompare(b.imageId));
    return list;
  }, [items, itemQuery, sortBy]);

  const activeItem = filteredItems[activeIndex] ?? null;
  const textPages = useMemo(() => paginateText(textPreview, fontSize), [textPreview, fontSize]);

  useEffect(() => {
    if (!activeItem || activeItem.itemType !== "text") setNovelMode(false);
  }, [activeItem?.imageId, activeItem?.itemType]);

  useEffect(() => {
    setPageInput(String(textPage + 1));
  }, [textPage]);

  useEffect(() => {
    async function loadTextPreview() {
      if (!activeItem || activeItem.itemType !== "text" || !activeItem.contentUrl) {
        setTextPreview("");
        setTextPage(0);
        return;
      }
      try {
        const res = await fetch(activeItem.contentUrl);
        const text = await res.text();
        setTextPreview(text);
        if (savedImageId === activeItem.imageId) {
          const pages = paginateText(text, fontSize);
          const restored = Math.round((savedProgress || 0) * Math.max(0, pages.length - 1));
          setTextPage(Math.max(0, Math.min(pages.length - 1, restored)));
        } else {
          setTextPage(0);
        }
      } catch {
        setTextPreview("failed to load text preview");
        setTextPage(0);
      }
    }
    void loadTextPreview();
  }, [activeItem?.imageId, activeItem?.itemType, activeItem?.contentUrl, savedImageId, savedProgress, fontSize]);

  useEffect(() => {
    if (textPage >= textPages.length) {
      setTextPage(Math.max(0, textPages.length - 1));
    }
  }, [textPage, textPages.length]);

  async function loadMe() {
    setAuthLoading(true);
    try {
      const data = await api<{ user: User }>("/api/auth/me", { method: "GET" });
      setUser(data.user);
      setStatus(`Signed in as ${data.user.username}`);
    } catch {
      setUser(null);
      setStatus("Not signed in");
    } finally {
      setAuthLoading(false);
    }
  }

  async function loadAlbums() {
    if (!user) return;
    const data = await api<{ items: Album[] }>("/api/albums", { method: "GET" });
    setAlbums(data.items);
    if (!selectedAlbumId && data.items.length > 0) setSelectedAlbumId(data.items[0].id);
  }

  async function loadSelectedAlbum(albumId: string) {
    const [itemData, progressData] = await Promise.all([
      api<{ items: AlbumItem[] }>(`/api/albums/${albumId}/items`, { method: "GET" }),
      api<{ item: { image_id: string; progress: number } | null }>(`/api/albums/${albumId}/progress`, { method: "GET" })
    ]);
    setItems(itemData.items);
    setSelectedImages([]);
    const imageId = progressData.item?.image_id ?? null;
    const progress = progressData.item?.progress ?? 0;
    setSavedImageId(imageId);
    setSavedProgress(progress);

    if (imageId) {
      const idx = itemData.items.findIndex((x) => x.imageId === imageId);
      setActiveIndex(idx >= 0 ? idx : 0);
    } else {
      setActiveIndex(0);
    }
  }

  useEffect(() => {
    void loadMe();
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadAlbums();
  }, [user]);

  useEffect(() => {
    if (!user || !selectedAlbumId) return;
    void loadSelectedAlbum(selectedAlbumId);
  }, [user, selectedAlbumId]);

  useEffect(() => {
    if (selectedAlbum) setRenameTitle(selectedAlbum.title);
  }, [selectedAlbum?.id]);

  useEffect(() => {
    if (activeIndex >= filteredItems.length) setActiveIndex(0);
  }, [filteredItems.length, activeIndex]);

  async function register() {
    try {
      setBusy(true);
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setStatus("Registered. Sign in now.");
    } catch (err) {
      setStatus(`Register failed: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    try {
      setBusy(true);
      const data = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setUser(data.user);
      setStatus(`Signed in as ${data.user.username}`);
      await loadAlbums();
    } catch (err) {
      setStatus(`Login failed: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function loginWithGoogle() {
    window.location.href = `${apiBase}/api/auth/google/start`;
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setUser(null);
      setAlbums([]);
      setItems([]);
      setSelectedAlbumId(null);
      setStatus("Signed out");
    } catch (err) {
      setStatus(`Logout failed: ${toErrorMessage(err)}`);
    }
  }

  async function createAlbum() {
    if (!newAlbumTitle.trim()) return;
    try {
      setBusy(true);
      const created = await api<{ id: string }>("/api/albums", {
        method: "POST",
        body: JSON.stringify({
          title: newAlbumTitle.trim(),
          description: newAlbumDescription.trim()
        })
      });
      setNewAlbumTitle("");
      setNewAlbumDescription("");
      await loadAlbums();
      setSelectedAlbumId(created.id);
      setStatus("Folder created");
    } catch (err) {
      setStatus(`Create folder failed: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function renameAlbum() {
    if (!selectedAlbum || !renameTitle.trim()) return;
    try {
      await api(`/api/albums/${selectedAlbum.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: renameTitle.trim(), description: selectedAlbum.description })
      });
      await loadAlbums();
      setStatus("Folder renamed");
    } catch (err) {
      setStatus(`Rename failed: ${toErrorMessage(err)}`);
    }
  }

  async function deleteAlbum(albumId: string) {
    try {
      await api(`/api/albums/${albumId}`, { method: "DELETE" });
      if (selectedAlbumId === albumId) {
        setSelectedAlbumId(null);
        setItems([]);
      }
      await loadAlbums();
      setStatus("Folder deleted");
    } catch (err) {
      setStatus(`Delete failed: ${toErrorMessage(err)}`);
    }
  }

  function toggleSelected(imageId: string) {
    setSelectedImages((prev) => (prev.includes(imageId) ? prev.filter((x) => x !== imageId) : [...prev, imageId]));
  }

  async function deleteSelectedItems() {
    if (!selectedAlbumId || selectedImages.length === 0) return;
    try {
      setBusy(true);
      await Promise.all(
        selectedImages.map((imageId) => api(`/api/albums/${selectedAlbumId}/items/${imageId}`, { method: "DELETE" }))
      );
      await loadSelectedAlbum(selectedAlbumId);
      setStatus(`${selectedImages.length} file(s) deleted`);
    } catch (err) {
      setStatus(`Delete files failed: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveProgress(imageId: string, index: number) {
    if (!selectedAlbumId) return;
    const progress = filteredItems.length > 1 ? index / (filteredItems.length - 1) : 1;
    await api(`/api/albums/${selectedAlbumId}/progress`, {
      method: "POST",
      body: JSON.stringify({ imageId, progress })
    });
    setSavedImageId(imageId);
    setSavedProgress(progress);
  }

  async function uploadFiles(fileList: FileList | null) {
    if (!selectedAlbumId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setUploadTotal(files.length);
    setUploadDone(0);

    try {
      setBusy(true);
      setStatus(`Uploading ${files.length} file(s)...`);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const imageId = crypto.randomUUID();
        const isText = file.type.startsWith("text/") || /\.(txt|md|json|csv|log)$/i.test(file.name);
        if (isText) {
          const sign = await api<{ contentPutUrl: string }>(`/api/albums/${selectedAlbumId}/images/presign-put`, {
            method: "POST",
            body: JSON.stringify({
              imageId,
              itemType: "text",
              contentType: file.type || "text/plain",
              originalName: file.name
            })
          });
          const body = await file.text();
          const putRes = await fetch(sign.contentPutUrl, {
            method: "PUT",
            body,
            headers: { "content-type": file.type || "text/plain" }
          });
          if (!putRes.ok) throw new Error("text upload failed");
        } else {
          const [thumb, preview] = await Promise.all([
            compressImage(file, 320, 0.7),
            compressImage(file, 1280, 0.82)
          ]);
          const sign = await api<{ thumbPutUrl: string; previewPutUrl: string }>(
            `/api/albums/${selectedAlbumId}/images/presign-put`,
            {
              method: "POST",
              body: JSON.stringify({ imageId, itemType: "image", contentType: "image/webp", originalName: file.name })
            }
          );
          const [thumbRes, previewRes] = await Promise.all([
            fetch(sign.thumbPutUrl, { method: "PUT", body: thumb, headers: { "content-type": "image/webp" } }),
            fetch(sign.previewPutUrl, { method: "PUT", body: preview, headers: { "content-type": "image/webp" } })
          ]);
          if (!thumbRes.ok || !previewRes.ok) throw new Error("image upload failed");
        }
        setUploadDone(i + 1);
      }

      await loadSelectedAlbum(selectedAlbumId);
      setStatus("Upload complete");
    } catch (err) {
      setStatus(`Upload failed: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function jumpToResume() {
    if (!savedImageId) return;
    const idx = filteredItems.findIndex((x) => x.imageId === savedImageId);
    if (idx >= 0) setActiveIndex(idx);
  }

  async function saveTextPageProgress(nextPage: number) {
    if (!selectedAlbumId || !activeItem || activeItem.itemType !== "text") return;
    const progress = textPages.length > 1 ? nextPage / (textPages.length - 1) : 1;
    await api(`/api/albums/${selectedAlbumId}/progress`, {
      method: "POST",
      body: JSON.stringify({ imageId: activeItem.imageId, progress })
    });
    setSavedImageId(activeItem.imageId);
    setSavedProgress(progress);
  }

  async function setTextPageAndSave(nextPage: number) {
    const bounded = Math.max(0, Math.min(textPages.length - 1, nextPage));
    setTextPage(bounded);
    await saveTextPageProgress(bounded);
  }

  async function moveTextPage(delta: number) {
    if (!activeItem || activeItem.itemType !== "text") return;
    const next = textPage + delta;
    if (next === textPage) return;
    await setTextPageAndSave(next);
  }

  async function uploadCustomFont(file: File | null) {
    if (!file) return;
    try {
      const ext = file.name.toLowerCase();
      const format =
        ext.endsWith(".otf") ? "opentype" :
        ext.endsWith(".ttf") ? "truetype" :
        ext.endsWith(".woff2") ? "woff2" :
        ext.endsWith(".woff") ? "woff" : "opentype";
      const family = `UserFont_${Date.now()}`;
      const buffer = await file.arrayBuffer();
      const face = new FontFace(family, buffer, { style: "normal", weight: "400" });
      await face.load();
      document.fonts.add(face);
      setFontFamily(family);
      setCustomFontFamily(family);
      setCustomFontLabel(file.name);
      setStatus(`Font applied: ${file.name}`);
    } catch {
      setStatus("Font upload failed");
    }
  }

  if (!apiBase) return <div className="app">VITE_API_BASE is required.</div>;

  function goHome() {
    setAlbumQuery("");
    setItemQuery("");
    setSortBy("new");
    setSelectedImages([]);
    setActiveIndex(0);
    if (!selectedAlbumId && albums.length > 0) {
      setSelectedAlbumId(albums[0].id);
    }
    setStatus(user ? `Signed in as ${user.username}` : "MyClude Drive");
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="logo-btn" onClick={goHome}>
          MyClude Drive
        </button>
        <span className="status">{status}</span>
      </header>

      {authLoading && <section className="panel">Loading auth state...</section>}

      {!authLoading && !user && (
        <section className="panel auth-panel">
          <h2>Sign In</h2>
          <p>Login success is shown above as: Signed in as username</p>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password (8+)"
          />
          <div className="row">
            <button disabled={busy} onClick={() => void register()}>
              Register
            </button>
            <button disabled={busy} onClick={() => void login()}>
              Login
            </button>
            <button disabled={busy} onClick={loginWithGoogle}>
              Continue with Google
            </button>
          </div>
        </section>
      )}

      {user && (
        <main className="drive">
          <aside className="panel sidebar">
            <div className="row spread">
              <strong>{user.username}</strong>
              <button onClick={() => void logout()}>Logout</button>
            </div>

            <h3>Folders</h3>
            <input value={albumQuery} onChange={(e) => setAlbumQuery(e.target.value)} placeholder="search folder" />
            <input
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              placeholder="new folder title"
            />
            <input
              value={newAlbumDescription}
              onChange={(e) => setNewAlbumDescription(e.target.value)}
              placeholder="description"
            />
            <button disabled={busy} onClick={() => void createAlbum()}>
              Create Folder
            </button>

            <ul className="album-list">
              {filteredAlbums.map((a) => (
                <li key={a.id} className={a.id === selectedAlbumId ? "selected" : ""}>
                  <button onClick={() => setSelectedAlbumId(a.id)}>{a.title}</button>
                  <button className="danger" onClick={() => void deleteAlbum(a.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="panel content">
            {!selectedAlbum && <p>Select or create a folder to start.</p>}

            {selectedAlbum && (
              <>
                <div className="row spread">
                  <h2>{selectedAlbum.title}</h2>
                  <span>{filteredItems.length} files</span>
                </div>

                <div className="row rename-row">
                  <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} placeholder="rename folder" />
                  <button onClick={() => void renameAlbum()}>Rename</button>
                </div>

                <div className="toolbar">
                  <input value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} placeholder="search files by id" />
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "new" | "old" | "name")}>
                    <option value="new">Newest</option>
                    <option value="old">Oldest</option>
                    <option value="name">Name</option>
                  </select>
                  <button disabled={selectedImages.length === 0 || busy} onClick={() => void deleteSelectedItems()}>
                    Delete Selected ({selectedImages.length})
                  </button>
                </div>

                <div className="upload-box">
                  <input type="file" multiple accept="image/*,text/*,.txt,.md,.json,.csv,.log" onChange={(e) => void uploadFiles(e.target.files)} />
                  <div className="row">
                    <button onClick={jumpToResume} disabled={!savedImageId}>
                      Continue where I left off
                    </button>
                    <span>{savedImageId ? `saved ${Math.round(savedProgress * 100)}%` : "no resume data"}</span>
                  </div>
                  {uploadTotal > 0 && (
                    <div className="upload-progress">
                      <div className="upload-progress-bar" style={{ width: `${Math.round((uploadDone / uploadTotal) * 100)}%` }} />
                    </div>
                  )}
                </div>

                <div className="thumbs">
                  {filteredItems.map((it, i) => (
                    <div key={it.imageId} className="thumb-card">
                      {it.itemType === "image" ? (
                        <img
                          src={it.thumbUrl}
                          alt={it.imageId}
                          className={i === activeIndex ? "active" : ""}
                          onClick={() => {
                            setActiveIndex(i);
                            void saveProgress(it.imageId, i);
                          }}
                        />
                      ) : (
                        <button
                          className={`text-tile ${i === activeIndex ? "active" : ""}`}
                          onClick={() => {
                            setActiveIndex(i);
                            setSavedImageId(it.imageId);
                          }}
                        >
                          TXT
                        </button>
                      )}
                      <label className="thumb-meta">
                        <input
                          type="checkbox"
                          checked={selectedImages.includes(it.imageId)}
                          onChange={() => toggleSelected(it.imageId)}
                        />
                        <span>{(it.originalName || it.imageId).slice(0, 14)}</span>
                      </label>
                    </div>
                  ))}
                </div>

                {activeItem && (
                  <div className="viewer">
                    {activeItem.itemType === "image" ? (
                      <img src={activeItem.previewUrl} alt={activeItem.imageId} />
                    ) : (
                      <div className="text-viewer-wrap">
                        <pre className="text-viewer">{textPages[textPage] || "No text content."}</pre>
                        <div className="row text-pager">
                          <button onClick={() => setNovelMode(true)}>Open Novel Viewer</button>
                          <button
                            disabled={textPage === 0}
                            onClick={() => void moveTextPage(-1)}
                          >
                            Prev Page
                          </button>
                          <span>
                            Page {textPage + 1} / {textPages.length}
                          </span>
                          <button
                            disabled={textPage >= textPages.length - 1}
                            onClick={() => void moveTextPage(1)}
                          >
                            Next Page
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="row">
                      <button
                        disabled={activeIndex === 0}
                        onClick={() => {
                          const next = Math.max(0, activeIndex - 1);
                          setActiveIndex(next);
                          void saveProgress(filteredItems[next].imageId, next);
                        }}
                      >
                        Prev
                      </button>
                      <button
                        disabled={activeIndex === filteredItems.length - 1}
                        onClick={() => {
                          const next = Math.min(filteredItems.length - 1, activeIndex + 1);
                          setActiveIndex(next);
                          void saveProgress(filteredItems[next].imageId, next);
                        }}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      )}

      {novelMode && activeItem?.itemType === "text" && (
        <div className={`novel-overlay ${novelTheme === "dark" ? "theme-dark" : "theme-light"}`}>
          <div className="novel-topbar">
            <span>{activeItem.originalName || activeItem.imageId}</span>
            <div className="row">
              <button onClick={() => setNovelTheme((t) => (t === "light" ? "dark" : "light"))}>
                {novelTheme === "light" ? "Dark Mode" : "Light Mode"}
              </button>
              <label className="row">
                Font
                <input
                  type="range"
                  min={16}
                  max={30}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                />
              </label>
              <select
                value={fontFamily}
                onChange={(e) => {
                  if (e.target.value === "__upload__") {
                    customFontInputRef.current?.click();
                    return;
                  }
                  setFontFamily(e.target.value);
                }}
              >
                <option value="RIDIBatang">RIDIBatang</option>
                <option value="Noto Sans KR">Noto Sans KR</option>
                <option value="Malgun Gothic">Malgun Gothic</option>
                <option value="monospace">Monospace</option>
                {customFontFamily && <option value={customFontFamily}>Custom: {customFontLabel}</option>}
                <option value="__upload__">기타(폰트 추가)</option>
              </select>
              <input
                ref={customFontInputRef}
                type="file"
                accept=".otf,.ttf,.woff,.woff2"
                style={{ display: "none" }}
                onChange={(e) => void uploadCustomFont(e.target.files?.[0] ?? null)}
              />
              <button onClick={() => setNovelMode(false)}>Exit Viewer</button>
            </div>
          </div>
          <div className="novel-stage">
            <article className="novel-page">
              <pre style={{ fontSize: `${fontSize}px`, fontFamily }}>{textPages[textPage] || ""}</pre>
            </article>
          </div>
          <div className="novel-controls">
            <button disabled={textPage === 0} onClick={() => void moveTextPage(-1)}>
              Prev Page
            </button>
            <input
              className="page-input"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={() => {
                const n = Number(pageInput || "1");
                void setTextPageAndSave(n - 1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const n = Number(pageInput || "1");
                  void setTextPageAndSave(n - 1);
                }
              }}
            />
            <span>/ {textPages.length}</span>
            <input
              className="page-slider"
              type="range"
              min={1}
              max={Math.max(1, textPages.length)}
              value={Math.min(textPages.length, textPage + 1)}
              onChange={(e) => {
                const n = Number(e.target.value);
                setTextPage(n - 1);
                setPageInput(String(n));
              }}
              onMouseUp={() => {
                const n = Number(pageInput || "1");
                void setTextPageAndSave(n - 1);
              }}
              onTouchEnd={() => {
                const n = Number(pageInput || "1");
                void setTextPageAndSave(n - 1);
              }}
            />
            <button disabled={textPage >= textPages.length - 1} onClick={() => void moveTextPage(1)}>
              Next Page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
