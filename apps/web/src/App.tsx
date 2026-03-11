import { useEffect, useMemo, useRef, useState } from "react";
import { readTextFileAuto } from "./readTextFile";

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
  novelHighlight: boolean | null;
};

type TextFullResponse = {
  text: string;
  totalBytes: number;
};

type TextChunkResponse = {
  text: string;
  nextOffset: number;
  totalBytes: number;
  done: boolean;
};

type TextIndexResponse = {
  item: { index: number } | null;
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

type GlobalSearchAlbum = {
  albumId: string;
  title: string;
  description: string;
};

type GlobalSearchItem = {
  albumId: string;
  albumTitle: string;
  imageId: string;
  itemType: "image" | "text";
  originalName: string;
  createdAt: string;
};

type RecentTextEntry = {
  albumId: string;
  imageId: string;
  title: string;
  viewedAt: string;
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

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const TEXT_WINDOW_BYTES = 256 * 1024;
  const TEXT_RECENTER_STEP = 0.16;
  const TEXT_META_BYTES = 1024;
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [status, setStatus] = useState("세션 확인 중...");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [albums, setAlbums] = useState<Album[]>([]);
  const [hasUnsyncedData, setHasUnsyncedData] = useState(false);
  const [albumQuery, setAlbumQuery] = useState("");
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchAlbums, setGlobalSearchAlbums] = useState<GlobalSearchAlbum[]>([]);
  const [globalSearchItems, setGlobalSearchItems] = useState<GlobalSearchItem[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [recentText, setRecentText] = useState<RecentTextEntry | null>(null);

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
  const [textLoading, setTextLoading] = useState(false);
  const [textIndex, setTextIndex] = useState(0);
  const [externalUrl, setExternalUrl] = useState("");
  const [externalTitle, setExternalTitle] = useState("");
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [showLinkComposer, setShowLinkComposer] = useState(false);
  const [externalItem, setExternalItem] = useState<ExternalTextItem | null>(null);
  const [externalImageItem, setExternalImageItem] = useState<ExternalImageItem | null>(null);
  const [externalLinks, setExternalLinks] = useState<SavedExternalLink[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [publicShareLoading, setPublicShareLoading] = useState(false);
  const [textPage, setTextPage] = useState(0);
  const [novelPages, setNovelPages] = useState<TextPage[]>([{ text: "", startLine: 0, endLine: 0 }]);
  const [paginationDone, setPaginationDone] = useState(true);
  const [novelMode, setNovelMode] = useState(false);
  const [novelTheme, setNovelTheme] = useState<"light" | "dark">(() => {
    try { return (localStorage.getItem("myclude:novelTheme") as "light" | "dark") || "light"; } catch { return "light"; }
  });
  const [novelHighlight, setNovelHighlight] = useState(() => {
    try { const v = localStorage.getItem("myclude:novelHighlight"); return v !== null ? v === "true" : true; } catch { return true; }
  });
  const [fontSize, setFontSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem("myclude:novelFontSize"));
      return Number.isFinite(v) && v >= 14 && v <= 34 ? v : 22;
    } catch { return 22; }
  });
  const [fontFamily, setFontFamily] = useState<string>(() => {
    try { return localStorage.getItem("myclude:novelFontFamily") || "RIDIBatang"; } catch { return "RIDIBatang"; }
  });
  const [readerMode, setReaderMode] = useState<"paged" | "scroll">(() => {
    try { return (localStorage.getItem("myclude:novelViewMode") as "paged" | "scroll") || "paged"; } catch { return "paged"; }
  });
  const [customFontLabel, setCustomFontLabel] = useState<string>("");
  const [customFontFamily, setCustomFontFamily] = useState<string>("");
  const [, setCustomFontDataUrl] = useState<string>("");
  const [pageInput, setPageInput] = useState("");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [novelSettingsOpen, setNovelSettingsOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [autoScrollRate, setAutoScrollRate] = useState(1.0);
  const [jumpPercentInput, setJumpPercentInput] = useState("0");
  const [scrollProgress, setScrollProgress] = useState(0);
  const [readerProgress, setReaderProgress] = useState(0);
  const [scrollAnchorPage, setScrollAnchorPage] = useState(0);
  const [uiHidden, setUiHidden] = useState(false);
  const [viewerRestoring, setViewerRestoring] = useState(false);
  const customFontInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const novelScrollRef = useRef<HTMLElement | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const indexSaveTimerRef = useRef<number | null>(null);
  const pendingIndexRef = useRef<number | null>(null);
  const jumpPreviewTimerRef = useRef<number | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const restoreProgressRef = useRef<number | null>(null);
  const paginateJobRef = useRef(0);
  const basePathRef = useRef<string>("");
  const prevReaderModeRef = useRef<"paged" | "scroll">(readerMode);
  const loadedTextItemKeyRef = useRef<string>("");
  const activeTextItemKeyRef = useRef<string>("");
  const deepLinkRef = useRef<{ albumId?: string; itemId?: string; external?: string; consumed: boolean }>({ consumed: false });
  const publicShareTokenRef = useRef<string>("");
  const textWindowRef = useRef<{ start: number; end: number; total: number; itemKey: string }>({
    start: 0,
    end: 0,
    total: 0,
    itemKey: ""
  });
  const recenterBusyRef = useRef(false);
  const pendingRestoreGlobalRef = useRef<number | null>(null);
  const pendingSearchItemRef = useRef<string | null>(null);
  const bytesPerPixelRef = useRef(0.6);

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
  const lines = useMemo(() => novelText.split("\n"), [novelText]);
  const textPages = useMemo(() => novelPages.map((p) => p.text), [novelPages]);
  const lineHeight = Math.max(18, Math.round(fontSize * 1.7));
  const textBytes = useMemo(() => {
    try {
      return new TextEncoder().encode(novelText).length;
    } catch {
      return novelText.length;
    }
  }, [novelText]);
  const bytesPerLine = textBytes / Math.max(1, lines.length);
  const bytesPerPixel = Math.max(0.25, Math.min(20, bytesPerLine / lineHeight));
  useEffect(() => {
    if (Number.isFinite(bytesPerPixel) && bytesPerPixel > 0) {
      bytesPerPixelRef.current = bytesPerPixel;
    }
  }, [bytesPerPixel]);
  const totalBytesForVirtual = Math.max(1, textWindowRef.current.total || 1);
  const virtualTotalHeight = Math.max(1, totalBytesForVirtual / bytesPerPixelRef.current);
  const virtualTopPad = Math.max(0, textWindowRef.current.start / bytesPerPixelRef.current);
  const linesHeight = lines.length * lineHeight;
  const virtualBottomPad = Math.max(0, virtualTotalHeight - virtualTopPad - linesHeight);
  const totalLineCount = useMemo(() => {
    if (!novelText) return 1;
    return lines.length;
  }, [novelText, lines]);

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

  function checkUnsyncedStatus() {
    const keys = Object.keys(localStorage);
    const unsynced = keys.some((key) => {
      if (key.startsWith("myclude:text-progress:")) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || "{}");
          return !!data.unsynced;
        } catch {
          return false;
        }
      }
      if (key.startsWith("myclude:text-index:")) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || "{}");
          return !!data.unsynced;
        } catch {
          return false;
        }
      }
      return false;
    });
    setHasUnsyncedData(unsynced);
  }

  function textProgressStorageKey(albumId: string, imageId: string): string {
    return `myclude:text-progress:${user?.id ?? "anon"}:${albumId}:${imageId}`;
  }

  function textIndexStorageKey(albumId: string, imageId: string): string {
    return `myclude:text-index:${user?.id ?? "anon"}:${albumId}:${imageId}`;
  }

  function recentTextStorageKey(): string {
    return `myclude:recent-text:${user?.id ?? "anon"}`;
  }

  function readRecentText(): RecentTextEntry | null {
    try {
      const raw = localStorage.getItem(recentTextStorageKey());
      if (!raw) return null;
      return JSON.parse(raw) as RecentTextEntry;
    } catch {
      return null;
    }
  }

  function writeRecentText(entry: RecentTextEntry): void {
    try {
      localStorage.setItem(recentTextStorageKey(), JSON.stringify(entry));
      setRecentText(entry);
    } catch {
      // ignore storage errors
    }
  }

  function readLocalTextProgress(albumId: string, imageId: string): number | null {
    try {
      const raw = localStorage.getItem(textProgressStorageKey(albumId, imageId));
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" ? parsed.progress : Number(raw);
    } catch {
      const raw = localStorage.getItem(textProgressStorageKey(albumId, imageId));
      return raw ? Number(raw) : null;
    }
  }

  function readLocalTextIndex(albumId: string, imageId: string): number | null {
    try {
      const raw = localStorage.getItem(textIndexStorageKey(albumId, imageId));
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" ? Number(parsed.index) : Number(raw);
    } catch {
      const raw = localStorage.getItem(textIndexStorageKey(albumId, imageId));
      return raw ? Number(raw) : null;
    }
  }

  function writeLocalTextProgress(albumId: string, imageId: string, progress: number, unsynced = false): void {
    try {
      localStorage.setItem(
        textProgressStorageKey(albumId, imageId),
        JSON.stringify({ progress: Math.max(0, Math.min(1, progress)), unsynced })
      );
    } catch {
      // ignore storage errors
    }
  }

  function writeLocalTextIndex(albumId: string, imageId: string, index: number, unsynced = false): void {
    try {
      localStorage.setItem(
        textIndexStorageKey(albumId, imageId),
        JSON.stringify({ index: Math.max(0, Math.floor(index)), unsynced })
      );
    } catch {
      // ignore storage errors
    }
  }

  function toAbsoluteProgress(localProgress: number): number {
    return Math.max(0, Math.min(1, localProgress));
  }

  function toLocalProgress(absoluteProgress: number): number {
    return Math.max(0, Math.min(1, absoluteProgress));
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
    if (!novelMode || readerMode !== "scroll") setAutoAdvance(false);
  }, [novelMode, readerMode]);

  useEffect(() => {
    if (uiHidden) setNovelSettingsOpen(false);
  }, [uiHidden]);

  useEffect(() => {
    if (!novelMode || readerMode !== "paged") {
      if (controlsHideTimerRef.current) {
        window.clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
      return;
    }
    if (novelSettingsOpen) {
      if (controlsHideTimerRef.current) {
        window.clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
      return;
    }
    setUiHidden(false);
    controlsHideTimerRef.current = window.setTimeout(() => {
      setUiHidden(true);
    }, 2600);
    return () => {
      if (controlsHideTimerRef.current) {
        window.clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
    };
  }, [novelMode, readerMode, novelSettingsOpen, textPage]);

  useEffect(() => {
    const jobId = paginateJobRef.current + 1;
    paginateJobRef.current = jobId;
    setPaginationDone(false);

    const lines = novelText.replace(/\r\n/g, "\n").split("\n");
    const pageInnerWidth = 980;
    const pageInnerHeight = 1120;
    const charsPerLine = Math.max(14, Math.floor(pageInnerWidth / (fontSize * 0.95)));
    const maxVisualLines = Math.max(6, Math.floor(pageInnerHeight / (fontSize * 1.62)) - 1);
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
      if (!novelMode) return;
      if (!activeItem || activeItem.itemType !== "text" || !activeItem.contentUrl) {
        loadedTextItemKeyRef.current = "";
        activeTextItemKeyRef.current = "";
        textWindowRef.current = { start: 0, end: 0, total: 0, itemKey: "" };
        setTextPreview("");
        setTextPage(0);
        setScrollProgress(0);
        setReaderProgress(0);
        setTextLoading(false);
        setViewerRestoring(false);
        pendingScrollRestoreRef.current = null;
        pendingRestoreGlobalRef.current = null;
        restoreProgressRef.current = null;
        return;
      }
      const itemKey = `${activeItem.imageId}:${activeItem.contentUrl}`;
      if (loadedTextItemKeyRef.current === itemKey && textPreview.length > 0) {
        return;
      }
      try {
        setTextLoading(true);
        activeTextItemKeyRef.current = itemKey;
        const localIndex = selectedAlbumId ? readLocalTextIndex(selectedAlbumId, activeItem.imageId) : null;
        let serverIndex: number | null = null;
        let serverRatio = 0;
        try {
          const itemIndex = await api<TextIndexResponse>(
            `/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/index`,
            { method: "GET" }
          );
          if (itemIndex.item && typeof itemIndex.item.index === "number") {
            serverIndex = Math.max(0, Math.floor(itemIndex.item.index));
          }
        } catch {
          // fallback to progress/local cache
        }
        if (serverIndex == null) {
          try {
            const itemProgress = await api<{ item: { progress: number } | null }>(
              `/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/progress`,
              { method: "GET" }
            );
            if (itemProgress.item && typeof itemProgress.item.progress === "number") {
              serverRatio = Math.max(0, Math.min(1, itemProgress.item.progress));
            }
          } catch {
            // ignore
          }
        }

        const meta = await api<TextChunkResponse>(
          `/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/text-chunk?offset=0&length=${TEXT_META_BYTES}`,
          { method: "GET" }
        );
        const totalBytes = Math.max(1, Number(meta.totalBytes || meta.nextOffset || 1));
        const preferredIndex = localIndex ?? serverIndex;
        const fallbackRatio = serverRatio;
        const targetByte = preferredIndex != null
          ? Math.max(0, Math.min(totalBytes - 1, Math.floor(preferredIndex)))
          : Math.max(0, Math.min(totalBytes - 1, Math.floor(fallbackRatio * (totalBytes - 1))));
        const half = Math.floor(TEXT_WINDOW_BYTES / 2);
        const startByte = Math.max(0, Math.min(Math.max(0, totalBytes - TEXT_WINDOW_BYTES), targetByte - half));
        const chunk = await api<TextChunkResponse>(
          `/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/text-chunk?offset=${startByte}&length=${TEXT_WINDOW_BYTES}`,
          { method: "GET" }
        );
        if (activeTextItemKeyRef.current !== itemKey) return;
        loadedTextItemKeyRef.current = itemKey;
        textWindowRef.current = {
          start: startByte,
          end: Math.max(startByte, chunk.nextOffset),
          total: Math.max(1, chunk.totalBytes || totalBytes),
          itemKey
        };
        setTextPreview(chunk.text || "");
        setViewerRestoring(true);
        const span = Math.max(1, textWindowRef.current.end - textWindowRef.current.start);
        const localInWindow = Math.max(
          0,
          Math.min(1, (targetByte - textWindowRef.current.start) / span)
        );
        restoreProgressRef.current = localInWindow;
        const absoluteRatio = Math.max(0, Math.min(1, targetByte / Math.max(1, totalBytes)));
        pendingRestoreGlobalRef.current = absoluteRatio;
        setTextPage(0);
        setScrollProgress(localInWindow);
        setReaderProgress(absoluteRatio);
        setTextIndex(targetByte);
        pendingScrollRestoreRef.current = absoluteRatio;
      } catch {
        if (activeTextItemKeyRef.current === itemKey) {
          loadedTextItemKeyRef.current = "";
        }
        textWindowRef.current = { start: 0, end: 0, total: 0, itemKey: "" };
        setTextPreview("텍스트 미리보기를 불러오지 못했습니다.");
        setTextPage(0);
        setScrollProgress(0);
        setReaderProgress(0);
        setViewerRestoring(false);
        pendingScrollRestoreRef.current = null;
      } finally {
        if (activeTextItemKeyRef.current === itemKey) {
          setTextLoading(false);
        }
      }
    }
    void loadTextPreview();
  }, [externalItem, activeItem?.imageId, activeItem?.itemType, activeItem?.contentUrl, savedImageId, savedProgress, selectedAlbumId, novelMode]);

  useEffect(() => {
    if (textPage >= novelPages.length) {
      if (!paginationDone) return;
      if (!externalItem && activeItem?.itemType === "text" && textLoading) return;
      setTextPage(Math.max(0, novelPages.length - 1));
    }
  }, [textPage, novelPages.length, paginationDone, externalItem, activeItem?.itemType, textLoading]);

  useEffect(() => {
    if (scrollAnchorPage >= novelPages.length) {
      setScrollAnchorPage(Math.max(0, novelPages.length - 1));
    }
  }, [scrollAnchorPage, novelPages.length]);

  useEffect(() => {
    if (!paginationDone) return;
    const progress = restoreProgressRef.current;
    if (progress == null) return;
    const bounded = Math.max(0, Math.min(1, progress));
    const page = novelPages.length > 1 ? Math.round(bounded * (novelPages.length - 1)) : 0;
    setTextPage(page);
    const global = pendingRestoreGlobalRef.current;
    if (global != null) {
      setReaderProgress(global);
    }
    setScrollProgress(bounded);
    setScrollAnchorPage(page);
    pendingScrollRestoreRef.current = bounded;
    restoreProgressRef.current = null;
    if (readerMode === "paged") {
      setViewerRestoring(false);
    }
  }, [novelPages.length, paginationDone, externalItem?.sourceUrl, activeItem?.imageId]);

  useEffect(() => {
    const prevMode = prevReaderModeRef.current;
    if (prevMode === readerMode) return;
    prevReaderModeRef.current = readerMode;
    const bounded = Math.max(0, Math.min(1, toLocalProgress(readerProgress)));
    if (readerMode === "paged") {
      const page = novelPages.length > 1 ? Math.round(bounded * (novelPages.length - 1)) : 0;
      setTextPage(page);
      setScrollAnchorPage(page);
      return;
    }
    pendingScrollRestoreRef.current = bounded;
  }, [readerMode, novelPages.length]);

  useEffect(() => {
    if (!novelMode || readerMode !== "scroll") return;
    if (!novelScrollRef.current) return;
    const ratio = pendingScrollRestoreRef.current;
    if (ratio == null) return;
    const restoredRatio = Math.max(0, Math.min(1, ratio));
    const node = novelScrollRef.current;
    let canceled = false;
    let attempts = 0;
    setViewerRestoring(true);
    function applyRestore() {
      if (canceled) return;
      const max = Math.max(0, virtualTotalHeight - node.clientHeight);
      if (max <= 0 && attempts < 30) {
        attempts += 1;
        window.requestAnimationFrame(applyRestore);
        return;
      }
      node.scrollTop = max * restoredRatio;
      const global = pendingRestoreGlobalRef.current;
      if (global != null) {
        setReaderProgress(global);
        const total = Math.max(1, textWindowRef.current.total || 1);
        const desiredIndex = Math.max(0, Math.min(total - 1, Math.floor(global * total)));
        const span = Math.max(1, textWindowRef.current.end - textWindowRef.current.start);
        const local = Math.max(0, Math.min(1, (desiredIndex - textWindowRef.current.start) / span));
        setScrollProgress(local);
        setTextIndex(desiredIndex);
      }
      pendingRestoreGlobalRef.current = null;
      pendingScrollRestoreRef.current = null;
      setViewerRestoring(false);
    }
    const raf = window.requestAnimationFrame(applyRestore);
    return () => {
      canceled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [novelMode, readerMode, novelPages.length, fontSize, fontFamily, textPreview, externalItem]);

  useEffect(() => {
    if (!novelMode || readerMode !== "scroll" || !autoAdvance) return;
    const screensPerMinute = Math.max(1, Math.min(5, autoScrollRate));
    let raf = 0;
    let prevTs = 0;
    let carryPx = 0;
    function tick(ts: number) {
      const current = novelScrollRef.current;
      if (!current) {
        raf = window.requestAnimationFrame(tick);
        return;
      }
      if (!prevTs) prevTs = ts;
      const dt = Math.max(0, ts - prevTs);
      prevTs = ts;
      const max = Math.max(0, current.scrollHeight - current.clientHeight);
      if (max <= 0) {
        raf = window.requestAnimationFrame(tick);
        return;
      }
      const pxPerSecond = (current.clientHeight * screensPerMinute) / 60;
      carryPx += (pxPerSecond * dt) / 1000;
      const stepPx = Math.floor(carryPx);
      if (stepPx <= 0) {
        raf = window.requestAnimationFrame(tick);
        return;
      }
      carryPx -= stepPx;
      const nextTop = Math.min(max, current.scrollTop + stepPx);
      current.scrollTop = nextTop;
      if (nextTop >= max - 1) {
        setAutoAdvance(false);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [novelMode, readerMode, autoAdvance, textPreview, fontSize, fontFamily, autoScrollRate]);

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
          if (typeof settings.item.novelHighlight === "boolean") {
            setNovelHighlight(settings.item.novelHighlight);
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
    setQuickAddOpen(false);
  }, [selectedAlbumId]);

  useEffect(() => {
    setRecentText(readRecentText());
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const q = globalSearchQuery.trim();
    if (!q) {
      setGlobalSearchAlbums([]);
      setGlobalSearchItems([]);
      setGlobalSearchLoading(false);
      return;
    }
    setGlobalSearchLoading(true);
    const timer = window.setTimeout(() => {
      void api<{ albums: GlobalSearchAlbum[]; items: GlobalSearchItem[] }>(
        `/api/search?q=${encodeURIComponent(q)}`,
        { method: "GET" }
      )
        .then((res) => {
          setGlobalSearchAlbums(res.albums ?? []);
          setGlobalSearchItems(res.items ?? []);
        })
        .catch(() => {
          setGlobalSearchAlbums([]);
          setGlobalSearchItems([]);
        })
        .finally(() => setGlobalSearchLoading(false));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [user?.id, globalSearchQuery]);

  useEffect(() => {
    const wanted = pendingSearchItemRef.current;
    if (!wanted) return;
    const idx = items.findIndex((x) => x.imageId === wanted);
    if (idx >= 0) {
      setActiveIndex(idx);
      pendingSearchItemRef.current = null;
    }
  }, [items]);

  useEffect(() => {
    if (!user || !settingsHydrated) return;
    try {
      localStorage.setItem("myclude:novelTheme", novelTheme);
      localStorage.setItem("myclude:novelFontSize", String(fontSize));
      localStorage.setItem("myclude:novelFontFamily", fontFamily);
      localStorage.setItem("myclude:novelViewMode", readerMode);
      localStorage.setItem("myclude:novelHighlight", String(novelHighlight));
    } catch { /* ignore */ }

    const timer = setTimeout(() => {
      void api("/api/users/settings", {
        method: "POST",
        body: JSON.stringify({
          novelFontFamily: fontFamily,
          novelTheme,
          novelFontSize: fontSize,
          novelViewMode: readerMode,
          novelHighlight
        })
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [user, settingsHydrated, fontFamily, novelTheme, fontSize, readerMode, novelHighlight]);

  useEffect(() => {
    if (selectedAlbum) setRenameTitle(selectedAlbum.title);
  }, [selectedAlbum?.id]);

  useEffect(() => {
    if (activeIndex >= filteredItems.length) setActiveIndex(0);
  }, [filteredItems.length, activeIndex]);

  useEffect(() => {
    if (!selectedAlbumId || !activeItem) return;
    writeLastViewedImageId(selectedAlbumId, activeItem.imageId);
    if (activeItem.itemType === "text") {
      writeRecentText({
        albumId: selectedAlbumId,
        imageId: activeItem.imageId,
        title: activeItem.originalName || activeItem.imageId,
        viewedAt: new Date().toISOString()
      });
    }
  }, [selectedAlbumId, activeItem?.imageId]);

  useEffect(() => {
    const path = window.location.pathname;
    basePathRef.current = path;
    const url = new URL(window.location.href);
    const albumId = url.searchParams.get("album") || undefined;
    const itemId = url.searchParams.get("item") || undefined;
    const external = url.searchParams.get("external") || undefined;
    deepLinkRef.current = { albumId, itemId, external, consumed: false };
    publicShareTokenRef.current = url.searchParams.get("publicShare") || "";
  }, []);

  useEffect(() => {
    const token = publicShareTokenRef.current;
    if (!token) return;
    publicShareTokenRef.current = "";
    void openPublicShare(token);
  }, []);

  useEffect(() => {
    const deep = deepLinkRef.current;
    if (deep.consumed || !user) return;
    if (deep.external) {
      setExternalUrl(deep.external);
      deep.consumed = true;
      window.setTimeout(() => {
        void openExternalTextViewer(deep.external);
      }, 0);
      return;
    }
    if (deep.albumId && selectedAlbumId !== deep.albumId) {
      setSelectedAlbumId(deep.albumId);
      return;
    }
    if (deep.itemId && items.length > 0) {
      const idx = items.findIndex((x) => x.imageId === deep.itemId);
      if (idx >= 0) {
        setActiveIndex(idx);
        deep.consumed = true;
      }
    }
  }, [user, selectedAlbumId, items]);

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
      const putObject = async (url: string, body: BodyInit, contentType: string) => {
        const useCredentials = url.startsWith(apiBase);
        const res = await fetch(url, {
          method: "PUT",
          body,
          headers: { "content-type": contentType },
          ...(useCredentials ? { credentials: "include" as const } : {})
        });
        if (!res.ok) {
          const errBody = (await res.text()).trim();
          throw new Error(`put failed ${res.status}${errBody ? `: ${errBody}` : ""}`);
        }
        return res;
      };
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
          const body = await readTextFileAuto(file);
          await putObject(sign.contentPutUrl, body, file.type || "text/plain");
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
          await Promise.all([
            putObject(sign.thumbPutUrl, thumb, "image/webp"),
            putObject(sign.previewPutUrl, preview, "image/webp")
          ]);
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

  async function saveTextIndex(targetImageId: string, indexRaw: number) {
    if (externalItem) return;
    if (!selectedAlbumId || !targetImageId) return;
    const safeIndex = Math.max(0, Math.floor(indexRaw));
    writeLocalTextIndex(selectedAlbumId, targetImageId, safeIndex, true);
    checkUnsyncedStatus();
    try {
      await api(`/api/albums/${selectedAlbumId}/items/${targetImageId}/index`, {
        method: "POST",
        body: JSON.stringify({ index: safeIndex })
      });
      // sync success
      writeLocalTextIndex(selectedAlbumId, targetImageId, safeIndex, false);
    } catch {
      // keep local backup even if network/save fails
    }
    checkUnsyncedStatus();
    setSavedImageId(targetImageId);
    const total = Math.max(1, textWindowRef.current.total || 1);
    const progress = Math.max(0, Math.min(1, safeIndex / total));
    setSavedProgress(progress);
    setTextIndex(safeIndex);
    if (activeItem?.imageId === targetImageId) {
      setReaderProgress(progress);
    }
  }

  function queueScrollIndexSave(index: number) {
    if (externalItem) {
      const total = Math.max(1, textWindowRef.current.total || 1);
      writeExternalProgress(externalItem.sourceUrl, Math.max(0, Math.min(1, index / total)));
      return;
    }
    if (!activeItem || activeItem.itemType !== "text") return;
    const imageId = activeItem.imageId;
    if (indexSaveTimerRef.current) {
      window.clearTimeout(indexSaveTimerRef.current);
    }
    pendingIndexRef.current = index;
    indexSaveTimerRef.current = window.setTimeout(() => {
      const pending = pendingIndexRef.current;
      if (pending == null) return;
      void saveTextIndex(imageId, pending);
    }, 650);
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

  function goDriveRoot() {
    setSelectedAlbumId(null);
    setItemQuery("");
    setSelectedImages([]);
    setActiveIndex(0);
    setNovelMode(false);
    setStatus(user ? `로그인됨: ${user.username}` : "MyClude Drive");
  }


  function openGlobalAlbum(albumId: string) {
    pendingSearchItemRef.current = null;
    setSelectedAlbumId(albumId);
  }

  function openGlobalItem(albumId: string, imageId: string, itemType: "image" | "text") {
    pendingSearchItemRef.current = imageId;
    setSelectedAlbumId(albumId);
    if (itemType === "text") {
      setNovelMode(true);
    }
  }

  function openRecentText(): void {
    if (!recentText) return;
    pendingSearchItemRef.current = recentText.imageId;
    setSelectedAlbumId(recentText.albumId);
    setNovelMode(true);
    setStatus(`최근 텍스트 열기: ${recentText.title}`);
  }

  async function copyCurrentShareLink() {
    try {
      let shareLink = "";
      if (selectedAlbumId && activeItem) {
        const shared = await api<{ token: string; url: string; expiresAt: string }>("/api/share/item", {
          method: "POST",
          body: JSON.stringify({ albumId: selectedAlbumId, imageId: activeItem.imageId })
        });
        const appBase = `${window.location.origin}${window.location.pathname}`;
        shareLink = `${appBase}?publicShare=${encodeURIComponent(shared.token)}`;
      } else if (externalItem) {
        shareLink = externalItem.sourceUrl;
      } else if (externalImageItem) {
        shareLink = externalImageItem.sourceUrl;
      }
      if (shareLink) {
        const shareTitle =
          externalItem?.title ||
          externalImageItem?.title ||
          activeItem?.originalName ||
          activeItem?.imageId ||
          "MyClude";
        if (typeof navigator.share === "function") {
          await navigator.share({ title: shareTitle, url: shareLink });
          setStatus("공유 창을 열었습니다.");
          return;
        }
        await navigator.clipboard.writeText(shareLink);
        setStatus("공유 링크를 복사했습니다.");
        return;
      }
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
        const res = await fetch(`${apiBase}/api/external-text/stream?url=${encodeURIComponent(externalItem.sourceUrl)}`, {
          method: "GET",
          credentials: "include"
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        triggerBlobDownload(blob, `${externalItem.title || "external"}.txt`);
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
      }      if (!activeItem) return;
      if (activeItem.itemType === "text") {
        if (!selectedAlbumId) throw new Error("album not selected");
        const textRes = await api<TextFullResponse>(`/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/text-full`, {
          method: "GET"
        });
        const blob = new Blob([textRes.text], { type: "text/plain;charset=utf-8" });
        triggerBlobDownload(blob, activeItem.originalName || `${activeItem.imageId}.txt`);
      } else {
        const sourceUrl = activeItem.previewUrl;
        if (!sourceUrl) throw new Error("download url missing");
        const res = await fetch(sourceUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        triggerBlobDownload(blob, activeItem.originalName || `${activeItem.imageId}.webp`);
      }
      setStatus("파일 다운로드가 완료되었습니다.");
    } catch (err) {
      setStatus(`다운로드 실패: ${toErrorMessage(err)}`);
    }
  }

  async function openExternalTextViewer(overrideUrl?: string) {
    const url = (overrideUrl ?? externalUrl).trim();
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
      setReaderProgress(restoredProgress);
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
      setScrollProgress(restoredProgress);
      setReaderProgress(restoredProgress);
      pendingScrollRestoreRef.current = 0;
      pendingScrollRestoreRef.current = restoredProgress;
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

  async function openPublicShare(token: string) {
    if (!token) return;
    try {
      setPublicShareLoading(true);
      const res = await fetch(`${apiBase}/api/public/share/${encodeURIComponent(token)}`, { method: "GET" });
      if (!res.ok) throw new Error(await res.text());
      const kind = (res.headers.get("x-external-kind") || "").toLowerCase();
      const encodedTitle = res.headers.get("x-external-title-encoded") || "";
      let title = "공유 파일";
      try {
        title = encodedTitle ? decodeURIComponent(encodedTitle) : "공유 파일";
      } catch {
        title = "공유 파일";
      }
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (kind === "image" || contentType.startsWith("image/")) {
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        setExternalImageItem({
          sourceUrl: `${apiBase}/api/public/share/${encodeURIComponent(token)}`,
          title,
          contentType: contentType || "image/*",
          objectUrl
        });
        setExternalItem(null);
        setNovelMode(false);
        setStatus("공유 이미지를 열었습니다.");
        return;
      }
      const data = await res.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
      setExternalItem({
        sourceUrl: `${apiBase}/api/public/share/${encodeURIComponent(token)}`,
        title,
        contentType: contentType || "text/plain",
        text
      });
      setExternalImageItem(null);
      setTextPage(0);
      setScrollProgress(0);
      setReaderProgress(0);
      setNovelMode(true);
      setStatus("공유 텍스트를 열었습니다.");
    } catch (err) {
      setStatus(`공유 링크 열기 실패: ${toErrorMessage(err)}`);
    } finally {
      setPublicShareLoading(false);
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
      setReaderProgress(restoredProgress);
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
      setReaderProgress(restoredProgress);
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

  function closeNovelViewer() {
    if (!externalItem && activeItem?.itemType === "text") {
      const imageId = activeItem.imageId;
      const total = Math.max(1, textWindowRef.current.total || 1);
      const index = readerMode === "paged"
        ? Math.floor((Math.max(1, novelPages.length) > 1 ? textPage / (Math.max(1, novelPages.length) - 1) : 0) * (total - 1))
        : Math.max(0, Math.floor(textIndex));
      void saveTextIndex(imageId, index);
    }
    setViewerRestoring(false);
    pendingScrollRestoreRef.current = null;
    pendingRestoreGlobalRef.current = null;
    restoreProgressRef.current = null;
    setNovelMode(false);
    setExternalItem(null);
  }

  const totalPages = Math.max(1, novelPages.length);
  const estimatedScrollPageHeight = Math.max(360, (novelScrollRef.current?.clientHeight ?? 760) - 18);
  const virtualGap = readerMode === "scroll" ? 0 : 12;
  const virtualExtent = estimatedScrollPageHeight + virtualGap;
  const safeAnchorPage = Math.max(0, Math.min(totalPages - 1, scrollAnchorPage));
  const virtualStart = Math.max(0, safeAnchorPage - 12);
  const virtualEnd = Math.max(virtualStart, Math.min(totalPages - 1, safeAnchorPage + 12));
  const topSpacerHeight = virtualStart * virtualExtent;
  const bottomSpacerHeight = Math.max(0, (totalPages - 1 - virtualEnd) * virtualExtent);
  const progressForLine = readerMode === "paged"
    ? (totalPages > 1 ? textPage / (totalPages - 1) : 0)
    : readerProgress;
  const highlightLine = Math.max(1, Math.min(lines.length, Math.round(scrollProgress * (lines.length - 1)) + 1));
  const currentLine = Math.max(1, Math.min(totalLineCount, Math.round(progressForLine * Math.max(0, totalLineCount - 1)) + 1));
  const viewerOpen = !!externalImageItem || publicShareLoading || (novelMode && (externalItem || activeItem?.itemType === "text"));

  useEffect(() => {
    if (!basePathRef.current) return;
    const current = new URL(window.location.href);
    const onViewerQuery = current.searchParams.get("view") === "novel";
    if (viewerOpen && !onViewerQuery) {
      current.searchParams.set("view", "novel");
      window.history.pushState({ mycludeViewer: true }, "", `${current.pathname}?${current.searchParams.toString()}${current.hash}`);
      return;
    }
    if (!viewerOpen && onViewerQuery) {
      current.searchParams.delete("view");
      const query = current.searchParams.toString();
      window.history.replaceState({}, "", `${basePathRef.current}${query ? `?${query}` : ""}${current.hash}`);
    }
  }, [viewerOpen]);

  useEffect(() => {
    function onPopState() {
      const url = new URL(window.location.href);
      const onViewerQuery = url.searchParams.get("view") === "novel";
      if (!onViewerQuery && viewerOpen) {
        setNovelMode(false);
        setExternalImageItem(null);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [viewerOpen]);

  useEffect(() => {
    const current = new URL(window.location.href);
    const wantsViewer = current.searchParams.get("view") === "novel";
    if (!wantsViewer) return;
    if (novelMode) return;
    if (externalImageItem || externalItem) {
      setNovelMode(true);
      return;
    }
    if (activeItem?.itemType === "text") {
      setNovelMode(true);
    }
  }, [novelMode, activeItem?.imageId, activeItem?.itemType, externalItem, externalImageItem]);

  useEffect(() => {
    if (!novelMode) return;
    setReaderMode("scroll");
  }, [novelMode]);

  useEffect(() => {
    return () => {
      if (jumpPreviewTimerRef.current) {
        window.clearTimeout(jumpPreviewTimerRef.current);
        jumpPreviewTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!novelSettingsOpen) return;
    setJumpPercentInput((Math.max(0, Math.min(1, readerProgress)) * 100).toFixed(1));
  }, [novelSettingsOpen, readerProgress]);

  function jumpToPercent(valueInput?: number) {
    const value = Number(valueInput ?? jumpPercentInput);
    if (!Number.isFinite(value)) return;
    const bounded = Math.max(0, Math.min(100, value)) / 100;
    if (!externalItem && textWindowRef.current.total > 0) {
      const total = Math.max(1, textWindowRef.current.total || 1);
      const targetIndex = Math.floor(bounded * (total - 1));
      void recenterTextWindowByIndex(targetIndex, bounded);
      return;
    }
    setScrollBySlider(bounded, true);
  }

  function setScrollBySlider(progress: number, persist = false): void {
    const bounded = Math.max(0, Math.min(1, progress));
    setScrollProgress(bounded);
    setReaderProgress(bounded);
    if (readerMode === "paged") {
      const page = novelPages.length > 1 ? Math.round(bounded * (novelPages.length - 1)) : 0;
      setTextPage(page);
      setScrollAnchorPage(page);
    } else {
      const node = novelScrollRef.current;
      if (node) {
        const virtualMax = Math.max(0, virtualTotalHeight - node.clientHeight);
        node.scrollTop = virtualMax * bounded;
      } else {
        pendingScrollRestoreRef.current = bounded;
      }
    }
    if (persist && !externalItem && activeItem?.itemType === "text") {
      const total = Math.max(1, textWindowRef.current.total || 1);
      const index = Math.floor(bounded * (total - 1));
      setTextIndex(index);
      void saveTextIndex(activeItem.imageId, index);
    }
  }

  function onNovelScroll(e: React.UIEvent<HTMLElement>): void {
    if (readerMode !== "scroll") return;
    const node = e.currentTarget;
    const virtualMax = Math.max(1, virtualTotalHeight - node.clientHeight);
    const ratio = Math.max(0, Math.min(1, node.scrollTop / virtualMax));
    setScrollProgress(ratio);
    const desiredIndex = Math.max(0, Math.floor(node.scrollTop * bytesPerPixelRef.current));
    const total = Math.max(1, textWindowRef.current.total || 1);
    setReaderProgress(Math.max(0, Math.min(1, desiredIndex / total)));
    setTextIndex(desiredIndex);
    queueScrollIndexSave(desiredIndex);
    const win = textWindowRef.current;
    if (!externalItem && win.total > 0 && !textLoading && !recenterBusyRef.current) {
      const buffer = Math.max(4096, Math.floor(TEXT_WINDOW_BYTES * 0.25));
      if (desiredIndex < win.start + buffer || desiredIndex > win.end - buffer) {
        void recenterTextWindowByIndex(desiredIndex, ratio);
      }
    }
  }

  async function recenterTextWindowByIndex(targetIndex: number, absoluteRatio?: number): Promise<void> {
    if (externalItem) return;
    if (!selectedAlbumId || !activeItem || activeItem.itemType !== "text") return;
    if (recenterBusyRef.current) return;
    const total = Math.max(1, textWindowRef.current.total || 1);
    const boundedIndex = Math.max(0, Math.min(total - 1, Math.floor(targetIndex)));
    const half = Math.floor(TEXT_WINDOW_BYTES / 2);
    const startByte = Math.max(0, Math.min(Math.max(0, total - TEXT_WINDOW_BYTES), boundedIndex - half));
    try {
      recenterBusyRef.current = true;
      setTextLoading(true);
      const chunk = await api<TextChunkResponse>(
        `/api/albums/${selectedAlbumId}/items/${activeItem.imageId}/text-chunk?offset=${startByte}&length=${TEXT_WINDOW_BYTES}`,
        { method: "GET" }
      );
      textWindowRef.current = {
        start: startByte,
        end: Math.max(startByte, chunk.nextOffset),
        total: Math.max(1, chunk.totalBytes || total),
        itemKey: textWindowRef.current.itemKey
      };
      setTextPreview(chunk.text || "");
      const span = Math.max(1, textWindowRef.current.end - textWindowRef.current.start);
      const localInWindow = Math.max(0, Math.min(1, (boundedIndex - textWindowRef.current.start) / span));
      const ratio = absoluteRatio ?? Math.max(0, Math.min(1, boundedIndex / total));
      setViewerRestoring(true);
      pendingRestoreGlobalRef.current = ratio;
      pendingScrollRestoreRef.current = ratio;
      setScrollProgress(localInWindow);
      setReaderProgress(ratio);
      setTextIndex(boundedIndex);
    } finally {
      setTextLoading(false);
      recenterBusyRef.current = false;
    }
  }

  async function uploadCustomFont(file: File | null): Promise<void> {
    if (!file) return;
    try {
      const ext = (file.name.split(".").pop() || "otf").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      const family = `MyCludeUserFont_${Date.now()}`;
      const dataUrl = await readFileAsDataUrl(file);
      const face = new FontFace(family, `url(${dataUrl}) format("${ext}")`);
      await face.load();
      document.fonts.add(face);
      setCustomFontFamily(family);
      setCustomFontLabel(file.name);
      setFontFamily(family);
      setStatus(`폰트 적용: ${file.name}`);
    } catch {
      setStatus("폰트 업로드 실패");
    }
  }

  function onJumpSliderChange(rawValue: string) {
    setJumpPercentInput(rawValue);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    if (jumpPreviewTimerRef.current) {
      window.clearTimeout(jumpPreviewTimerRef.current);
    }
    // Live preview while dragging without spamming chunk fetches.
    jumpPreviewTimerRef.current = window.setTimeout(() => {
      jumpToPercent(value);
    }, 120);
  }

  
  return (
    <div className="app">
      {!viewerOpen && (
        <>
          <header className="topbar">
            <div className="topbar-left">
              <button className="logo-btn" onClick={goHome}>
                MyClude Drive
              </button>
            </div>
            <div className="topbar-center">
              <input
                className="top-search"
                value={globalSearchQuery}
                onChange={(e) => setGlobalSearchQuery(e.target.value)}
                placeholder="드라이브 전체 검색 (폴더/파일)"
              />
            </div>
            <div className="topbar-right">
              <span className="status">{status}</span>
              {hasUnsyncedData && <span className="unsynced-badge" title="동기화되지 않은 데이터가 있습니다.">SYNC</span>}
            </div>
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
        <main className="drive drive-shell">
          <aside className="panel sidebar drive-nav">
            <div className="drive-nav-head">
              <div className="drive-avatar">{(user.username || "U").slice(0, 1).toUpperCase()}</div>
              <div className="drive-user-meta">
                <strong>{user.username}</strong>
                <small>Personal Drive</small>
              </div>
              <button onClick={() => void logout()}>로그아웃</button>
            </div>

            <nav className="drive-quick-nav" aria-label="drive menu">
              <button type="button" className="drive-quick-item active">내 드라이브</button>
              <button type="button" className="drive-quick-item" onClick={openRecentText} disabled={!recentText}>
                최근
                {recentText && <small className="drive-quick-sub">{recentText.title}</small>}
              </button>
            </nav>

            <section className="drive-nav-card">
              <h3>새 폴더</h3>
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
            </section>

            <div className="drive-folder-head">
              <h3 className="drive-section-title">폴더 목록</h3>
              <span>{filteredAlbums.length}</span>
            </div>
            <ul className="album-list drive-folder-list">
              {filteredAlbums.map((a) => (
                <li key={a.id} className={a.id === selectedAlbumId ? "selected" : ""}>
                  <button onClick={() => setSelectedAlbumId(a.id)}>
                    <span className="folder-row-icon" aria-hidden="true">📁</span>
                    <span className="folder-row-main">
                      <span className="folder-row-title">{a.title}</span>
                      <small className="folder-row-sub">{a.description || "설명 없음"}</small>
                    </span>
                  </button>
                  <button className="danger" onClick={() => void deleteAlbum(a.id)}>
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="panel content drive-content">
            {globalSearchQuery.trim().length > 0 && (
              <section className="drive-search-results">
                <div className="drive-search-results-head">
                  <strong>검색 결과</strong>
                  <span>{globalSearchLoading ? "검색 중..." : `${globalSearchAlbums.length + globalSearchItems.length}개`}</span>
                </div>
                {globalSearchAlbums.length === 0 && globalSearchItems.length === 0 && !globalSearchLoading && (
                  <p>검색 결과가 없습니다.</p>
                )}
                {globalSearchAlbums.map((a) => (
                  <button key={`album-${a.albumId}`} className="drive-search-row" onClick={() => openGlobalAlbum(a.albumId)}>
                    <span>📁</span>
                    <span>[폴더] {a.title}</span>
                  </button>
                ))}
                {globalSearchItems.map((it) => (
                  <button
                    key={`item-${it.albumId}-${it.imageId}`}
                    className="drive-search-row"
                    onClick={() => openGlobalItem(it.albumId, it.imageId, it.itemType)}
                  >
                    <span>{it.itemType === "text" ? "📘" : "🖼️"}</span>
                    <span>{it.originalName} <small>({it.albumTitle})</small></span>
                  </button>
                ))}
              </section>
            )}
                        {!selectedAlbum && (
              <section className="drive-table-wrap drive-folder-picker">
                <div className="drive-main-head">
                  <h2>내 드라이브</h2>
                  <span>{filteredAlbums.length}개 폴더</span>
                </div>
                <div className="drive-table-head">
                  <div />
                  <div>이름</div>
                  <div>설명</div>
                  <div>상태</div>
                  <div />
                  <div />
                </div>
                <div className="drive-table-body">
                  {filteredAlbums.map((a) => (
                    <div key={a.id} className="drive-table-row" onClick={() => setSelectedAlbumId(a.id)}>
                      <div />
                      <div className="drive-name-cell">
                        <span className="drive-file-icon">📁</span>
                        <span>{a.title}</span>
                      </div>
                      <div>{a.description || "-"}</div>
                      <div>Ready</div>
                      <div />
                      <div onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="drive-row-open" onClick={() => setSelectedAlbumId(a.id)}>
                          열기
                        </button>
                      </div>
                    </div>
                  ))}
                  {filteredAlbums.length === 0 && (
                    <div className="drive-empty-state">
                      <h2>폴더가 없습니다</h2>
                      <p>왼쪽에서 새 폴더를 만들거나 검색어를 확인해 주세요.</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {selectedAlbum && (
              <>
                <div className="drive-main-head">
                  <h2>{selectedAlbum.title}</h2>
                  <div className="drive-main-head-right">
                    <span>{filteredItems.length}개 항목</span>
                    <div className="drive-plus-wrap">
                      <button
                        type="button"
                        className="drive-plus-btn"
                        onClick={() => setQuickAddOpen((v) => !v)}
                        aria-label="quick add"
                      >
                        +
                      </button>
                      {quickAddOpen && (
                        <div className="drive-plus-menu">
                          <button
                            type="button"
                            onClick={() => {
                              uploadInputRef.current?.click();
                              setQuickAddOpen(false);
                            }}
                          >
                            파일 업로드
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowLinkComposer(true);
                              setQuickAddOpen(false);
                            }}
                          >
                            링크 업로드
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void createAlbum();
                              setQuickAddOpen(false);
                            }}
                          >
                            새 폴더
                          </button>
                          <button
                            type="button"
                            disabled={selectedImages.length === 0 || busy}
                            onClick={() => {
                              void deleteSelectedItems();
                              setQuickAddOpen(false);
                            }}
                          >
                            선택 삭제 ({selectedImages.length})
                          </button>
                        </div>
                      )}
                    </div>
                    <button type="button" className="drive-row-open" onClick={goDriveRoot}>
                      뒤로가기
                    </button>
                    <button type="button" className="drive-row-open" onClick={goDriveRoot}>
                      메인
                    </button>
                  </div>
                </div>

                <input
                  ref={uploadInputRef}
                  style={{ display: "none" }}
                  type="file"
                  multiple
                  accept="image/*,text/*,.txt,.md,.json,.csv,.log"
                  onChange={(e) => void uploadFiles(e.target.files)}
                />

                <div className="drive-filterbar">
                  <input value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} placeholder="파일, 확장자, 문서 본문 검색" />
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "new" | "old" | "name")}>
                    <option value="new">최신순</option>
                    <option value="old">오래된순</option>
                    <option value="name">이름순</option>
                  </select>
                  <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} placeholder="현재 폴더 이름 변경" />
                  <button type="button" onClick={() => void renameAlbum()}>적용</button>
                </div>

                                {showLinkComposer && (
                  <div className="drive-link-modal-backdrop" onClick={() => setShowLinkComposer(false)}>
                    <section className="drive-link-modal" onClick={(e) => e.stopPropagation()}>
                      <header className="drive-link-modal-head">
                        <h3>링크 업로드</h3>
                        <button type="button" className="drive-row-open" onClick={() => setShowLinkComposer(false)}>
                          닫기
                        </button>
                      </header>
                      <p>외부 텍스트 링크를 저장하거나 바로 열 수 있습니다.</p>
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
                      <div className="drive-link-modal-actions">
                        <button type="button" disabled={externalLoading || !selectedAlbumId} onClick={() => void saveExternalLink()}>
                          링크 저장
                        </button>
                        <button type="button" disabled={externalLoading} onClick={() => void openExternalTextViewer()}>
                          {externalLoading ? "불러오는 중..." : "링크 열기"}
                        </button>
                      </div>
                    </section>
                  </div>
                )}
                <section className="drive-table-wrap">
                  <div className="drive-table-head">
                    <div>선택</div>
                    <div>이름</div>
                    <div>소유자</div>
                    <div>수정 날짜</div>
                    <div>파일 크기</div>
                    <div />
                  </div>
                  <div className="drive-table-body">
                    <div className="drive-table-row drive-parent-row" onClick={goDriveRoot}>
                      <div />
                      <div className="drive-name-cell">
                        <span className="drive-file-icon">📁</span>
                        <span>/</span>
                      </div>
                      <div>-</div>
                      <div>-</div>
                      <div>-</div>
                      <div />
                    </div>
                    {filteredItems.map((it, i) => (
                      <div
                        key={it.imageId}
                        className={`drive-table-row ${i === activeIndex ? "active" : ""}`}
                        onClick={() => {
                          setActiveIndex(i);
                          if (it.itemType === "text") {
                            setNovelMode(true);
                          } else {
                            void saveProgress(it.imageId, i);
                          }
                        }}
                      >
                        <div onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedImages.includes(it.imageId)}
                            onChange={() => toggleSelected(it.imageId)}
                          />
                        </div>
                        <div className="drive-name-cell">
                          <span className="drive-file-icon">{it.itemType === "text" ? "📘" : "📁"}</span>
                          <span>{it.originalName || it.imageId}</span>
                        </div>
                        <div>{user.username}</div>
                        <div>{new Date(it.createdAt).toLocaleDateString("ko-KR")}</div>
                        <div>-</div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="drive-row-open"
                            onClick={() => {
                              setActiveIndex(i);
                              if (it.itemType === "text") setNovelMode(true);
                            }}
                          >
                            열기
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {externalLinks.length > 0 && (
                  <div className="drive-saved-links">
                    <h3>저장된 링크</h3>
                    <ul className="album-list">
                      {externalLinks.map((link) => (
                        <li key={link.id}>
                          <button onClick={() => void openSavedExternalLink(link)}>{link.title}</button>
                          <button className="danger" onClick={() => void deleteSavedExternalLink(link.id)}>삭제</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {uploadTotal > 0 && (
                  <div className="upload-progress">
                    <div className="upload-progress-bar" style={{ width: `${Math.round((uploadDone / uploadTotal) * 100)}%` }} />
                  </div>
                )}

                {activeItem && (
                  <div className="viewer drive-view-card">
                    {activeItem.itemType === "image" ? (
                      <img src={activeItem.previewUrl} alt={activeItem.imageId} />
                    ) : (
                      <div className="text-viewer-wrap">
                        <p className="chunk-loading">텍스트 파일은 소설뷰어 UI로만 표시됩니다.</p></div>
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

      {publicShareLoading && !externalImageItem && !(novelMode && (externalItem || activeItem?.itemType === "text")) && (
        <div className={`novel-overlay ${novelTheme === "dark" ? "theme-dark" : "theme-light"}`}>
          <div className="novel-loading-indicator blocking">공유 뷰어 준비 중...</div>
        </div>
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
        <div className={`novel-ui-root ${novelTheme === "dark" ? "is-dark" : "is-light"}`}>
          <div className="novel-ui-normal">
            <div className="novel-ui-normal-top">
              <div className="novel-ui-normal-title">
                <strong>{externalItem ? `[외부] ${externalItem.title}` : (activeItem?.originalName || activeItem?.imageId || "텍스트")}</strong>
                <span>
                  {`${Math.round(readerProgress * 100)}%`}
                  {hasUnsyncedData && <small style={{ marginLeft: '8px', opacity: 0.7 }}>(동기화 중...)</small>}
                </span>
              </div>
              <div className="novel-ui-top-actions">
                <button className="novel-ui-icon-btn" onClick={() => void copyCurrentShareLink()} aria-label="공유">↗</button>
                <button className="novel-ui-icon-btn" onClick={() => void closeNovelViewer()} aria-label="닫기">×</button>
              </div>
            </div>
            {viewerRestoring && (
              <div className="novel-inline-loading" aria-live="polite">
                <span className="novel-spinner" aria-hidden="true" />
                <span>로딩 중...</span>
              </div>
            )}
            <article
              className="novel-ui-normal-scroll"
              ref={(node) => {
                novelScrollRef.current = node;
              }}
              onScroll={onNovelScroll}
            >
              <div className="novel-lines-container" style={{ fontSize: `${fontSize}px`, fontFamily, lineHeight: `${lineHeight}px` }}>
                {textLoading ? (
                  <pre>텍스트를 불러오는 중...</pre>
                ) : (
                  <>
                    <div style={{ height: `${virtualTopPad}px` }} />
                    {lines.map((line, i) => (
                      <div key={i} className={`novel-line ${novelHighlight && i + 1 === highlightLine ? "active-line" : ""}`}>
                        {line || "\u00A0"}
                      </div>
                    ))}
                    <div style={{ height: `${virtualBottomPad}px` }} />
                  </>
                )}
              </div>
            </article>
            <button className="novel-ui-plus-btn" onClick={() => setNovelSettingsOpen((v) => !v)} aria-label="설정 열기">
              +
            </button>
          </div>
          {novelSettingsOpen && (
            <section className="novel-ui-settings-sheet">
              <div className="novel-ui-settings-head">
                <strong>뷰어 설정</strong>
                <button type="button" onClick={() => setNovelSettingsOpen(false)} aria-label="설정 닫기">
                  ×
                </button>
              </div>
              <div className="novel-ui-settings-body">
                <label className="novel-ui-setting-field">
                  <span>글자 크기</span>
                  <div className="novel-ui-size-row">
                    <input type="range" min={14} max={34} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
                    <small>{fontSize}px</small>
                  </div>
                </label>
                <label className="novel-ui-setting-field">
                  <span>현재 줄 강조</span>
                  <div className="novel-ui-size-row">
                    <button
                      type="button"
                      className="novel-ui-action-btn"
                      onClick={() => setNovelHighlight((v) => !v)}
                      style={{ width: '100%', textAlign: 'center' }}
                    >
                      {novelHighlight ? "켜짐" : "꺼짐"}
                    </button>
                  </div>
                </label>
                <label className="novel-ui-setting-field">
                  <span>글꼴</span>
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
                <label className="novel-ui-setting-field">
                  <span>자동 스크롤 속도</span>
                  <div className="novel-ui-size-row">
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={0.05}
                      value={autoScrollRate}
                      onChange={(e) => setAutoScrollRate(Number(e.target.value))}
                    />
                    <small>{autoScrollRate.toFixed(2)} 화면/분</small>
                  </div>
                </label>
                <label className="novel-ui-setting-field">
                  <span>지정 위치 이동 (%)</span>
                  <div className="novel-ui-size-row">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={0.1}
                      value={jumpPercentInput}
                      onChange={(e) => onJumpSliderChange(e.target.value)}
                      onMouseUp={() => jumpToPercent()}
                      onTouchEnd={() => jumpToPercent()}
                      onKeyUp={() => jumpToPercent()}
                    />
                    <small>{Number(jumpPercentInput || "0").toFixed(1)}%</small>
                  </div>
                </label>
                <div className="novel-ui-settings-actions">
                  <button
                    type="button"
                    className="novel-ui-action-btn primary"
                    onClick={() => setNovelTheme((t) => (t === "light" ? "dark" : "light"))}
                  >
                    {novelTheme === "light" ? "다크모드" : "화이트모드"}
                  </button>
                  <button type="button" className="novel-ui-action-btn" onClick={() => void downloadCurrent()}>
                    다운로드
                  </button>
                  <button type="button" className="novel-ui-action-btn" onClick={() => setAutoAdvance((v) => !v)}>
                    {autoAdvance ? "자동 스크롤 정지" : "자동 스크롤 시작"}
                  </button>
                  <button type="button" className="novel-ui-action-btn" onClick={() => void copyCurrentShareLink()}>
                    공유 링크
                  </button>
                </div>
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
        </div>
      )}
    </div>
  );
}







