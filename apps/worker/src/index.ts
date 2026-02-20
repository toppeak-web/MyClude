import { AwsClient } from "aws4fetch";

interface Env {
  DB: D1Database;
  FRONTEND_ORIGIN: string;
  FRONTEND_APP_URL: string;
  JWT_COOKIE_NAME: string;
  JWT_EXPIRES_SECONDS: string;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_CLIENT_SECRET: string;
  R2_S3_ENDPOINT: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

type UserJwt = {
  sub: string;
  username: string;
  exp: number;
};

type JwtPayload = UserJwt & { iat: number };

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });

const base64url = {
  encode(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(input: string): Uint8Array {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
};

const textEncoder = new TextEncoder();

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return base64url.encode(signature);
}

async function createJwt(payload: UserJwt, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload: JwtPayload = { ...payload, iat: Math.floor(Date.now() / 1000) };
  const h = base64url.encode(textEncoder.encode(JSON.stringify(header)).buffer);
  const p = base64url.encode(textEncoder.encode(JSON.stringify(fullPayload)).buffer);
  const s = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${s}`;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (expected !== s) return null;
  const payloadText = new TextDecoder().decode(base64url.decode(p));
  const payload = JSON.parse(payloadText) as JwtPayload;
  if (Date.now() / 1000 >= payload.exp) return null;
  return payload;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 100000
    },
    keyMaterial,
    256
  );
  return `${base64url.encode(salt.buffer)}.${base64url.encode(bits)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltPart, hashPart] = stored.split(".");
  if (!saltPart || !hashPart) return false;
  const salt = new Uint8Array(base64url.decode(saltPart));
  const keyMaterial = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 100000
    },
    keyMaterial,
    256
  );
  return base64url.encode(bits) === hashPart;
}

function parseCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  const kv = raw.split(";").map((x) => x.trim());
  const match = kv.find((x) => x.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=")[1] ?? "") : null;
}

function cookieBase(req: Request, sameSite: "None" | "Lax") {
  const isSecure = new URL(req.url).protocol === "https:";
  return `Path=/; HttpOnly; SameSite=${sameSite}${isSecure ? "; Secure" : ""}`;
}

function setCookie(req: Request, name: string, value: string, maxAgeSec: number): string {
  const isSecure = new URL(req.url).protocol === "https:";
  const sameSite: "None" | "Lax" = isSecure ? "None" : "Lax";
  return `${name}=${encodeURIComponent(value)}; ${cookieBase(req, sameSite)}; Max-Age=${maxAgeSec}`;
}

function setCookieLax(req: Request, name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; ${cookieBase(req, "Lax")}; Max-Age=${maxAgeSec}`;
}

function clearCookie(req: Request, name: string): string {
  const isSecure = new URL(req.url).protocol === "https:";
  const sameSite: "None" | "Lax" = isSecure ? "None" : "Lax";
  return `${name}=; ${cookieBase(req, sameSite)}; Max-Age=0`;
}

function corsHeaders(env: Env, req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  if (origin && origin === env.FRONTEND_ORIGIN) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      "access-control-expose-headers": "x-external-title,x-external-kind,content-type,content-length"
    };
  }
  return {};
}

function unauthorized(env: Env, req: Request) {
  return json({ error: "unauthorized" }, { status: 401, headers: corsHeaders(env, req) });
}

function badRequest(env: Env, req: Request, message: string) {
  return json({ error: message }, { status: 400, headers: corsHeaders(env, req) });
}

async function getCurrentUser(req: Request, env: Env): Promise<JwtPayload | null> {
  const token = parseCookie(req, env.JWT_COOKIE_NAME);
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

async function requireAlbumOwner(env: Env, userId: string, albumId: string): Promise<boolean> {
  const owner = await env.DB.prepare("SELECT user_id FROM albums WHERE id = ?").bind(albumId).first<{ user_id: string }>();
  return owner?.user_id === userId;
}

function nowIso() {
  return new Date().toISOString();
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return true;
  if (lower === "127.0.0.1" || lower === "::1") return true;
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const nums = ipv4.slice(1).map((x) => Number(x));
  if (nums.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  if (nums[0] === 10) return true;
  if (nums[0] === 127) return true;
  if (nums[0] === 169 && nums[1] === 254) return true;
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
  if (nums[0] === 192 && nums[1] === 168) return true;
  return false;
}

function inferExternalTitle(url: URL): string {
  const path = decodeURIComponent(url.pathname || "");
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || url.hostname;
}

function normalizeExternalSourceUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    url.searchParams.delete("dl");
    url.searchParams.set("raw", "1");
  }
  const driveFileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
  const driveIdFromPath = driveFileMatch?.[1] ?? "";
  const driveIdFromQuery = url.searchParams.get("id") ?? "";
  const resourceKey = url.searchParams.get("resourcekey") ?? "";
  const driveId = driveIdFromPath || driveIdFromQuery;
  if (driveId && (host === "drive.google.com" || host === "www.drive.google.com" || host === "docs.google.com")) {
    const out = new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`);
    if (resourceKey) out.searchParams.set("resourcekey", resourceKey);
    return out;
  }
  return url;
}

function getGoogleDriveMeta(url: URL): { id: string; resourceKey: string | null } {
  const idFromPath = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? "";
  const idFromQuery = url.searchParams.get("id") ?? "";
  const id = idFromPath || idFromQuery;
  const resourceKey = url.searchParams.get("resourcekey");
  return { id, resourceKey };
}

function buildGoogleDriveCandidateUrls(input: URL): URL[] {
  const meta = getGoogleDriveMeta(input);
  if (!meta.id) return [input];
  const candidates: URL[] = [];
  const download = new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(meta.id)}`);
  const view = new URL(`https://drive.google.com/uc?export=view&id=${encodeURIComponent(meta.id)}`);
  const thumb = new URL(`https://drive.google.com/thumbnail?id=${encodeURIComponent(meta.id)}&sz=w4000`);
  if (meta.resourceKey) {
    download.searchParams.set("resourcekey", meta.resourceKey);
    view.searchParams.set("resourcekey", meta.resourceKey);
    thumb.searchParams.set("resourcekey", meta.resourceKey);
  }
  candidates.push(download, view, thumb);
  return candidates;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function findGoogleDriveConfirmUrl(html: string, baseUrl: URL): URL | null {
  const hrefMatch = html.match(/href="([^"]*\/uc\?[^"]*confirm=[^"]*)"/i);
  if (hrefMatch?.[1]) {
    const decoded = decodeHtmlEntities(hrefMatch[1]);
    return new URL(decoded, baseUrl);
  }
  const formActionMatch = html.match(/<form[^>]*action="([^"]*\/uc[^"]*)"/i);
  if (!formActionMatch?.[1]) return null;
  const action = new URL(decodeHtmlEntities(formActionMatch[1]), baseUrl);
  const idMatch = html.match(/name="id"\s+value="([^"]+)"/i);
  const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/i);
  const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);
  const resourceKeyMatch = html.match(/name="resourcekey"\s+value="([^"]+)"/i);
  if (idMatch?.[1]) action.searchParams.set("id", idMatch[1]);
  if (confirmMatch?.[1]) action.searchParams.set("confirm", confirmMatch[1]);
  if (uuidMatch?.[1]) action.searchParams.set("uuid", uuidMatch[1]);
  if (resourceKeyMatch?.[1]) action.searchParams.set("resourcekey", resourceKeyMatch[1]);
  if (!action.searchParams.get("confirm")) return null;
  return action;
}

function parseFilenameFromDisposition(disposition: string): string {
  const star = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (star) return decodeURIComponent(star.replace(/^"|"$/g, ""));
  const normal = disposition.match(/filename\s*=\s*("?)([^";]+)\1/i)?.[2];
  return normal ? decodeURIComponent(normal) : "";
}

function extFromName(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? "";
}

function detectExternalKind(response: Response, resolvedUrl: URL): "text" | "image" | "unknown" {
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/javascript")
  ) return "text";

  const cd = response.headers.get("content-disposition") || "";
  const fileName = parseFilenameFromDisposition(cd) || inferExternalTitle(resolvedUrl);
  const ext = extFromName(fileName) || extFromName(resolvedUrl.pathname);
  if (["txt", "md", "json", "csv", "log", "xml", "yaml", "yml"].includes(ext)) return "text";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"].includes(ext)) return "image";
  return "unknown";
}

async function fetchExternalResolvedTextResponse(sourceUrl: URL): Promise<{ response: Response; resolvedUrl: URL }> {
  const host = sourceUrl.hostname.toLowerCase();
  const isGoogleDriveHost =
    host === "drive.google.com" ||
    host === "www.drive.google.com" ||
    host === "docs.google.com";

  let response = await fetch(sourceUrl.toString(), { method: "GET", redirect: "follow" });
  if (!response.ok && isGoogleDriveHost && response.status === 401) {
    for (const candidate of buildGoogleDriveCandidateUrls(sourceUrl)) {
      const retry = await fetch(candidate.toString(), { method: "GET", redirect: "follow" });
      if (retry.ok) {
        response = retry;
        break;
      }
    }
  }
  if (!response.ok) throw new Error(`failed to fetch url: ${response.status}`);

  const firstResolved = new URL(response.url || sourceUrl.toString());
  const firstKind = detectExternalKind(response, firstResolved);
  const firstType = (response.headers.get("content-type") || "").toLowerCase();
  if (firstKind !== "unknown") {
    return { response, resolvedUrl: new URL(response.url || sourceUrl.toString()) };
  }

  if (firstType.includes("text/html")) {
    const html = await response.text();
    const responseUrl = new URL(response.url || sourceUrl.toString());
    const responseHost = responseUrl.hostname.toLowerCase();
    const isGoogleDrive =
      responseHost === "drive.google.com" ||
      responseHost === "www.drive.google.com" ||
      responseHost === "docs.google.com";
    if (isGoogleDrive) {
      const confirmUrl = findGoogleDriveConfirmUrl(html, responseUrl);
      if (confirmUrl) {
        response = await fetch(confirmUrl.toString(), { method: "GET", redirect: "follow" });
        if (!response.ok) throw new Error(`failed to fetch google drive confirm url: ${response.status}`);
        const finalUrl = new URL(response.url || confirmUrl.toString());
      if (detectExternalKind(response, finalUrl) === "unknown") {
        const finalType = (response.headers.get("content-type") || "").toLowerCase();
        throw new Error(`unsupported content-type after google confirm: ${finalType || "unknown"}`);
      }
      return { response, resolvedUrl: finalUrl };
      }
    }
    const refresh = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
    const nextRaw = refresh?.[1]?.trim();
    if (nextRaw) {
      const nextUrl = normalizeExternalSourceUrl(new URL(nextRaw, sourceUrl).toString());
      if (isPrivateOrLocalHost(nextUrl.hostname)) throw new Error("private/local host is not allowed");
      response = await fetch(nextUrl.toString(), { method: "GET", redirect: "follow" });
      if (!response.ok) throw new Error(`failed to fetch redirected url: ${response.status}`);
      if (detectExternalKind(response, new URL(response.url || nextUrl.toString())) === "unknown") {
        const finalType = (response.headers.get("content-type") || "").toLowerCase();
        throw new Error(`unsupported content-type: ${finalType || "unknown"}`);
      }
      return { response, resolvedUrl: new URL(response.url || nextUrl.toString()) };
    }
  }

  throw new Error(`unsupported content-type: ${firstType || "unknown"}`);
}

function buildR2Keys(albumId: string, imageId: string) {
  return {
    thumbKey: `albums/${albumId}/thumb/${imageId}.webp`,
    previewKey: `albums/${albumId}/preview/${imageId}.webp`
  };
}

function buildTextKey(albumId: string, imageId: string) {
  return `albums/${albumId}/text/${imageId}.txt`;
}

async function signR2Url(env: Env, key: string, method: "PUT" | "GET", contentType?: string): Promise<string> {
  const endpoint = env.R2_S3_ENDPOINT.replace(/\/$/, "");
  const url = `${endpoint}/${env.R2_BUCKET}/${encodeURI(key)}`;
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  const signedReq = await aws.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
  return signedReq.url;
}

async function deleteR2Object(env: Env, key: string): Promise<void> {
  const endpoint = env.R2_S3_ENDPOINT.replace(/\/$/, "");
  const url = `${endpoint}/${env.R2_BUCKET}/${encodeURI(key)}`;
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const signedReq = await aws.sign(new Request(url, { method: "DELETE" }));
  const res = await fetch(signedReq);
  if (!res.ok && res.status !== 404) {
    throw new Error(`r2 delete failed: ${res.status}`);
  }
}

async function parseJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>;
}

async function getUniqueUsername(env: Env, baseUsername: string): Promise<string> {
  const safeBase = baseUsername.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20) || "user";
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? safeBase : `${safeBase}_${i}`;
    const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(candidate).first();
    if (!exists) return candidate;
  }
  return `user_${crypto.randomUUID().slice(0, 8)}`;
}

async function exchangeGoogleCode(env: Env, code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code
    })
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
  return (await res.json()) as { access_token: string };
}

async function fetchGoogleUserProfile(accessToken: string) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`google userinfo failed: ${res.status}`);
  return (await res.json()) as { sub: string; email?: string; name?: string };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cHeaders = corsHeaders(env, req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cHeaders });
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ ok: true }, { headers: cHeaders });
    }

    try {
      if (req.method === "POST" && url.pathname === "/api/auth/register") {
        const body = await parseJson(req);
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        if (username.length < 3 || password.length < 8) {
          return badRequest(env, req, "username or password is too short");
        }
        const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
        if (existing) {
          return badRequest(env, req, "username already exists");
        }
        const id = crypto.randomUUID();
        const hashed = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, username, hashed, nowIso())
          .run();
        return json({ ok: true }, { status: 201, headers: cHeaders });
      }

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await parseJson(req);
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        const user = await env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
          .bind(username)
          .first<{ id: string; username: string; password_hash: string }>();
        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return unauthorized(env, req);
        }
        const expSec = Number(env.JWT_EXPIRES_SECONDS || "604800");
        const token = await createJwt(
          { sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + expSec },
          env.JWT_SECRET
        );
        return json(
          { ok: true, user: { id: user.id, username: user.username } },
          {
            headers: {
              ...cHeaders,
              "set-cookie": setCookie(req, env.JWT_COOKIE_NAME, token, expSec)
            }
          }
        );
      }

      if (req.method === "GET" && url.pathname === "/api/auth/google/start") {
        const state = crypto.randomUUID();
        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("prompt", "select_account");
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl.toString(),
            "set-cookie": setCookieLax(req, "myclude_oauth_state", state, 600)
          }
        });
      }

      if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateCookie = parseCookie(req, "myclude_oauth_state");
        if (!code || !state || !stateCookie || state !== stateCookie) {
          return badRequest(env, req, "invalid oauth state");
        }
        const tokens = await exchangeGoogleCode(env, code);
        const profile = await fetchGoogleUserProfile(tokens.access_token);

        let user = await env.DB.prepare("SELECT id, username FROM users WHERE google_sub = ?")
          .bind(profile.sub)
          .first<{ id: string; username: string }>();

        if (!user && profile.email) {
          user = await env.DB.prepare("SELECT id, username FROM users WHERE email = ?")
            .bind(profile.email)
            .first<{ id: string; username: string }>();
          if (user) {
            await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(profile.sub, user.id).run();
          }
        }

        if (!user) {
          const id = crypto.randomUUID();
          const usernameSeed = (profile.email?.split("@")[0] || profile.name || "google_user").trim();
          const username = await getUniqueUsername(env, usernameSeed);
          const passwordHash = await hashPassword(crypto.randomUUID());
          await env.DB.prepare(
            "INSERT INTO users (id, username, password_hash, email, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(id, username, passwordHash, profile.email ?? null, profile.sub, nowIso())
            .run();
          user = { id, username };
        }

        const expSec = Number(env.JWT_EXPIRES_SECONDS || "604800");
        const token = await createJwt(
          { sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + expSec },
          env.JWT_SECRET
        );
        return new Response(null, {
          status: 302,
          headers: {
            location: env.FRONTEND_APP_URL || env.FRONTEND_ORIGIN,
            "set-cookie": setCookie(req, env.JWT_COOKIE_NAME, token, expSec)
          }
        });
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        return json(
          { ok: true },
          {
            headers: {
              ...cHeaders,
              "set-cookie": clearCookie(req, env.JWT_COOKIE_NAME)
            }
          }
        );
      }

      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        const current = await getCurrentUser(req, env);
        if (!current) return unauthorized(env, req);
        return json({ user: { id: current.sub, username: current.username } }, { headers: cHeaders });
      }

      const publicShareMatch = url.pathname.match(/^\/api\/public\/share\/([^/]+)$/);
      if (publicShareMatch && req.method === "GET") {
        const token = publicShareMatch[1];
        const now = nowIso();
        const share = await env.DB.prepare(
          "SELECT owner_id, album_id, image_id, item_type, expires_at FROM public_item_shares WHERE token = ?"
        )
          .bind(token)
          .first<{ owner_id: string; album_id: string; image_id: string; item_type: string; expires_at: string }>();
        if (!share || share.expires_at <= now) {
          return json({ error: "share link expired or invalid" }, { status: 404, headers: cHeaders });
        }
        const item = await env.DB.prepare(
          "SELECT item_type, preview_key, content_key, content_mime, original_name FROM album_items WHERE album_id = ? AND image_id = ? AND owner_id = ?"
        )
          .bind(share.album_id, share.image_id, share.owner_id)
          .first<{
            item_type: string;
            preview_key: string;
            content_key: string | null;
            content_mime: string | null;
            original_name: string | null;
          }>();
        if (!item) return json({ error: "shared item not found" }, { status: 404, headers: cHeaders });
        if (item.item_type === "text" && item.content_key) {
          const signed = await signR2Url(env, item.content_key, "GET");
          const resp = await fetch(signed);
          if (!resp.ok) return json({ error: "failed to load shared text" }, { status: 502, headers: cHeaders });
          return new Response(resp.body, {
            status: 200,
            headers: {
              ...cHeaders,
              "content-type": item.content_mime || "text/plain; charset=utf-8",
              "cache-control": "private, max-age=60"
            }
          });
        }
        const signed = await signR2Url(env, item.preview_key, "GET");
        const resp = await fetch(signed);
        if (!resp.ok) return json({ error: "failed to load shared image" }, { status: 502, headers: cHeaders });
        return new Response(resp.body, {
          status: 200,
          headers: {
            ...cHeaders,
            "content-type": "image/webp",
            "cache-control": "private, max-age=60"
          }
        });
      }

      const current = await getCurrentUser(req, env);
      if (!current) return unauthorized(env, req);

      if (req.method === "POST" && url.pathname === "/api/external-text/fetch") {
        const body = await parseJson(req);
        const sourceUrlRaw = String(body.url ?? "").trim();
        if (!sourceUrlRaw) return badRequest(env, req, "url is required");
        let sourceUrl: URL;
        try {
          sourceUrl = normalizeExternalSourceUrl(sourceUrlRaw);
        } catch {
          return badRequest(env, req, "invalid url");
        }
        if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
          return badRequest(env, req, "only http/https url is allowed");
        }
        if (isPrivateOrLocalHost(sourceUrl.hostname)) {
          return badRequest(env, req, "private/local host is not allowed");
        }

        let res = await fetch(sourceUrl.toString(), { method: "GET", redirect: "follow" });
        if (!res.ok) return badRequest(env, req, `failed to fetch url: ${res.status}`);

        let contentType = (res.headers.get("content-type") || "").toLowerCase();
        const contentLength = Number(res.headers.get("content-length") || "0");
        const maxBytes = 3 * 1024 * 1024;
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          return badRequest(env, req, "text is too large (max 3MB)");
        }
        const allowedByType =
          contentType.includes("text/") ||
          contentType.includes("application/json") ||
          contentType.includes("application/xml") ||
          contentType.includes("application/javascript");
        const allowedByPath = /\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(sourceUrl.pathname);
        let buffer = await res.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
          return badRequest(env, req, "text is too large (max 3MB)");
        }
        let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

        if (!allowedByType && !allowedByPath) {
          // Dropbox 공유 페이지 HTML 대응: noscript refresh URL 추출 후 재시도
          if (contentType.includes("text/html")) {
            const refresh = text.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
            const nextRaw = refresh?.[1]?.trim();
            if (!nextRaw) return badRequest(env, req, `unsupported content-type: ${contentType || "unknown"}`);
            let nextUrl: URL;
            try {
              nextUrl = normalizeExternalSourceUrl(new URL(nextRaw, sourceUrl).toString());
            } catch {
              return badRequest(env, req, "failed to parse redirect url from source");
            }
            if (isPrivateOrLocalHost(nextUrl.hostname)) return badRequest(env, req, "private/local host is not allowed");
            const res2 = await fetch(nextUrl.toString(), { method: "GET", redirect: "follow" });
            if (!res2.ok) return badRequest(env, req, `failed to fetch redirected url: ${res2.status}`);
            contentType = (res2.headers.get("content-type") || "").toLowerCase();
            const buffer2 = await res2.arrayBuffer();
            if (buffer2.byteLength > maxBytes) return badRequest(env, req, "text is too large (max 3MB)");
            buffer = buffer2;
            text = new TextDecoder("utf-8", { fatal: false }).decode(buffer2);
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          } else {
            return badRequest(env, req, `unsupported content-type: ${contentType || "unknown"}`);
          }
        }

        return json(
          {
            item: {
              sourceUrl: sourceUrl.toString(),
              title: inferExternalTitle(sourceUrl),
              contentType: contentType || "text/plain",
              text
            }
          },
          { headers: cHeaders }
        );
      }

      if (req.method === "GET" && url.pathname === "/api/external-text/stream") {
        const sourceUrlRaw = String(url.searchParams.get("url") ?? "").trim();
        if (!sourceUrlRaw) return badRequest(env, req, "url is required");
        let sourceUrl: URL;
        try {
          sourceUrl = normalizeExternalSourceUrl(sourceUrlRaw);
        } catch {
          return badRequest(env, req, "invalid url");
        }
        if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
          return badRequest(env, req, "only http/https url is allowed");
        }
        if (isPrivateOrLocalHost(sourceUrl.hostname)) {
          return badRequest(env, req, "private/local host is not allowed");
        }
        try {
          const { response, resolvedUrl } = await fetchExternalResolvedTextResponse(sourceUrl);
          const title = inferExternalTitle(resolvedUrl);
          const passType = response.headers.get("content-type") || "application/octet-stream";
          const kind = detectExternalKind(response, resolvedUrl);
          const normalizedType = passType.toLowerCase().includes("application/octet-stream") && kind === "text"
            ? "text/plain; charset=utf-8"
            : passType;
          return new Response(response.body, {
            status: 200,
            headers: {
              ...cHeaders,
              "content-type": normalizedType,
              "x-external-title": title,
              "x-external-kind": kind,
              "cache-control": "no-store"
            }
          });
        } catch (err) {
          return badRequest(env, req, err instanceof Error ? err.message : "failed to load external text");
        }
      }

      if (url.pathname === "/api/users/settings") {
        if (req.method === "GET") {
          let row:
            | {
                novel_font_family: string | null;
                novel_theme: string | null;
                novel_font_size: number | null;
                novel_view_mode: string | null;
              }
            | null = null;
          try {
            row = await env.DB.prepare(
              "SELECT novel_font_family, novel_theme, novel_font_size, novel_view_mode FROM user_settings WHERE user_id = ?"
            )
              .bind(current.sub)
              .first<{
                novel_font_family: string | null;
                novel_theme: string | null;
                novel_font_size: number | null;
                novel_view_mode: string | null;
              }>();
          } catch {
            // 구버전 스키마( novel_view_mode 없음 ) 호환
            const legacy = await env.DB.prepare(
              "SELECT novel_font_family, novel_theme, novel_font_size FROM user_settings WHERE user_id = ?"
            )
              .bind(current.sub)
              .first<{
                novel_font_family: string | null;
                novel_theme: string | null;
                novel_font_size: number | null;
              }>();
            row = legacy
              ? {
                  novel_font_family: legacy.novel_font_family,
                  novel_theme: legacy.novel_theme,
                  novel_font_size: legacy.novel_font_size,
                  novel_view_mode: null
                }
              : null;
          }
          return json(
            {
              item: row
                ? {
                    novelFontFamily: row.novel_font_family ?? null,
                    novelTheme: row.novel_theme ?? null,
                    novelFontSize: row.novel_font_size ?? null,
                    novelViewMode: row.novel_view_mode === "scroll" || row.novel_view_mode === "paged" ? row.novel_view_mode : null
                  }
                : null
            },
            { headers: cHeaders }
          );
        }
        if (req.method === "POST") {
          const body = await parseJson(req);
          const familyRaw = String(body.novelFontFamily ?? "").trim();
          const themeRaw = String(body.novelTheme ?? "").trim();
          const sizeRaw = Number(body.novelFontSize ?? 0);
          const viewRaw = String(body.novelViewMode ?? "").trim();
          const novelFontFamily = familyRaw || null;
          const novelTheme = themeRaw === "dark" || themeRaw === "light" ? themeRaw : null;
          const novelFontSize = Number.isFinite(sizeRaw) && sizeRaw >= 12 && sizeRaw <= 60 ? Math.round(sizeRaw) : null;
          const novelViewMode = viewRaw === "scroll" || viewRaw === "paged" ? viewRaw : null;
          try {
            await env.DB.prepare(
              "INSERT INTO user_settings (user_id, novel_font_family, novel_theme, novel_font_size, novel_view_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET novel_font_family=excluded.novel_font_family, novel_theme=excluded.novel_theme, novel_font_size=excluded.novel_font_size, novel_view_mode=excluded.novel_view_mode, updated_at=excluded.updated_at"
            )
              .bind(current.sub, novelFontFamily, novelTheme, novelFontSize, novelViewMode, nowIso())
              .run();
          } catch {
            // 구버전 스키마( novel_view_mode 없음 ) 호환
            await env.DB.prepare(
              "INSERT INTO user_settings (user_id, novel_font_family, novel_theme, novel_font_size, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET novel_font_family=excluded.novel_font_family, novel_theme=excluded.novel_theme, novel_font_size=excluded.novel_font_size, updated_at=excluded.updated_at"
            )
              .bind(current.sub, novelFontFamily, novelTheme, novelFontSize, nowIso())
              .run();
          }
          return json({ ok: true }, { headers: cHeaders });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/albums") {
        const albums = await env.DB.prepare(
          "SELECT id, title, description, created_at, updated_at FROM albums WHERE user_id = ? ORDER BY updated_at DESC"
        )
          .bind(current.sub)
          .all();
        return json({ items: albums.results ?? [] }, { headers: cHeaders });
      }

      if (req.method === "POST" && url.pathname === "/api/share/item") {
        const body = await parseJson(req);
        const albumId = String(body.albumId ?? "").trim();
        const imageId = String(body.imageId ?? "").trim();
        if (!albumId || !imageId) return badRequest(env, req, "albumId and imageId are required");
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const item = await env.DB.prepare(
          "SELECT item_type FROM album_items WHERE album_id = ? AND image_id = ? AND owner_id = ?"
        )
          .bind(albumId, imageId, current.sub)
          .first<{ item_type: string }>();
        if (!item) return badRequest(env, req, "item not found");
        const token = crypto.randomUUID().replace(/-/g, "");
        const createdAt = nowIso();
        const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
        await env.DB.prepare(
          "INSERT INTO public_item_shares (token, owner_id, album_id, image_id, item_type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(token, current.sub, albumId, imageId, item.item_type, createdAt, expires)
          .run();
        const publicUrl = `${new URL(req.url).origin}/api/public/share/${token}`;
        return json({ token, url: publicUrl, expiresAt: expires }, { headers: cHeaders });
      }

      if (req.method === "POST" && url.pathname === "/api/albums") {
        const body = await parseJson(req);
        const title = String(body.title ?? "").trim();
        const description = String(body.description ?? "").trim();
        if (!title) return badRequest(env, req, "title is required");
        const id = crypto.randomUUID();
        const at = nowIso();
        await env.DB.prepare(
          "INSERT INTO albums (id, user_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(id, current.sub, title, description, at, at)
          .run();
        return json({ id, title, description }, { status: 201, headers: cHeaders });
      }

      const albumMatch = url.pathname.match(/^\/api\/albums\/([^/]+)$/);
      if (albumMatch) {
        const albumId = albumMatch[1];
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        if (req.method === "PATCH") {
          const body = await parseJson(req);
          const title = String(body.title ?? "").trim();
          const description = String(body.description ?? "").trim();
          if (!title) return badRequest(env, req, "title is required");
          await env.DB.prepare("UPDATE albums SET title = ?, description = ?, updated_at = ? WHERE id = ?")
            .bind(title, description, nowIso(), albumId)
            .run();
          return json({ ok: true }, { headers: cHeaders });
        }
        if (req.method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM album_items WHERE album_id = ?").bind(albumId),
            env.DB.prepare("DELETE FROM album_progress WHERE album_id = ?").bind(albumId),
            env.DB.prepare("DELETE FROM text_item_progress WHERE album_id = ?").bind(albumId),
            env.DB.prepare("DELETE FROM album_external_links WHERE album_id = ?").bind(albumId),
            env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(albumId)
          ]);
          return json({ ok: true }, { headers: cHeaders });
        }
      }

      const presignPutMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/images\/presign-put$/);
      if (presignPutMatch && req.method === "POST") {
        const albumId = presignPutMatch[1];
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const body = await parseJson(req);
        const imageId = String(body.imageId ?? crypto.randomUUID()).trim();
        const itemType = String(body.itemType ?? "image") === "text" ? "text" : "image";
        const contentType = String(body.contentType ?? "image/webp");
        const originalName = String(body.originalName ?? "").trim();
        const now = nowIso();

        if (itemType === "text") {
          const contentKey = buildTextKey(albumId, imageId);
          const contentPutUrl = await signR2Url(env, contentKey, "PUT", contentType || "text/plain");
          await env.DB.prepare(
            "INSERT OR REPLACE INTO album_items (id, album_id, owner_id, image_id, thumb_key, preview_key, item_type, content_key, content_mime, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
            .bind(
              crypto.randomUUID(),
              albumId,
              current.sub,
              imageId,
              "",
              "",
              "text",
              contentKey,
              contentType || "text/plain",
              originalName || `${imageId}.txt`,
              now
            )
            .run();
          await env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(now, albumId).run();
          return json({ imageId, itemType: "text", contentKey, contentPutUrl }, { headers: cHeaders });
        }

        const { thumbKey, previewKey } = buildR2Keys(albumId, imageId);
        const thumbPutUrl = await signR2Url(env, thumbKey, "PUT", contentType);
        const previewPutUrl = await signR2Url(env, previewKey, "PUT", contentType);
        await env.DB.prepare(
          "INSERT OR REPLACE INTO album_items (id, album_id, owner_id, image_id, thumb_key, preview_key, item_type, content_key, content_mime, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            crypto.randomUUID(),
            albumId,
            current.sub,
            imageId,
            thumbKey,
            previewKey,
            "image",
            null,
            "image/webp",
            originalName || `${imageId}.webp`,
            now
          )
          .run();
        await env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(now, albumId).run();
        return json({ imageId, itemType: "image", thumbKey, previewKey, thumbPutUrl, previewPutUrl }, { headers: cHeaders });
      }

      const albumItemsMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/items$/);
      if (albumItemsMatch && req.method === "GET") {
        const albumId = albumItemsMatch[1];
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const items = await env.DB.prepare(
          "SELECT image_id, thumb_key, preview_key, created_at, item_type, content_key, content_mime, original_name FROM album_items WHERE album_id = ? ORDER BY created_at ASC"
        )
          .bind(albumId)
          .all<{
            image_id: string;
            thumb_key: string;
            preview_key: string;
            created_at: string;
            item_type: string;
            content_key: string | null;
            content_mime: string | null;
            original_name: string | null;
          }>();
        const resolved = await Promise.all(
          (items.results ?? []).map(async (it) => {
            if (it.item_type === "text" && it.content_key) {
              return {
                imageId: it.image_id,
                itemType: "text",
                createdAt: it.created_at,
                contentMime: it.content_mime ?? "text/plain",
                originalName: it.original_name ?? `${it.image_id}.txt`,
                contentUrl: await signR2Url(env, it.content_key, "GET")
              };
            }
            return {
              imageId: it.image_id,
              itemType: "image",
              createdAt: it.created_at,
              originalName: it.original_name ?? `${it.image_id}.webp`,
              thumbUrl: await signR2Url(env, it.thumb_key, "GET"),
              previewUrl: await signR2Url(env, it.preview_key, "GET")
            };
          })
        );
        return json({ items: resolved }, { headers: cHeaders });
      }

      const externalLinksMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/external-links$/);
      if (externalLinksMatch) {
        const albumId = externalLinksMatch[1];
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        if (req.method === "GET") {
          const rows = await env.DB.prepare(
            "SELECT id, title, source_url, created_at FROM album_external_links WHERE album_id = ? ORDER BY created_at DESC"
          )
            .bind(albumId)
            .all<{ id: string; title: string; source_url: string; created_at: string }>();
          return json(
            {
              items: (rows.results ?? []).map((x) => ({
                id: x.id,
                title: x.title,
                sourceUrl: x.source_url,
                createdAt: x.created_at
              }))
            },
            { headers: cHeaders }
          );
        }
        if (req.method === "POST") {
          const body = await parseJson(req);
          const sourceUrlRaw = String(body.url ?? "").trim();
          if (!sourceUrlRaw) return badRequest(env, req, "url is required");
          let parsedUrl: URL;
          try {
            parsedUrl = normalizeExternalSourceUrl(sourceUrlRaw);
          } catch {
            return badRequest(env, req, "invalid url");
          }
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return badRequest(env, req, "only http/https url is allowed");
          }
          if (isPrivateOrLocalHost(parsedUrl.hostname)) {
            return badRequest(env, req, "private/local host is not allowed");
          }
          const titleRaw = String(body.title ?? "").trim();
          const title = titleRaw || inferExternalTitle(parsedUrl);
          const id = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO album_external_links (id, album_id, owner_id, title, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(id, albumId, current.sub, title.slice(0, 160), parsedUrl.toString(), nowIso())
            .run();
          await env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(nowIso(), albumId).run();
          return json(
            {
              item: {
                id,
                title: title.slice(0, 160),
                sourceUrl: parsedUrl.toString()
              }
            },
            { status: 201, headers: cHeaders }
          );
        }
      }

      const externalLinkDeleteMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/external-links\/([^/]+)$/);
      if (externalLinkDeleteMatch && req.method === "DELETE") {
        const [, albumId, linkId] = externalLinkDeleteMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        await env.DB.prepare("DELETE FROM album_external_links WHERE id = ? AND album_id = ?").bind(linkId, albumId).run();
        await env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(nowIso(), albumId).run();
        return json({ ok: true }, { headers: cHeaders });
      }

      const textItemProgressMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/items\/([^/]+)\/progress$/);
      if (textItemProgressMatch) {
        const [, albumId, imageId] = textItemProgressMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        if (req.method === "GET") {
          const row = await env.DB.prepare(
            "SELECT progress, updated_at FROM text_item_progress WHERE user_id = ? AND album_id = ? AND image_id = ?"
          )
            .bind(current.sub, albumId, imageId)
            .first<{ progress: number; updated_at: string }>();
          return json({ item: row ?? null }, { headers: cHeaders });
        }
        if (req.method === "POST") {
          const body = await parseJson(req);
          const progress = Number(body.progress ?? 0);
          await env.DB.prepare(
            "INSERT INTO text_item_progress (user_id, album_id, image_id, progress, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, album_id, image_id) DO UPDATE SET progress=excluded.progress, updated_at=excluded.updated_at"
          )
            .bind(current.sub, albumId, imageId, progress, nowIso())
            .run();
          return json({ ok: true }, { headers: cHeaders });
        }
      }

      const textPreviewMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/items\/([^/]+)\/text-preview$/);
      if (textPreviewMatch && req.method === "GET") {
        const [, albumId, imageId] = textPreviewMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const row = await env.DB.prepare(
          "SELECT item_type, content_key FROM album_items WHERE album_id = ? AND image_id = ?"
        )
          .bind(albumId, imageId)
          .first<{ item_type: string; content_key: string | null }>();
        if (!row || row.item_type !== "text" || !row.content_key) return badRequest(env, req, "text item not found");
        const length = Math.max(32768, Math.min(262144, Number(url.searchParams.get("length") ?? "65536")));
        const signed = await signR2Url(env, row.content_key, "GET");
        const response = await fetch(signed, { headers: { range: `bytes=0-${length - 1}` } });
        if (!response.ok) return json({ error: `text preview fetch failed: ${response.status}` }, { status: 502, headers: cHeaders });
        const totalBytes = Number(response.headers.get("content-range")?.split("/")?.[1] ?? response.headers.get("content-length") ?? "0");
        const data = await response.arrayBuffer();
        const readBytes = data.byteLength;
        const text = new TextDecoder("utf-8").decode(data);
        const nextOffset = readBytes;
        const done = totalBytes > 0 ? nextOffset >= totalBytes : readBytes < length;
        return json({ text, nextOffset, totalBytes, done }, { headers: cHeaders });
      }

      const textChunkMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/items\/([^/]+)\/text-chunk$/);
      if (textChunkMatch && req.method === "GET") {
        const [, albumId, imageId] = textChunkMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const row = await env.DB.prepare(
          "SELECT item_type, content_key FROM album_items WHERE album_id = ? AND image_id = ?"
        )
          .bind(albumId, imageId)
          .first<{ item_type: string; content_key: string | null }>();
        if (!row || row.item_type !== "text" || !row.content_key) return badRequest(env, req, "text item not found");
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
        const length = Math.max(32768, Math.min(262144, Number(url.searchParams.get("length") ?? "98304")));
        const end = offset + length - 1;
        const signed = await signR2Url(env, row.content_key, "GET");
        const response = await fetch(signed, { headers: { range: `bytes=${offset}-${end}` } });
        if (!response.ok) return json({ error: `text chunk fetch failed: ${response.status}` }, { status: 502, headers: cHeaders });
        const totalBytes = Number(response.headers.get("content-range")?.split("/")?.[1] ?? response.headers.get("content-length") ?? "0");
        const data = await response.arrayBuffer();
        const readBytes = data.byteLength;
        const text = new TextDecoder("utf-8").decode(data);
        const nextOffset = offset + readBytes;
        const done = totalBytes > 0 ? nextOffset >= totalBytes : readBytes < length;
        return json({ text, nextOffset, totalBytes, done }, { headers: cHeaders });
      }

      const itemDeleteMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/items\/([^/]+)$/);
      if (itemDeleteMatch && req.method === "DELETE") {
        const [, albumId, imageId] = itemDeleteMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const row = await env.DB.prepare(
          "SELECT thumb_key, preview_key, item_type, content_key FROM album_items WHERE album_id = ? AND image_id = ?"
        )
          .bind(albumId, imageId)
          .first<{ thumb_key: string; preview_key: string; item_type: string; content_key: string | null }>();
        if (!row) return json({ ok: true }, { headers: cHeaders });
        if (row.item_type === "text" && row.content_key) {
          await deleteR2Object(env, row.content_key);
        } else {
          await Promise.all([
            deleteR2Object(env, row.thumb_key),
            deleteR2Object(env, row.preview_key)
          ]);
        }
        await env.DB.batch([
          env.DB.prepare("DELETE FROM album_items WHERE album_id = ? AND image_id = ?").bind(albumId, imageId),
          env.DB.prepare("DELETE FROM text_item_progress WHERE album_id = ? AND image_id = ?").bind(albumId, imageId),
          env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(nowIso(), albumId)
        ]);
        return json({ ok: true }, { headers: cHeaders });
      }

      const presignGetMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/images\/([^/]+)\/presign-get$/);
      if (presignGetMatch && req.method === "GET") {
        const [, albumId, imageId] = presignGetMatch;
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        const { thumbKey, previewKey } = buildR2Keys(albumId, imageId);
        return json(
          {
            thumbGetUrl: await signR2Url(env, thumbKey, "GET"),
            previewGetUrl: await signR2Url(env, previewKey, "GET")
          },
          { headers: cHeaders }
        );
      }

      const progressMatch = url.pathname.match(/^\/api\/albums\/([^/]+)\/progress$/);
      if (progressMatch) {
        const albumId = progressMatch[1];
        if (!(await requireAlbumOwner(env, current.sub, albumId))) return unauthorized(env, req);
        if (req.method === "GET") {
          const row = await env.DB.prepare(
            "SELECT image_id, progress, updated_at FROM album_progress WHERE user_id = ? AND album_id = ?"
          )
            .bind(current.sub, albumId)
            .first<{ image_id: string; progress: number; updated_at: string }>();
          return json({ item: row ?? null }, { headers: cHeaders });
        }
        if (req.method === "POST") {
          const body = await parseJson(req);
          const imageId = String(body.imageId ?? "");
          const progress = Number(body.progress ?? 0);
          if (!imageId) return badRequest(env, req, "imageId is required");
          await env.DB.prepare(
            "INSERT INTO album_progress (user_id, album_id, image_id, progress, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, album_id) DO UPDATE SET image_id=excluded.image_id, progress=excluded.progress, updated_at=excluded.updated_at"
          )
            .bind(current.sub, albumId, imageId, progress, nowIso())
            .run();
          return json({ ok: true }, { headers: cHeaders });
        }
      }

      return json({ error: "not found" }, { status: 404, headers: cHeaders });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      return json({ error: message }, { status: 500, headers: cHeaders });
    }
  }
};
