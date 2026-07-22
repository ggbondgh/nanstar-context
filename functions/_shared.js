export const COOKIE_NAME = "__Host-context_session";
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_CAPTURE_CHARS = 120000;
export const MAX_MARKDOWN_CHARS = 200000;
export const MAX_AI_OPERATIONS = 12;

export const PROCESSING_MODES = new Set(["external_ai", "platform_rules", "manual_only"]);
export const CAPTURE_STATES = new Set(["draft", "analyzing", "review", "approved", "partial", "rejected", "failed", "archived"]);
export const KNOWLEDGE_STATUSES = new Set(["current", "historical", "archived"]);
export const OPERATION_ACTIONS = new Set(["create_document", "create_block", "append", "merge", "replace", "move", "mark_historical", "archive"]);
export const OPERATION_STATUSES = new Set(["pending", "accepted", "edited", "rejected", "superseded"]);
export const PROVIDER_TYPES = new Set(["deepseek", "volcengine", "cloudflare_ai", "openai_compatible"]);
export const ROUTE_TASKS = new Set(["organize_capture", "compress_context"]);

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers
    }
  });
}

export function requireDatabase(env) {
  return env.CONTEXT_DB || null;
}

export function missingDatabase() {
  return json({ error: "Missing D1 binding CONTEXT_DB", code: "MISSING_CONTEXT_DB" }, 500);
}

export async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) {
    const error = new Error("Request body is too large");
    error.status = 413;
    error.code = "REQUEST_TOO_LARGE";
    throw error;
  }

  if (!request.body) return {};
  try {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let source = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        const error = new Error("Request body is too large");
        error.status = 413;
        error.code = "REQUEST_TOO_LARGE";
        throw error;
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
    const body = JSON.parse(source || "{}");
    return body && typeof body === "object" ? body : {};
  } catch (cause) {
    if (cause?.code === "REQUEST_TOO_LARGE") throw cause;
    const error = new Error("Invalid JSON request body");
    error.status = 400;
    error.code = "INVALID_JSON";
    throw error;
  }
}

export function cleanString(value, maxLength = 10000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

export function cleanOptionalString(value, maxLength = 10000) {
  if (value === undefined) return undefined;
  return cleanString(value, maxLength);
}

export function cleanId(value, maxLength = 120) {
  const id = cleanString(value, maxLength);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

export function newId(prefix) {
  const safePrefix = String(prefix || "id").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "id";
  return `${safePrefix}_${crypto.randomUUID()}`;
}

export function now() {
  return Date.now();
}

export function toBoolInt(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

export function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function parseArray(value) {
  const parsed = Array.isArray(value) ? value : parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function cleanStringList(value, maxLength = 80, limit = 40) {
  return [...new Set(parseArray(value).map((entry) => cleanString(entry, maxLength)).filter(Boolean))].slice(0, limit);
}

export function normalizeTags(value) {
  return cleanStringList(value, 64, 30).map((tag) => tag.toLowerCase());
}

export function parseTags(value) {
  return parseArray(value).map((tag) => String(tag || "")).filter(Boolean);
}

export function ensureSet(value, allowed, fallback = "") {
  const normalized = cleanString(value, 64);
  return allowed.has(normalized) ? normalized : fallback;
}

export function slugify(value) {
  const raw = cleanString(value, 80).toLowerCase();
  const ascii = raw
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `cat-${crypto.randomUUID().slice(0, 8)}`;
}

export function getPathSegments(params) {
  const raw = params?.path;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return segments
    .flatMap((part) => String(part || "").split("/"))
    .map((part) => cleanString(part, 160))
    .filter(Boolean);
}

export function noContent() {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function methodNotAllowed() {
  return json({ error: "Method not allowed" }, 405, { allow: "GET, POST, PATCH, DELETE, OPTIONS" });
}

export function sameOriginOrMissing(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

export function requireSameOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  return sameOriginOrMissing(request) ? null : json({ error: "Blocked cross-origin request", code: "BAD_ORIGIN" }, 403);
}

export function getClientKey(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || request.headers.get("x-real-ip")
    || "local";
  return cleanString(forwarded.split(",")[0], 120) || "local";
}

export function getCookie(header, name) {
  const match = String(header || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : "";
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function createSessionCookie(secret) {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const nonce = crypto.randomUUID();
  const payload = `${expiresAt}.${nonce}`;
  return `${toBase64Url(payload)}.${await hmac(payload, secret)}`;
}

export async function verifySessionCookie(cookieValue, secret) {
  const [encodedPayload, signature] = String(cookieValue || "").split(".");
  if (!encodedPayload || !signature) return false;
  const payload = fromBase64Url(encodedPayload);
  const [expires] = payload.split(".");
  if (!Number.isFinite(Number(expires)) || Number(expires) <= Date.now()) return false;
  return timingSafeEqual(signature, await hmac(payload, secret));
}

export async function authorize(env, request) {
  const expected = cleanString(env.CONTEXT_AUTH_TOKEN, 4096);
  if (!expected) {
    return json({ error: "Context auth token is not configured", code: "MISSING_CONTEXT_AUTH_TOKEN" }, 503);
  }

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && await timingSafeEqual(bearer, expected)) return null;

  const session = getCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (session && await verifySessionCookie(session, expected)) return null;
  return json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
}

export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a ?? ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b ?? "")))
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(bytesToBinary(new Uint8Array(signature)));
}

export function toBase64(value) {
  return btoa(bytesToBinary(value instanceof Uint8Array ? value : new TextEncoder().encode(String(value))));
}

export function fromBase64(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  return atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}

export function bytesToBinary(bytes) {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

export function maskKey(last4) {
  return last4 ? `****${last4}` : "";
}

export function hasEncryptionKey(env) {
  return cleanString(env.AI_CONFIG_ENCRYPTION_KEY, 4096).length >= 16;
}

async function importAesKey(env) {
  const secret = cleanString(env.AI_CONFIG_ENCRYPTION_KEY, 4096);
  if (secret.length < 16) {
    const error = new Error("AI_CONFIG_ENCRYPTION_KEY is not configured");
    error.status = 503;
    error.code = "MISSING_AI_CONFIG_ENCRYPTION_KEY";
    throw error;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env, secretValue) {
  const plain = cleanString(secretValue, 4096);
  if (!plain) return { ciphertext: "", iv: "", last4: "" };
  const key = await importAesKey(env);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return {
    ciphertext: toBase64(new Uint8Array(cipher)),
    iv: toBase64(iv),
    last4: plain.slice(-4)
  };
}

export async function decryptSecret(env, ciphertext, iv) {
  if (!ciphertext || !iv) return "";
  const key = await importAesKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(plain);
}

export function safeJsonObjectFromText(value) {
  const text = String(value || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function summarize(value, maxLength = 220) {
  const normalized = stripHtml(value).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.split(/[。！？!?.\n]/).map((part) => part.trim()).filter(Boolean).slice(0, 2).join("。");
  return cleanString(sentence || normalized, maxLength);
}

export function inferTitle(value, fallback = "未命名资料") {
  const first = String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean);
  return cleanString(first || fallback, 80);
}

export function estimateTokens(text) {
  const length = String(text || "").length;
  return Math.max(1, Math.ceil(length / 3.6));
}

export function rowCategory(row) {
  return row ? { ...row } : null;
}

export function rowDocument(row) {
  return row ? { ...row, tags: parseTags(row.tags) } : null;
}

export function rowBlock(row) {
  return row ? { ...row } : null;
}

export function rowProvider(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(Number(row.enabled)),
    allow_auto_fallback: Boolean(Number(row.allow_auto_fallback)),
    api_key_masked: maskKey(row.key_last4),
    key_configured: Boolean(row.key_ciphertext && row.key_iv),
    key_ciphertext: undefined,
    key_iv: undefined
  };
}

export function rowModel(row) {
  return row ? {
    ...row,
    enabled: Boolean(Number(row.enabled)),
    supports_structured_output: Boolean(Number(row.supports_structured_output)),
    thinking_enabled: Boolean(Number(row.thinking_enabled)),
    capabilities: parseArray(row.capabilities)
  } : null;
}

export function rowProposal(row) {
  return row ? {
    ...row,
    classification: parseJson(row.classification_json, {}),
    conflicts: parseJson(row.conflicts_json, []),
    questions: parseJson(row.questions_json, []),
    warnings: parseJson(row.warnings_json, [])
  } : null;
}

export function rowPreset(row) {
  return row ? {
    ...row,
    selection: parseJson(row.selection_json, {}),
    ordering: parseJson(row.ordering_json, [])
  } : null;
}

export function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const message = status >= 500 ? "Internal server error" : cleanString(error?.message || "Request failed", 500);
  const code = cleanString(error?.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"), 80);
  if (status >= 500) {
    console.error(JSON.stringify({
      message: "api error",
      code,
      error: error instanceof Error ? error.message : String(error || "")
    }));
  }
  return json({ error: message, code }, status);
}
