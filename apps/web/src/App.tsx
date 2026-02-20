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

type ViewerSettings = {
  novelFontFamily: string | null;
  novelTheme: "light" | "dark" | null;
  novelFontSize: number | null;
  novelViewMode: "paged" | "scroll" | null;
};

type ExternalTextItem = {
  sourceUrl: string;
  title: string;
  contentType: string;
  text: string;
};

type ExternalImageItem = {
  sourceUrl: string;
  title: string;
  contentType: string;
  objectUrl: string;
};

type SavedExternalLink = {
  id: string;
  title: string;
  sourceUrl: string;
  createdAt?: string;
};

type TextPage = {
  text: string;
  startLine: number;
  endLine: number;
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

function paginateText(input: string, fontSize: number): TextPage[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const pageInnerWidth = 640;
  const pageInnerHeight = 800;
  const charsPerLine = Math.max(14, Math.floor(pageInnerWidth / (fontSize * 0.95)));
  const maxVisualLines = Math.max(8, Math.floor(pageInnerHeight / (fontSize * 1.65)));
  const pages: TextPage[] = [];
  let current = "";
  let currentVisualLines = 0;
  let pageStartLine = 0;

  function visualLineCount(text: string): number {
    if (!text) return 1;
    return Math.max(1, Math.ceil(text.length / charsPerLine));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineVisualLines = visualLineCount(line);
    const nextVisualLines = currentVisualLines + lineVisualLines;
    if (nextVisualLines > maxVisualLines && current) {
      pages.push({
        text: current,
        startLine: pageStartLine,
        endLine: Math.max(pageStartLine, i - 1)
      });
      current = line;
      currentVisualLines = lineVisualLines;
      pageStartLine = i;
    } else {
      current = current ? `${current}\n${line}` : line;
      currentVisualLines = nextVisualLines;
    }
  }
  if (current.length > 0) {
    pages.push({
      text: current,
      startLine: pageStartLine,
      endLine: Math.max(pageStartLine, lines.length - 1)
    });
  }
  return pages.length > 0
    ? pages
    : [{ text: "", startLine: 0, endLine: 0 }];
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [status, setStatus] = useState("세션 확인 중...");
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
  const [externalUrl, setExternalUrl] = useState("");
  const [externalTitle, setExternalTitle] = useState("");
  const [externalItem, setExternalItem] = useState<ExternalTextItem | null>(null);
  const [externalImageItem, setExternalImageItem] = useState<ExternalImageItem | null>(null);
  const [externalLinks, setExternalLinks] = useState<SavedExternalLink[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [textPage, setTextPage] = useState(0);
  const [novelPages, setNovelPages] = useState<TextPage[]>([{ text: "", startLine: 0, endLine: 0 }]);
  const [paginationDone, setPaginationDone] = useState(true);
  const [novelMode, setNovelMode] = useState(false);
  const [novelTheme, setNovelTheme] = useState<"light" | "dark">("light");
  const [fontSize, setFontSize] = useState(22);
  const [fontFamily, setFontFamily] = useState<string>("RIDIBatang");
  const [readerMode, setReaderMode] = useState<"paged" | "scroll">("paged");
  const [customFontLabel, setCustomFontLabel] = useState<string>("");
  const [customFontFamily, setCustomFontFamily] = useState<string>("");
  const [, setCustomFontDataUrl] = useState<string>("");
  const [pageInput, setPageInput] = useState("");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [novelSettingsOpen, setNovelSettingsOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [scrollAnchorPage, setScrollAnchorPage] = useState(0);
  const [uiHidden, setUiHidden] = useState(false);
  const [resumeHintVisible, setResumeHintVisible] = useState(false);
  const customFontInputRef = useRef<HTMLInputElement | null>(null);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const novelScrollRef = useRef<HTMLElement | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const restoreProgressRef = useRef<number | null>(null);
  const paginateJobRef = useRef(0);
  const pagedTouchStartXRef = useRef<number | null>(null);

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
  const novelText = externalItem ? externalItem.text : textPreview;
  const textPages = useMemo(() => novelPages.map((p) => p.text), [novelPages]);
  const totalLineCount = useMemo(() => {
    if (!novelText) return 1;
    return novelText.split("\n").length;
  }, [novelText]);

  function externalProgressStorageKey(url: string): string {
    return `myclude:external-progress:${user?.id ?? "anon"}:${encodeURIComponent(url)}`;
  }

  function readExternalProgress(url: string): number {
    try {
      const raw = localStorage.getItem(externalProgressStorageKey(url));
      const n = Number(raw ?? "0");
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    } catch {
      return 0;
    }
  }

  function writeExternalProgress(url: string, progress: number): void {
    try {
      localStorage.setItem(externalProgressStorageKey(url), String(Math.max(0, Math.min(1, progress))));
    } catch {
      // ignore storage errors
    }
  }

  function lastViewedStorageKey(albumId: string): string {
    return `myclude:last-viewed:${user?.id ?? "anon"}:${albumId}`;
  }

  function readLastViewedImageId(albumId: string): string | null {
    try {
      return localStorage.getItem(lastViewedStorageKey(albumId));
    } catch {
      return null;
    }
  }

  function writeLastViewedImageId(albumId: string, imageId: string): void {
    try {
      localStorage.setItem(lastViewedStorageKey(albumId), imageId);
    } catch {
      // ignore storage errors
    }
  }

  useEffect(() => {
    if (!externalItem && !externalImageItem && (!activeItem || activeItem.itemType !== "text")) setNovelMode(false);
  }, [activeItem?.imageId, activeItem?.itemType, externalItem, externalImageItem]);

  useEffect(() => {
    if (!novelMode) {
      setNovelSettingsOpen(false);
      setUiHidden(false);
    }
  }, [novelMode]);

  useEffect(() => {
    if (!novelMode) setAutoAdvance(false);
  }, [novelMode]);

  useEffect(() => {
    if (readerMode !== "paged") setAutoAdvance(false);
  }, [readerMode]);

  useEffect(() => {
    if (uiHidden) setNovelSettingsOpen(false);
  }, [uiHidden]);

  useEffect(() => {
    const jobId = paginateJobRef.current + 1;
    paginateJobRef.current = jobId;
    setPaginationDone(false);
    setNovelPages([{ text: "", startLine: 0, endLine: 0 }]);

    const lines = novelText.replace(/\r\n/g, "\n").split("\n");
    const pageInnerWidth = 640;
    const pageInnerHeight = 800;
    const charsPerLine = Math.max(14, Math.floor(pageInnerWidth / (fontSize * 0.95)));
    const maxVisualLines = Math.max(8, Math.floor(pageInnerHeight / (fontSize * 1.65)));
    const pages: TextPage[] = [];
    let cursor = 0;
    let current = "";
    let currentVisualLines = 0;
    let pageStartLine = 0;
    let processedSincePublish = 0;

    function visualLineCount(text: string): number {
      if (!text) return 1;
      return Math.max(1, Math.ceil(text.length / charsPerLine));
    }

    function publish(force = false) {
      if (!force && processedSincePublish < 5000) return;
      processedSincePublish = 0;
      setNovelPages(pages.length > 0 ? [...pages] : [{ text: "", startLine: 0, endLine: 0 }]);
    }

    function finalize() {
      if (current.length > 0) {
        pages.push({
          text: current,
          startLine: pageStartLine,
          endLine: Math.max(pageStartLine, lines.length - 1)
        });
      }
      setNovelPages(pages.length > 0 ? pages : [{ text: "", startLine: 0, endLine: 0 }]);
      setPaginationDone(true);
    }

    function step() {
      if (paginateJobRef.current !== jobId) return;
      const chunkEnd = Math.min(lines.length, cursor + 1200);
      for (let i = cursor; i < chunkEnd; i++) {
        const line = lines[i];
        const lineVisualLines = visualLineCount(line);
        const nextVisualLines = currentVisualLines + lineVisualLines;
        if (nextVisualLines > maxVisualLines && current) {
          pages.push({
            text: current,
            startLine: pageStartLine,
            endLine: Math.max(pageStartLine, i - 1)
          });
          current = line;
          currentVisualLines = lineVisualLines;
          pageStartLine = i;
        } else {
          current = current ? `${current}\n${line}` : line;
          currentVisualLines = nextVisualLines;
        }
      }
      processedSincePublish += chunkEnd - cursor;
      cursor = chunkEnd;
      publish(false);
      if (cursor < lines.length) {
        window.setTimeout(step, 0);
        return;
      }
      finalize();
    }

    window.setTimeout(step, 0);
    return () => {
      paginateJobRef.current += 1;
    };
  }, [novelText, fontSize]);

  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) {
        window.clearTimeout(scrollSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setPageInput(String(textPage + 1));
  }, [textPage]);

  useEffect(() => {
    if (readerMode === "paged") {
      setScrollAnchorPage(textPage);
    }
  }, [readerMode, textPage]);

  useEffect(() => {
    if (!user) return;
    const key = `myclude:custom-font:${user.id}`;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { label?: string; family?: string; dataUrl?: string };
      if (!parsed.family || !parsed.dataUrl) return;
      const face = new FontFace(parsed.family, `url(${parsed.dataUrl})`, {
        style: "normal",
        weight: "400"
      });
      void face.load().then(() => {
        document.fonts.add(face);
        setCustomFontFamily(parsed.family || "");
        setCustomFontLabel(parsed.label || "업로드 폰트");
        setCustomFontDataUrl(parsed.dataUrl || "");
      });
    } catch {
      localStorage.removeItem(key);
    }
  }, [user?.id]);

  useEffect(() => {
    return () => {
      if (externalImageItem?.objectUrl) {
        URL.revokeObjectURL(externalImageItem.objectUrl);
      }
    };
  }, [externalImageItem?.objectUrl]);

  useEffect(() => {
    async function loadTextPreview() {
      if (externalItem) return;
      if (!activeItem || activeItem.itemType !== "text" || !activeItem.contentUrl) {
        setTextPreview("");
        setTextPage(0);
        setScrollProgress(0);
        pendingScrollRestoreRef.current = null;
        return;
      }
      try {
        const res = await fetch(activeItem.contentUrl);
        const text = await res.text();
        setTextPreview(text);
        const ratio = savedImageId === activeItem.imageId ? Math.max(0, Math.min(1, savedProgress || 0)) : 0;
        restoreProgressRef.current = ratio;
        setTextPage(0);
        setScrollProgress(ratio);
        setResumeHintVisible(ratio > 0);
        pendingScrollRestoreRef.current = ratio;
      } catch {
        setTextPreview("텍스트 미리보기를 불러오지 못했습니다.");
        setTextPage(0);
        setScrollProgress(0);
        setResumeHintVisible(false);
        pendingScrollRestoreRef.current = null;
      }
    }
    void loadTextPreview();
  }, [externalItem, activeItem?.imageId, activeItem?.itemType, activeItem?.contentUrl, savedImageId, savedProgress]);

  useEffect(() => {
    if (textPage >= novelPages.length) {
      setTextPage(Math.max(0, novelPages.length - 1));
    }
  }, [textPage, novelPages.length]);

  useEffect(() => {
    const progress = restoreProgressRef.current;
    if (progress == null) return;
    const bounded = Math.max(0, Math.min(1, progress));
    const page = novelPages.length > 1 ? Math.round(bounded * (novelPages.length - 1)) : 0;
    setTextPage(page);
    setScrollProgress(bounded);
    setScrollAnchorPage(page);
    pendingScrollRestoreRef.current = bounded;
    if (paginationDone) {
      restoreProgressRef.current = null;
    }
  }, [novelPages.length, paginationDone, externalItem?.sourceUrl, activeItem?.imageId]);

  useEffect(() => {
    if (readerMode !== "scroll") return;
    if (externalItem) {
      const restored = readExternalProgress(externalItem.sourceUrl);
      pendingScrollRestoreRef.current = restored;
      return;
    }
    const ratioFromPage = novelPages.length > 1 ? textPage / (novelPages.length - 1) : 0;
    pendingScrollRestoreRef.current = Math.max(0, Math.min(1, savedProgress || ratioFromPage));
  }, [readerMode, textPage, novelPages.length, savedProgress, externalItem]);

  useEffect(() => {
    if (!novelMode || readerMode !== "scroll") return;
    if (!novelScrollRef.current) return;
    const ratio = pendingScrollRestoreRef.current;
    if (ratio == null) return;
    const node = novelScrollRef.current;
    const raf = window.requestAnimationFrame(() => {
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = max * ratio;
      setScrollProgress(ratio);
      pendingScrollRestoreRef.current = null;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [novelMode, readerMode, novelPages.length, fontSize, fontFamily]);

  useEffect(() => {
    if (!novelMode || readerMode !== "paged" || !autoAdvance) return;
    const timer = window.setInterval(() => {
      setTextPage((prev) => {
        const maxPage = Math.max(0, novelPages.length - 1);
        const next = Math.min(maxPage, prev + 1);
        if (next === prev) {
          setAutoAdvance(false);
          return prev;
        }
        void saveTextProgress(novelPages.length > 1 ? next / (novelPages.length - 1) : 1);
        return next;
      });
    }, 2600);
    return () => window.clearInterval(timer);
  }, [novelMode, readerMode, autoAdvance, novelPages.length]);

  async function loadMe() {
    setAuthLoading(true);
    try {
      const data = await api<{ user: User }>("/api/auth/me", { method: "GET" });
      setUser(data.user);
      setStatus(`로그인됨: ${data.user.username}`);
      try {
        const settings = await api<{ item: ViewerSettings | null }>("/api/users/settings", { method: "GET" });
        if (settings.item) {
          if (settings.item.novelTheme === "light" || settings.item.novelTheme === "dark") {
            setNovelTheme(settings.item.novelTheme);
          }
          if (typeof settings.item.novelFontSize === "number") {
            setFontSize(Math.max(14, Math.min(34, settings.item.novelFontSize)));
          }
          if (settings.item.novelFontFamily) {
            setFontFamily(settings.item.novelFontFamily);
          }
          if (settings.item.novelViewMode === "paged" || settings.item.novelViewMode === "scroll") {
            setReaderMode(settings.item.novelViewMode);
          }
        }
      } catch {
        // 설정 API 오류가 있어도 로그인 상태는 유지한다.
      }
      setSettingsHydrated(true);
    } catch {
      setUser(null);
      setStatus("로그인되지 않음");
      setSettingsHydrated(false);
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
    const [itemData, progressData, linkData] = await Promise.all([
      api<{ items: AlbumItem[] }>(`/api/albums/${albumId}/items`, { method: "GET" }),
      api<{ item: { image_id: string; progress: number } | null }>(`/api/albums/${albumId}/progress`, { method: "GET" }),
      api<{ items: SavedExternalLink[] }>(`/api/albums/${albumId}/external-links`, { method: "GET" })
    ]);
    setItems(itemData.items);
    setExternalLinks(linkData.items || []);
    setSelectedImages([]);
    const imageId = progressData.item?.image_id ?? null;
    const progress = progressData.item?.progress ?? 0;
    setSavedImageId(imageId);
    setSavedProgress(progress);

    const lastViewedId = readLastViewedImageId(albumId);
    if (lastViewedId) {
      const idx = itemData.items.findIndex((x) => x.imageId === lastViewedId);
      if (idx >= 0) {
        setActiveIndex(idx);
        return;
      }
    }
    if (imageId) {
      const idx = itemData.items.findIndex((x) => x.imageId === imageId);
      setActiveIndex(idx >= 0 ? idx : 0);
      return;
    }
    setActiveIndex(0);
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
    if (!user || !settingsHydrated) return;
    const timer = setTimeout(() => {
      void api("/api/users/settings", {
        method: "POST",
        body: JSON.stringify({
          novelFontFamily: fontFamily,
          novelTheme,
          novelFontSize: fontSize,
          novelViewMode: readerMode
        })
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [user, settingsHydrated, fontFamily, novelTheme, fontSize, readerMode]);

  useEffect(() => {
    if (selectedAlbum) setRenameTitle(selectedAlbum.title);
  }, [selectedAlbum?.id]);

  useEffect(() => {
    if (activeIndex >= filteredItems.length) setActiveIndex(0);
  }, [filteredItems.length, activeIndex]);

  useEffect(() => {
    if (!selectedAlbumId || !activeItem) return;
    writeLastViewedImageId(selectedAlbumId, activeItem.imageId);
  }, [selectedAlbumId, activeItem?.imageId]);

  async function register() {
    try {
      setBusy(true);
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setStatus("회원가입 완료. 로그인해 주세요.");
    } catch (err) {
      setStatus(`회원가입 실패: ${toErrorMessage(err)}`);
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
      setStatus(`로그인됨: ${data.user.username}`);
      await loadAlbums();
    } catch (err) {
      setStatus(`로그인 실패: ${toErrorMessage(err)}`);
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
      setExternalItem(null);
      if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
      setExternalImageItem(null);
      setNovelMode(false);
      setStatus("로그아웃됨");
    } catch (err) {
      setStatus(`로그아웃 실패: ${toErrorMessage(err)}`);
    }
  }

  useEffect(() => {
    if (externalImageItem?.objectUrl) {
      URL.revokeObjectURL(externalImageItem.objectUrl);
    }
    setExternalItem(null);
    setExternalImageItem(null);
    setNovelMode(false);
    setResumeHintVisible(false);
    setExternalUrl("");
    setExternalTitle("");
  }, [selectedAlbumId]);

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
      setStatus("폴더가 생성되었습니다.");
    } catch (err) {
      setStatus(`폴더 생성 실패: ${toErrorMessage(err)}`);
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
      setStatus("폴더 이름이 변경되었습니다.");
    } catch (err) {
      setStatus(`이름 변경 실패: ${toErrorMessage(err)}`);
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
      setStatus("폴더가 삭제되었습니다.");
    } catch (err) {
      setStatus(`삭제 실패: ${toErrorMessage(err)}`);
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
      setStatus(`${selectedImages.length}개 파일이 삭제되었습니다.`);
    } catch (err) {
      setStatus(`파일 삭제 실패: ${toErrorMessage(err)}`);
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
      setStatus(`${files.length}개 파일 업로드 중...`);
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
      setStatus("업로드가 완료되었습니다.");
    } catch (err) {
      setStatus(`업로드 실패: ${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function jumpToResume() {
    if (!savedImageId) return;
    const idx = filteredItems.findIndex((x) => x.imageId === savedImageId);
    if (idx >= 0) setActiveIndex(idx);
  }

  async function saveTextProgress(progressRaw: number) {
    if (externalItem) return;
    if (!selectedAlbumId || !activeItem || activeItem.itemType !== "text") return;
    const progress = Math.max(0, Math.min(1, progressRaw));
    await api(`/api/albums/${selectedAlbumId}/progress`, {
      method: "POST",
      body: JSON.stringify({ imageId: activeItem.imageId, progress })
    });
    setSavedImageId(activeItem.imageId);
    setSavedProgress(progress);
  }

  async function setTextPageAndSave(nextPage: number) {
    const bounded = Math.max(0, Math.min(novelPages.length - 1, nextPage));
    setTextPage(bounded);
    setScrollAnchorPage(bounded);
    setResumeHintVisible(false);
    const progress = novelPages.length > 1 ? bounded / (novelPages.length - 1) : 1;
    if (externalItem) {
      writeExternalProgress(externalItem.sourceUrl, progress);
      setScrollProgress(progress);
    }
    await saveTextProgress(progress);
  }

  async function moveTextPage(delta: number) {
    const next = textPage + delta;
    if (next === textPage) return;
    await setTextPageAndSave(next);
  }

  function queueScrollProgressSave(progress: number) {
    if (externalItem) {
      writeExternalProgress(externalItem.sourceUrl, progress);
      return;
    }
    if (scrollSaveTimerRef.current) {
      window.clearTimeout(scrollSaveTimerRef.current);
    }
    scrollSaveTimerRef.current = window.setTimeout(() => {
      void saveTextProgress(progress);
    }, 220);
  }

  function onNovelScroll() {
    const node = novelScrollRef.current;
    if (!node) return;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const progress = max > 0 ? node.scrollTop / max : 1;
    const page = novelPages.length > 1 ? Math.round(progress * (novelPages.length - 1)) : 0;
    setScrollAnchorPage(page);
    setTextPage(page);
    setScrollProgress(progress);
    setResumeHintVisible(false);
    queueScrollProgressSave(progress);
  }

  function setScrollBySlider(raw: number, save: boolean) {
    const node = novelScrollRef.current;
    if (!node) return;
    const progress = Math.max(0, Math.min(1, raw));
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = max * progress;
    const page = novelPages.length > 1 ? Math.round(progress * (novelPages.length - 1)) : 0;
    setScrollAnchorPage(page);
    setTextPage(page);
    setScrollProgress(progress);
    setResumeHintVisible(false);
    if (save) queueScrollProgressSave(progress);
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
      const family = user ? `UserFont_${user.id}` : `UserFont_${Date.now()}`;
      const dataUrl = await readFileAsDataUrl(file);
      const face = new FontFace(family, `url(${dataUrl}) format('${format}')`, { style: "normal", weight: "400" });
      await face.load();
      document.fonts.add(face);
      setFontFamily(family);
      setCustomFontFamily(family);
      setCustomFontLabel(file.name);
      setCustomFontDataUrl(dataUrl);
      if (user) {
        localStorage.setItem(
          `myclude:custom-font:${user.id}`,
          JSON.stringify({ label: file.name, family, dataUrl })
        );
      }
      setStatus(`폰트 적용됨: ${file.name}`);
    } catch {
      setStatus("폰트 업로드 실패");
    }
  }

  if (!apiBase) return <div className="app">VITE_API_BASE 값이 필요합니다.</div>;

  function goHome() {
    setAlbumQuery("");
    setItemQuery("");
    setSortBy("new");
    setSelectedImages([]);
    setActiveIndex(0);
    setExternalItem(null);
    if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
    setExternalImageItem(null);
    setNovelMode(false);
    if (!selectedAlbumId && albums.length > 0) {
      setSelectedAlbumId(albums[0].id);
    }
    setStatus(user ? `로그인됨: ${user.username}` : "MyClude Drive");
  }

  function openJumpPanel() {
    setUiHidden(false);
    setNovelSettingsOpen(true);
    if (readerMode === "paged") {
      window.setTimeout(() => jumpInputRef.current?.focus(), 60);
    }
  }

  async function copyCurrentShareLink() {
    try {
      if (externalItem) {
        await navigator.clipboard.writeText(externalItem.sourceUrl);
        setStatus("외부 링크를 복사했습니다.");
        return;
      }
      if (externalImageItem) {
        await navigator.clipboard.writeText(externalImageItem.sourceUrl);
        setStatus("외부 이미지 링크를 복사했습니다.");
        return;
      }
      if (!selectedAlbumId || !activeItem) return;
      let link = "";
      if (activeItem.itemType === "image") {
        const signed = await api<{ thumbGetUrl: string; previewGetUrl: string }>(
          `/api/albums/${selectedAlbumId}/images/${activeItem.imageId}/presign-get`,
          { method: "GET" }
        );
        link = signed.previewGetUrl;
      } else {
        link = activeItem.contentUrl || "";
      }
      if (!link) throw new Error("공유 링크를 찾을 수 없습니다.");
      await navigator.clipboard.writeText(link);
      setStatus("공유 링크를 복사했습니다.");
    } catch (err) {
      setStatus(`링크 복사 실패: ${toErrorMessage(err)}`);
    }
  }

  function triggerBlobDownload(blob: Blob, filename: string) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 800);
  }

  async function downloadCurrent() {
    try {
      if (externalItem) {
        triggerBlobDownload(new Blob([externalItem.text], { type: "text/plain;charset=utf-8" }), `${externalItem.title || "external"}.txt`);
        setStatus("외부 텍스트를 다운로드했습니다.");
        return;
      }
      if (externalImageItem) {
        const res = await fetch(`${apiBase}/api/external-text/stream?url=${encodeURIComponent(externalImageItem.sourceUrl)}`, {
          method: "GET",
          credentials: "include"
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const ext = blob.type.includes("png") ? "png" : blob.type.includes("jpeg") ? "jpg" : "webp";
        triggerBlobDownload(blob, `${externalImageItem.title || "external-image"}.${ext}`);
        setStatus("외부 이미지를 다운로드했습니다.");
        return;
      }
      if (!activeItem) return;
      const sourceUrl = activeItem.itemType === "image" ? activeItem.previewUrl : activeItem.contentUrl;
      if (!sourceUrl) throw new Error("다운로드 URL을 찾지 못했습니다.");
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const defaultName = activeItem.itemType === "image" ? `${activeItem.imageId}.webp` : `${activeItem.imageId}.txt`;
      triggerBlobDownload(blob, activeItem.originalName || defaultName);
      setStatus("파일 다운로드가 완료되었습니다.");
    } catch (err) {
      setStatus(`다운로드 실패: ${toErrorMessage(err)}`);
    }
  }

  async function openExternalTextViewer() {
    const url = externalUrl.trim();
    if (!url) return;
    try {
      setExternalLoading(true);
      if (selectedAlbumId) {
        const exists = externalLinks.some((x) => x.sourceUrl === url);
        if (!exists) {
          const saved = await api<{ item: SavedExternalLink }>(`/api/albums/${selectedAlbumId}/external-links`, {
            method: "POST",
            body: JSON.stringify({ url, title: externalTitle.trim() || undefined })
          });
          setExternalLinks((prev) => [saved.item, ...prev]);
        }
      }
      const streamRes = await fetch(`${apiBase}/api/external-text/stream?url=${encodeURIComponent(url)}`, {
        method: "GET",
        credentials: "include"
      });
      if (!streamRes.ok) {
        const errText = await streamRes.text();
        throw new Error(errText || `HTTP ${streamRes.status}`);
      }
      if (!streamRes.body) throw new Error("스트림 본문이 없습니다.");
      const title = streamRes.headers.get("x-external-title") || externalTitle.trim() || "외부 텍스트";
      const headerKind = (streamRes.headers.get("x-external-kind") || "").toLowerCase();
      const contentType = (streamRes.headers.get("content-type") || "").toLowerCase();
      if (headerKind === "image" || contentType.startsWith("image/")) {
        const blob = await streamRes.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
        setExternalImageItem({
          sourceUrl: url,
          title,
          contentType: contentType || "image/*",
          objectUrl
        });
        setExternalItem(null);
        setNovelMode(false);
        setStatus(`외부 이미지 열기 완료: ${title}`);
        return;
      }
      const totalBytes = Number(streamRes.headers.get("content-length") || "0");
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let loaded = 0;
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        loaded += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (totalBytes > 0) {
          const p = Math.floor((loaded / totalBytes) * 100);
          setStatus(`외부 텍스트 불러오는 중... ${Math.min(100, p)}%`);
        } else {
          setStatus(`외부 텍스트 불러오는 중... ${Math.floor(loaded / 1024)}KB`);
        }
      }
      text += decoder.decode();
      if (!text.trim()) throw new Error("텍스트를 찾을 수 없습니다.");
      const restoredProgress = readExternalProgress(url);
      restoreProgressRef.current = restoredProgress;
      setResumeHintVisible(restoredProgress > 0);
      setExternalItem({
        sourceUrl: url,
        title,
        contentType: contentType || "text/plain",
        text
      });
      if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
      setExternalImageItem(null);
      setTextPage(0);
      setScrollProgress(0);
      pendingScrollRestoreRef.current = 0;
      setNovelMode(true);
      setStatus(`외부 링크 열기 완료: ${title}`);
    } catch (err) {
      setStatus(`외부 링크 열기 실패: ${toErrorMessage(err)}`);
    } finally {
      setExternalLoading(false);
    }
  }

  async function saveExternalLink() {
    if (!selectedAlbumId) return;
    const url = externalUrl.trim();
    if (!url) return;
    try {
      setExternalLoading(true);
      const data = await api<{ item: SavedExternalLink }>(`/api/albums/${selectedAlbumId}/external-links`, {
        method: "POST",
        body: JSON.stringify({ url, title: externalTitle.trim() || undefined })
      });
      setExternalLinks((prev) => [data.item, ...prev]);
      setStatus("링크가 현재 폴더에 저장되었습니다.");
    } catch (err) {
      setStatus(`링크 저장 실패: ${toErrorMessage(err)}`);
    } finally {
      setExternalLoading(false);
    }
  }

  async function openSavedExternalLink(link: SavedExternalLink) {
    setExternalUrl(link.sourceUrl);
    setExternalTitle(link.title);
    try {
      setExternalLoading(true);
      const streamRes = await fetch(`${apiBase}/api/external-text/stream?url=${encodeURIComponent(link.sourceUrl)}`, {
        method: "GET",
        credentials: "include"
      });
      if (!streamRes.ok) {
        const errText = await streamRes.text();
        throw new Error(errText || `HTTP ${streamRes.status}`);
      }
      if (!streamRes.body) throw new Error("스트림 본문이 없습니다.");
      const title = streamRes.headers.get("x-external-title") || link.title || "외부 텍스트";
      const headerKind = (streamRes.headers.get("x-external-kind") || "").toLowerCase();
      const contentType = (streamRes.headers.get("content-type") || "").toLowerCase();
      if (headerKind === "image" || contentType.startsWith("image/")) {
        const blob = await streamRes.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
        setExternalImageItem({
          sourceUrl: link.sourceUrl,
          title,
          contentType: contentType || "image/*",
          objectUrl
        });
        setExternalItem(null);
        setNovelMode(false);
        setStatus(`저장 이미지 열기 완료: ${title}`);
        return;
      }
      const totalBytes = Number(streamRes.headers.get("content-length") || "0");
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let loaded = 0;
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        loaded += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (totalBytes > 0) {
          const p = Math.floor((loaded / totalBytes) * 100);
          setStatus(`저장 링크 불러오는 중... ${Math.min(100, p)}%`);
        } else {
          setStatus(`저장 링크 불러오는 중... ${Math.floor(loaded / 1024)}KB`);
        }
      }
      text += decoder.decode();
      if (!text.trim()) throw new Error("텍스트를 찾을 수 없습니다.");
      const restoredProgress = readExternalProgress(link.sourceUrl);
      restoreProgressRef.current = restoredProgress;
      setResumeHintVisible(restoredProgress > 0);
      setExternalItem({
        sourceUrl: link.sourceUrl,
        title,
        contentType: contentType || "text/plain",
        text
      });
      if (externalImageItem?.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
      setExternalImageItem(null);
      setTextPage(0);
      setScrollProgress(0);
      pendingScrollRestoreRef.current = 0;
      setNovelMode(true);
      setStatus(`저장 링크 열기 완료: ${title}`);
    } catch (err) {
      setStatus(`저장 링크 열기 실패: ${toErrorMessage(err)}`);
    } finally {
      setExternalLoading(false);
    }
  }

  async function deleteSavedExternalLink(linkId: string) {
    if (!selectedAlbumId) return;
    try {
      await api(`/api/albums/${selectedAlbumId}/external-links/${linkId}`, { method: "DELETE" });
      setExternalLinks((prev) => prev.filter((x) => x.id !== linkId));
      setStatus("링크가 삭제되었습니다.");
    } catch (err) {
      setStatus(`링크 삭제 실패: ${toErrorMessage(err)}`);
    }
  }

  function handleNovelStageTap(e: React.MouseEvent) {
    if (readerMode === "paged") return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button,input,select,label,a")) return;
    setUiHidden((prev) => !prev);
  }

  function onPagedTap(direction: "prev" | "next") {
    if (direction === "prev") {
      void setTextPageAndSave(textPage - 1);
      return;
    }
    void setTextPageAndSave(textPage + 1);
  }

  function handlePagedTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    pagedTouchStartXRef.current = e.touches[0].clientX;
  }

  function handlePagedTouchEnd(e: React.TouchEvent) {
    const startX = pagedTouchStartXRef.current;
    if (startX == null || e.changedTouches.length === 0) return;
    const deltaX = e.changedTouches[0].clientX - startX;
    if (Math.abs(deltaX) < 44) return;
    if (deltaX < 0) {
      onPagedTap("next");
    } else {
      onPagedTap("prev");
    }
    pagedTouchStartXRef.current = null;
  }

  const totalPages = Math.max(1, novelPages.length);
  const estimatedScrollPageHeight = Math.max(360, (novelScrollRef.current?.clientHeight ?? 760) - 18);
  const virtualGap = readerMode === "scroll" ? 0 : 12;
  const virtualExtent = estimatedScrollPageHeight + virtualGap;
  const virtualStart = Math.max(0, scrollAnchorPage - 12);
  const virtualEnd = Math.min(totalPages - 1, scrollAnchorPage + 12);
  const topSpacerHeight = virtualStart * virtualExtent;
  const bottomSpacerHeight = Math.max(0, (totalPages - 1 - virtualEnd) * virtualExtent);
  const progressForLine = readerMode === "paged"
    ? (totalPages > 1 ? textPage / (totalPages - 1) : 0)
    : scrollProgress;
  const currentLine = Math.max(1, Math.min(totalLineCount, Math.round(progressForLine * Math.max(0, totalLineCount - 1)) + 1));
  const resumeLine = Math.max(1, Math.min(totalLineCount, Math.round((restoreProgressRef.current ?? progressForLine) * Math.max(0, totalLineCount - 1)) + 1));
  const currentPageMeta = novelPages[textPage];
  const showPagedResumeHint =
    resumeHintVisible &&
    readerMode === "paged" &&
    !!currentPageMeta &&
    resumeLine >= currentPageMeta.startLine + 1 &&
    resumeLine <= currentPageMeta.endLine + 1;
  const pagedHintTopPercent = currentPageMeta
    ? Math.max(8, Math.min(90, (((resumeLine - 1) - currentPageMeta.startLine) / Math.max(1, currentPageMeta.endLine - currentPageMeta.startLine + 1)) * 100))
    : 50;
  const viewerOpen = !!externalImageItem || (novelMode && (externalItem || activeItem?.itemType === "text"));

  return (
    <div className={`app ${viewerOpen ? "viewer-mode" : ""}`}>
      {!viewerOpen && (
        <>
          <header className="topbar">
            <button className="logo-btn" onClick={goHome}>
              MyClude Drive
            </button>
            <span className="status">{status}</span>
          </header>

          {authLoading && <section className="panel">인증 상태를 불러오는 중...</section>}

          {!authLoading && !user && (
        <section className="panel auth-panel">
          <h2>로그인</h2>
          <p>로그인 성공 시 상단 상태에 계정명이 표시됩니다.</p>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="아이디" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호 (8자 이상)"
          />
          <div className="row">
            <button disabled={busy} onClick={() => void register()}>
              회원가입
            </button>
            <button disabled={busy} onClick={() => void login()}>
              로그인
            </button>
            <button disabled={busy} onClick={loginWithGoogle}>
              구글로 계속하기
            </button>
          </div>
        </section>
          )}

          {user && (
        <main className="drive">
          <aside className="panel sidebar">
            <div className="row spread">
              <strong>{user.username}</strong>
              <button onClick={() => void logout()}>로그아웃</button>
            </div>

            <h3>폴더</h3>
            <input value={albumQuery} onChange={(e) => setAlbumQuery(e.target.value)} placeholder="폴더 검색" />
            <input
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              placeholder="새 폴더 이름"
            />
            <input
              value={newAlbumDescription}
              onChange={(e) => setNewAlbumDescription(e.target.value)}
              placeholder="설명"
            />
            <button disabled={busy} onClick={() => void createAlbum()}>
              폴더 만들기
            </button>

            <ul className="album-list">
              {filteredAlbums.map((a) => (
                <li key={a.id} className={a.id === selectedAlbumId ? "selected" : ""}>
                  <button onClick={() => setSelectedAlbumId(a.id)}>{a.title}</button>
                  <button className="danger" onClick={() => void deleteAlbum(a.id)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="panel content">
            {!selectedAlbum && <p>폴더를 선택하거나 새로 만들어 시작하세요.</p>}

            {selectedAlbum && (
              <>
                <div className="row spread">
                  <h2>{selectedAlbum.title}</h2>
                  <span>{filteredItems.length}개 파일</span>
                </div>

                <div className="row rename-row">
                  <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} placeholder="폴더 이름 변경" />
                  <button onClick={() => void renameAlbum()}>이름 변경</button>
                </div>

                <div className="toolbar">
                  <input value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} placeholder="파일 ID 검색" />
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "new" | "old" | "name")}>
                    <option value="new">최신순</option>
                    <option value="old">오래된순</option>
                    <option value="name">이름순</option>
                  </select>
                  <button disabled={selectedImages.length === 0 || busy} onClick={() => void deleteSelectedItems()}>
                    선택 삭제 ({selectedImages.length})
                  </button>
                </div>

                <div className="upload-box">
                  <input type="file" multiple accept="image/*,text/*,.txt,.md,.json,.csv,.log" onChange={(e) => void uploadFiles(e.target.files)} />
                  <div className="row">
                    <input
                      value={externalUrl}
                      onChange={(e) => setExternalUrl(e.target.value)}
                      placeholder="외부 텍스트 링크 붙여넣기 (http/https)"
                    />
                    <input
                      value={externalTitle}
                      onChange={(e) => setExternalTitle(e.target.value)}
                      placeholder="링크 제목(선택)"
                    />
                    <button disabled={externalLoading || !selectedAlbumId} onClick={() => void saveExternalLink()}>
                      링크 저장
                    </button>
                    <button disabled={externalLoading} onClick={() => void openExternalTextViewer()}>
                      {externalLoading ? "불러오는 중..." : "링크로 뷰어 열기"}
                    </button>
                    {(externalItem || externalImageItem) && (
                      <button
                        className="danger"
                        onClick={() => {
                          setExternalItem(null);
                          setExternalImageItem((prev) => {
                            if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
                            return null;
                          });
                          setResumeHintVisible(false);
                          setStatus("외부 링크 모드를 종료했습니다.");
                        }}
                      >
                        링크 모드 종료
                      </button>
                    )}
                  </div>
                  {externalLinks.length > 0 && (
                    <ul className="album-list">
                      {externalLinks.map((link) => (
                        <li key={link.id}>
                          <button onClick={() => void openSavedExternalLink(link)}>
                            {link.title}
                          </button>
                          <button className="danger" onClick={() => void deleteSavedExternalLink(link.id)}>
                            삭제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="row">
                    <button onClick={jumpToResume} disabled={!savedImageId}>
                      이어보기
                    </button>
                    <span>{savedImageId ? `저장됨 ${Math.round(savedProgress * 100)}%` : "이어보기 데이터 없음"}</span>
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
                        <pre className="text-viewer">{textPages[textPage] || "텍스트 내용이 없습니다."}</pre>
                        <div className="row text-pager">
                          <button onClick={() => setNovelMode(true)}>소설 뷰어 열기</button>
                          <button onClick={() => void copyCurrentShareLink()}>링크 공유</button>
                          <button onClick={() => void downloadCurrent()}>다운로드</button>
                          <button
                            disabled={textPage === 0}
                            onClick={() => void moveTextPage(-1)}
                          >
                            이전 페이지
                          </button>
                          <span>
                            페이지 {textPage + 1} / {textPages.length}
                          </span>
                          <button
                            disabled={textPage >= textPages.length - 1}
                            onClick={() => void moveTextPage(1)}
                          >
                            다음 페이지
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="row">
                      <button onClick={() => void copyCurrentShareLink()}>링크 공유</button>
                      <button onClick={() => void downloadCurrent()}>다운로드</button>
                      <button
                        disabled={activeIndex === 0}
                        onClick={() => {
                          const next = Math.max(0, activeIndex - 1);
                          setActiveIndex(next);
                          void saveProgress(filteredItems[next].imageId, next);
                        }}
                      >
                        이전
                      </button>
                      <button
                        disabled={activeIndex === filteredItems.length - 1}
                        onClick={() => {
                          const next = Math.min(filteredItems.length - 1, activeIndex + 1);
                          setActiveIndex(next);
                          void saveProgress(filteredItems[next].imageId, next);
                        }}
                      >
                        다음
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
          )}
        </>
      )}

      {externalImageItem && (
        <div className={`novel-overlay image-only ${novelTheme === "dark" ? "theme-dark" : "theme-light"}`}>
          <header className="novel-mobile-top">
            <div className="novel-mobile-title">
              <span>{`[외부 이미지] ${externalImageItem.title}`}</span>
            </div>
            <button
              className="novel-close-btn"
              onClick={() => {
                if (externalImageItem.objectUrl) URL.revokeObjectURL(externalImageItem.objectUrl);
                setExternalImageItem(null);
              }}
              aria-label="뷰어 닫기"
            >
              ×
            </button>
          </header>
          <div className="novel-stage">
            <article className="novel-page external-image-stage">
              <img className="external-image-preview" src={externalImageItem.objectUrl} alt={externalImageItem.title} />
            </article>
          </div>
        </div>
      )}

      {novelMode && (externalItem || activeItem?.itemType === "text") && (
        <div className={`novel-overlay ${novelTheme === "dark" ? "theme-dark" : "theme-light"} ${uiHidden ? "ui-hidden" : ""} ${readerMode === "paged" ? "mode-paged" : "mode-scroll"}`}>
          <header className="novel-mobile-top">
            <div className="novel-mobile-title">
              <span>{externalItem ? `[외부] ${externalItem.title}` : (activeItem?.originalName || activeItem?.imageId || "텍스트")}</span>
              <strong>
                {readerMode === "paged"
                  ? `${textPage + 1}/${Math.max(1, novelPages.length)}p${paginationDone ? "" : "+"}`
                  : `${Math.round(scrollProgress * 100)}% · L${currentLine}`}
              </strong>
            </div>
            <button className="novel-close-btn" onClick={() => { setNovelMode(false); setResumeHintVisible(false); }} aria-label="뷰어 닫기">
              ×
            </button>
          </header>
          <div className="novel-stage" onClick={handleNovelStageTap}>
            {readerMode === "paged" ? (
              <article className="novel-page novel-paged-page" onTouchStart={handlePagedTouchStart} onTouchEnd={handlePagedTouchEnd}>
                <pre style={{ fontSize: `${fontSize}px`, fontFamily }}>{novelPages[textPage]?.text || ""}</pre>
                <button className="novel-tap-zone left" aria-label="이전 페이지" onClick={() => onPagedTap("prev")} />
                <button className="novel-tap-zone right" aria-label="다음 페이지" onClick={() => onPagedTap("next")} />
                {showPagedResumeHint && (
                  <div className="novel-resume-hint-band" style={{ top: `${pagedHintTopPercent}%` }} />
                )}
              </article>
            ) : (
              <article
                className="novel-page novel-scroll-page"
                ref={(node) => {
                  novelScrollRef.current = node;
                }}
                onScroll={onNovelScroll}
              >
                <div className="novel-virtual-spacer" style={{ height: `${topSpacerHeight}px` }} />
                {novelPages.slice(virtualStart, virtualEnd + 1).map((page, idx) => (
                  <section
                    key={`${virtualStart + idx}-${page.startLine}`}
                    className="novel-virtual-page"
                    style={{ minHeight: `${estimatedScrollPageHeight}px` }}
                  >
                    <pre style={{ fontSize: `${fontSize}px`, fontFamily }}>{page.text || ""}</pre>
                    {resumeHintVisible && resumeLine >= page.startLine + 1 && resumeLine <= page.endLine + 1 && (
                      <div
                        className="novel-resume-hint-band"
                        style={{
                          top: `${Math.max(8, Math.min(90, (((resumeLine - 1) - page.startLine) / Math.max(1, page.endLine - page.startLine + 1)) * 100))}%`
                        }}
                      />
                    )}
                  </section>
                ))}
                <div className="novel-virtual-spacer" style={{ height: `${bottomSpacerHeight}px` }} />
              </article>
            )}
          </div>
          {uiHidden && (
            <button className="novel-ui-reveal" onClick={() => setUiHidden(false)}>
              메뉴
            </button>
          )}
          {novelSettingsOpen && (
            <section className="novel-settings-sheet">
              <div className="novel-settings-grid">
                <label>
                  읽기 모드
                  <select value={readerMode} onChange={(e) => setReaderMode(e.target.value as "paged" | "scroll")}>
                    <option value="paged">페이지</option>
                    <option value="scroll">스크롤</option>
                  </select>
                </label>
                <label>
                  테마
                  <button onClick={() => setNovelTheme((t) => (t === "light" ? "dark" : "light"))}>
                    {novelTheme === "light" ? "다크 모드" : "라이트 모드"}
                  </button>
                </label>
                <label>
                  글자 크기 ({fontSize}px)
                  <input
                    type="range"
                    min={14}
                    max={34}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                </label>
                <label>
                  글꼴
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
                    {customFontFamily && <option value={customFontFamily}>사용자: {customFontLabel}</option>}
                    <option value="__upload__">기타 폰트 추가</option>
                  </select>
                </label>
                <label>
                  페이지 이동
                  <div className="novel-jump-row">
                    <input
                      ref={jumpInputRef}
                      className="page-input"
                      disabled={readerMode !== "paged"}
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
                    <span>/ {Math.max(1, novelPages.length)}</span>
                    <button
                      disabled={readerMode !== "paged"}
                      onClick={() => {
                        const n = Number(pageInput || "1");
                        void setTextPageAndSave(n - 1);
                      }}
                    >
                      이동
                    </button>
                  </div>
                </label>
              </div>
              <input
                ref={customFontInputRef}
                type="file"
                accept=".otf,.ttf,.woff,.woff2"
                style={{ display: "none" }}
                onChange={(e) => void uploadCustomFont(e.target.files?.[0] ?? null)}
              />
            </section>
          )}
          <footer className="novel-mobile-bottom">
            <input
              className="page-slider"
              type="range"
              min={readerMode === "paged" ? 1 : 0}
              max={readerMode === "paged" ? Math.max(1, novelPages.length) : 1000}
              value={readerMode === "paged" ? Math.min(novelPages.length, textPage + 1) : Math.round(scrollProgress * 1000)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (readerMode === "paged") {
                  setTextPage(n - 1);
                  setPageInput(String(n));
                  setResumeHintVisible(false);
                } else {
                  setScrollBySlider(n / 1000, false);
                }
              }}
              onMouseUp={(e) => {
                const n = Number((e.target as HTMLInputElement).value || "1");
                if (readerMode === "paged") {
                  void setTextPageAndSave(n - 1);
                } else {
                  setScrollBySlider(n / 1000, true);
                }
              }}
              onTouchEnd={(e) => {
                const n = Number((e.target as HTMLInputElement).value || "1");
                if (readerMode === "paged") {
                  void setTextPageAndSave(n - 1);
                } else {
                  setScrollBySlider(n / 1000, true);
                }
              }}
            />
            <div className="novel-mobile-actions">
              <button onClick={openJumpPanel}>페이지 이동</button>
              <button disabled={readerMode !== "paged"} onClick={() => setAutoAdvance((v) => !v)}>
                {autoAdvance ? "자동 넘김 끄기" : "자동 넘김"}
              </button>
              <button onClick={() => void copyCurrentShareLink()}>공유</button>
              <button onClick={() => void downloadCurrent()}>다운로드</button>
              <button onClick={() => setNovelSettingsOpen((v) => !v)}>{novelSettingsOpen ? "설정 닫기" : "설정"}</button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}
