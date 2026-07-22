import {
  CAPTURE_STATES,
  COOKIE_NAME,
  KNOWLEDGE_STATUSES,
  MAX_CAPTURE_CHARS,
  MAX_MARKDOWN_CHARS,
  OPERATION_ACTIONS,
  OPERATION_STATUSES,
  PROCESSING_MODES,
  PROVIDER_TYPES,
  ROUTE_TASKS,
  authorize,
  cleanId,
  cleanOptionalString,
  cleanString,
  cleanStringList,
  clearSessionCookie,
  createSessionCookie,
  encryptSecret,
  ensureSet,
  errorResponse,
  getClientKey,
  getPathSegments,
  hasEncryptionKey,
  json,
  methodNotAllowed,
  missingDatabase,
  newId,
  noContent,
  normalizeTags,
  now,
  parseArray,
  readJson,
  requireDatabase,
  requireSameOrigin,
  rowBlock,
  rowDocument,
  rowModel,
  rowPreset,
  rowProposal,
  rowProvider,
  slugify,
  summarize,
  text,
  timingSafeEqual,
  toBoolInt
} from "../_shared.js";
import {
  discoverProviderModels,
  organizeWithExternalAi,
  organizeWithRules,
  testProvider
} from "../_ai.js";
import {
  applyImport,
  buildContextPreview,
  createBackup,
  createBackupZip,
  createLibraryMarkdown,
  previewImport
} from "../_context.js";

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function fail(message, status = 400, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function required(value, label, maxLength = 10000) {
  const output = cleanString(value, maxLength);
  if (!output) fail(`${label}不能为空`, 400, "FIELD_REQUIRED");
  return output;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.round(parsed), max)) : fallback;
}

function likeValue(value) {
  return `%${cleanString(value, 160).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function downloadHeaders(filename, contentType) {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff"
  };
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function mustExist(db, table, id, options = {}) {
  const safeTables = new Set(["categories", "documents", "knowledge_blocks", "captures", "proposals", "proposal_operations", "ai_providers", "ai_models", "context_presets", "block_versions"]);
  if (!safeTables.has(table)) fail("Invalid entity type", 500, "INTERNAL_ERROR");
  const clean = cleanId(id);
  if (!clean) fail("资源不存在", 404, "NOT_FOUND");
  const hasDeletedAt = ["categories", "documents", "knowledge_blocks", "captures"].includes(table);
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?${hasDeletedAt && !options.includeDeleted ? " AND deleted_at IS NULL" : ""}`).bind(clean).first();
  if (!row) fail("资源不存在", 404, "NOT_FOUND");
  return row;
}

async function handleSession(env, db, request) {
  if (request.method === "GET") {
    const authError = await authorize(env, request);
    return json({
      authenticated: !authError,
      auth_configured: Boolean(cleanString(env.CONTEXT_AUTH_TOKEN, 4096)),
      ai_encryption_configured: hasEncryptionKey(env)
    });
  }

  const originError = requireSameOrigin(request);
  if (originError) return originError;

  if (request.method === "POST") {
    const clientKey = getClientKey(request);
    const timestamp = now();
    const attempt = await db.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(clientKey).first();
    if (Number(attempt?.locked_until) > timestamp) {
      return json({ error: "登录尝试过多，请稍后再试", code: "LOGIN_RATE_LIMITED" }, 429);
    }
    const body = await readJson(request, 16 * 1024);
    const token = cleanString(body.token, 4096);
    const expected = cleanString(env.CONTEXT_AUTH_TOKEN, 4096);
    if (!expected) return json({ error: "服务端尚未配置登录密钥", code: "MISSING_CONTEXT_AUTH_TOKEN" }, 503);
    if (!token || !(await timingSafeEqual(token, expected))) {
      const recentFailures = timestamp - Number(attempt?.last_failed_at || 0) < 15 * 60 * 1000 ? Number(attempt?.failures || 0) : 0;
      const failures = recentFailures + 1;
      const lockedUntil = failures >= 5 ? timestamp + 15 * 60 * 1000 : null;
      await db.prepare(`
        INSERT INTO login_attempts (key, failures, last_failed_at, locked_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, last_failed_at = excluded.last_failed_at, locked_until = excluded.locked_until
      `).bind(clientKey, failures, timestamp, lockedUntil).run();
      return json({ error: failures >= 5 ? "登录尝试过多，请 15 分钟后再试" : "登录密钥不正确", code: "LOGIN_FAILED" }, failures >= 5 ? 429 : 401);
    }
    await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(clientKey).run();
    const session = await createSessionCookie(expected);
    return json({ authenticated: true }, 200, {
      "set-cookie": `${COOKIE_NAME}=${session}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`
    });
  }

  if (request.method === "DELETE") {
    return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
  }
  return methodNotAllowed();
}

async function dashboard(db) {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM proposal_operations WHERE status IN ('pending','edited')"),
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_blocks WHERE deleted_at IS NULL"),
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_blocks WHERE deleted_at IS NULL AND status = 'current'"),
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_blocks WHERE deleted_at IS NULL AND status = 'historical'"),
    db.prepare(`SELECT d.id, d.title, d.summary, d.status, d.updated_at, c.name AS category_name
                  FROM documents d JOIN categories c ON c.id = d.category_id
                 WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 6`),
    db.prepare(`SELECT id, raw_text, error_code, error_message, updated_at
                  FROM captures WHERE deleted_at IS NULL AND state = 'failed' ORDER BY updated_at DESC LIMIT 5`),
    db.prepare(`SELECT m.id, m.display_name, m.model_id, p.name AS provider_name, p.health_status
                  FROM ai_routes r LEFT JOIN ai_models m ON m.id = r.default_model_id
                  LEFT JOIN ai_providers p ON p.id = m.provider_id WHERE r.task_type = 'organize_capture'`)
  ]);
  return json({
    counts: {
      pending_review: Number(results[0]?.results?.[0]?.count || 0),
      blocks: Number(results[1]?.results?.[0]?.count || 0),
      current: Number(results[2]?.results?.[0]?.count || 0),
      historical: Number(results[3]?.results?.[0]?.count || 0)
    },
    recent_documents: results[4]?.results || [],
    recent_failures: (results[5]?.results || []).map((item) => ({ ...item, raw_text: cleanString(item.raw_text, 180) })),
    default_model: results[6]?.results?.[0] || null
  });
}

async function health(env, db) {
  const started = now();
  await db.prepare("SELECT 1 AS ok").first();
  const providers = await db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM ai_providers").first();
  return json({
    ok: true,
    database: { bound: true, latency_ms: now() - started },
    secrets: {
      auth_configured: Boolean(cleanString(env.CONTEXT_AUTH_TOKEN, 4096)),
      ai_encryption_configured: hasEncryptionKey(env)
    },
    workers_ai_bound: Boolean(env.AI),
    providers: { total: Number(providers?.total || 0), enabled: Number(providers?.enabled || 0) },
    timestamp: new Date().toISOString()
  });
}

async function search(db, url) {
  const query = cleanString(url.searchParams.get("q"), 160);
  if (!query) return json({ query: "", documents: [], blocks: [], captures: [] });
  const pattern = likeValue(query);
  const categoryId = cleanId(url.searchParams.get("category_id"));
  const status = ensureSet(url.searchParams.get("status"), KNOWLEDGE_STATUSES, "");
  const docsWhere = ["d.deleted_at IS NULL", "(d.title LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')"];
  const docsBindings = [pattern, pattern, pattern];
  const blocksWhere = ["b.deleted_at IS NULL", "d.deleted_at IS NULL", "(b.heading LIKE ? ESCAPE '\\' OR b.summary LIKE ? ESCAPE '\\' OR b.body_md LIKE ? ESCAPE '\\')"];
  const blocksBindings = [pattern, pattern, pattern];
  if (categoryId) {
    docsWhere.push("d.category_id = ?"); docsBindings.push(categoryId);
    blocksWhere.push("d.category_id = ?"); blocksBindings.push(categoryId);
  }
  if (status) {
    docsWhere.push("d.status = ?"); docsBindings.push(status);
    blocksWhere.push("b.status = ?"); blocksBindings.push(status);
  }
  const [documents, blocks, captures] = await Promise.all([
    db.prepare(`SELECT d.*, c.name AS category_name FROM documents d JOIN categories c ON c.id = d.category_id WHERE ${docsWhere.join(" AND ")} ORDER BY d.updated_at DESC LIMIT 30`).bind(...docsBindings).all(),
    db.prepare(`SELECT b.id, b.document_id, b.heading, b.summary, b.body_md, b.status, b.updated_at, d.title AS document_title, c.name AS category_name FROM knowledge_blocks b JOIN documents d ON d.id = b.document_id JOIN categories c ON c.id = d.category_id WHERE ${blocksWhere.join(" AND ")} ORDER BY b.updated_at DESC LIMIT 40`).bind(...blocksBindings).all(),
    db.prepare("SELECT id, raw_text, cleaned_text, state, updated_at FROM captures WHERE deleted_at IS NULL AND (raw_text LIKE ? ESCAPE '\\' OR cleaned_text LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20").bind(pattern, pattern).all()
  ]);
  return json({
    query,
    documents: (documents.results || []).map(rowDocument),
    blocks: (blocks.results || []).map((item) => ({ ...item, body_md: cleanString(item.body_md, 500) })),
    captures: (captures.results || []).map((item) => ({ ...item, raw_text: cleanString(item.raw_text, 400), cleaned_text: cleanString(item.cleaned_text, 400) }))
  });
}

async function categoriesApi(db, request, segments) {
  if (segments.length === 1 && request.method === "GET") {
    const result = await db.prepare(`
      SELECT c.*, COUNT(DISTINCT d.id) AS document_count
        FROM categories c LEFT JOIN documents d ON d.category_id = c.id AND d.deleted_at IS NULL
       WHERE c.deleted_at IS NULL GROUP BY c.id ORDER BY c.sort_order, c.name
    `).all();
    return json({ categories: result.results || [] });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const id = newId("category");
    const timestamp = now();
    const parentId = cleanId(body.parent_id) || null;
    if (parentId) await mustExist(db, "categories", parentId);
    const name = required(body.name, "分类名称", 80);
    const mode = ensureSet(body.default_processing_mode, PROCESSING_MODES, "external_ai");
    await db.prepare(`INSERT INTO categories (id, parent_id, name, slug, description, default_processing_mode, sort_order, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, parentId, name, slugify(body.slug || name), cleanString(body.description, 500), mode, intInRange(body.sort_order, 100, 0, 100000), timestamp, timestamp).run();
    return json({ category: await mustExist(db, "categories", id) }, 201);
  }
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await mustExist(db, "categories", segments[1]);
    const body = await readJson(request);
    const parentId = body.parent_id === null || body.parent_id === "" ? null : cleanId(body.parent_id) || current.parent_id;
    if (parentId === current.id) fail("分类不能以自己为父级", 400, "INVALID_PARENT");
    if (parentId) await mustExist(db, "categories", parentId);
    const mode = body.default_processing_mode === undefined ? current.default_processing_mode : ensureSet(body.default_processing_mode, PROCESSING_MODES, current.default_processing_mode);
    await db.prepare(`UPDATE categories SET parent_id = ?, name = ?, slug = ?, description = ?, default_processing_mode = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .bind(parentId, cleanOptionalString(body.name, 80) || current.name, cleanOptionalString(body.slug, 100) ? slugify(body.slug) : current.slug,
        cleanOptionalString(body.description, 500) ?? current.description, mode, intInRange(body.sort_order, current.sort_order, 0, 100000), now(), current.id).run();
    return json({ category: await mustExist(db, "categories", current.id) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    const current = await mustExist(db, "categories", segments[1]);
    const refs = await db.prepare(`SELECT (SELECT COUNT(*) FROM categories WHERE parent_id = ? AND deleted_at IS NULL) AS children,
                                          (SELECT COUNT(*) FROM documents WHERE category_id = ? AND deleted_at IS NULL) AS documents`).bind(current.id, current.id).first();
    if (Number(refs?.children) || Number(refs?.documents)) fail("分类仍包含子分类或文档，不能删除", 409, "CATEGORY_NOT_EMPTY");
    await db.prepare("UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), current.id).run();
    return noContent();
  }
  return methodNotAllowed();
}

async function documentsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    const conditions = ["d.deleted_at IS NULL"];
    const bindings = [];
    const categoryId = cleanId(url.searchParams.get("category_id"));
    const status = ensureSet(url.searchParams.get("status"), KNOWLEDGE_STATUSES, "");
    const query = cleanString(url.searchParams.get("q"), 160);
    if (categoryId) { conditions.push("d.category_id = ?"); bindings.push(categoryId); }
    if (status) { conditions.push("d.status = ?"); bindings.push(status); }
    if (query) { const pattern = likeValue(query); conditions.push("(d.title LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')"); bindings.push(pattern, pattern, pattern); }
    const result = await db.prepare(`
      SELECT d.*, c.name AS category_name, COUNT(b.id) AS block_count
        FROM documents d JOIN categories c ON c.id = d.category_id
        LEFT JOIN knowledge_blocks b ON b.document_id = d.id AND b.deleted_at IS NULL
       WHERE ${conditions.join(" AND ")} GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 200
    `).bind(...bindings).all();
    return json({ documents: (result.results || []).map(rowDocument) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const category = await mustExist(db, "categories", body.category_id);
    const id = newId("document");
    const timestamp = now();
    const status = ensureSet(body.status, KNOWLEDGE_STATUSES, "current");
    const mode = body.processing_mode ? ensureSet(body.processing_mode, PROCESSING_MODES, null) : null;
    const titleValue = required(body.title, "文档标题", 120);
    const statements = [db.prepare(`
      INSERT INTO documents (id, category_id, title, summary, tags, status, processing_mode, valid_from, valid_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, category.id, titleValue, cleanString(body.summary, 500), JSON.stringify(normalizeTags(body.tags)), status, mode,
      numberOrNull(body.valid_from), numberOrNull(body.valid_to), timestamp, timestamp)];
    const initialBody = cleanString(body.body_md, MAX_MARKDOWN_CHARS);
    if (initialBody) {
      statements.push(db.prepare(`
        INSERT INTO knowledge_blocks (id, document_id, heading, body_md, summary, block_type, sort_order, status, processing_mode, valid_from, valid_to, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?)
      `).bind(newId("block"), id, cleanString(body.heading || titleValue, 120), initialBody, summarize(initialBody), cleanString(body.block_type || "note", 60), status, mode,
        numberOrNull(body.valid_from), numberOrNull(body.valid_to), timestamp, timestamp));
    }
    await db.batch(statements);
    return json({ document: await documentDetail(db, id) }, 201);
  }
  if (segments.length === 2 && request.method === "GET") return json({ document: await documentDetail(db, segments[1]) });
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await mustExist(db, "documents", segments[1]);
    const body = await readJson(request);
    const categoryId = cleanId(body.category_id) || current.category_id;
    if (categoryId !== current.category_id) await mustExist(db, "categories", categoryId);
    const status = body.status === undefined ? current.status : ensureSet(body.status, KNOWLEDGE_STATUSES, current.status);
    const mode = body.processing_mode === null || body.processing_mode === "" ? null : body.processing_mode === undefined ? current.processing_mode : ensureSet(body.processing_mode, PROCESSING_MODES, current.processing_mode);
    await db.prepare(`
      UPDATE documents SET category_id = ?, title = ?, summary = ?, tags = ?, status = ?, processing_mode = ?,
                           valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?
    `).bind(categoryId, cleanOptionalString(body.title, 120) || current.title, cleanOptionalString(body.summary, 500) ?? current.summary,
      body.tags === undefined ? current.tags : JSON.stringify(normalizeTags(body.tags)), status, mode,
      body.valid_from === undefined ? current.valid_from : numberOrNull(body.valid_from), body.valid_to === undefined ? current.valid_to : numberOrNull(body.valid_to), now(), current.id).run();
    return json({ document: await documentDetail(db, current.id) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    const current = await mustExist(db, "documents", segments[1]);
    const timestamp = now();
    await db.batch([
      db.prepare("UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, current.id),
      db.prepare("UPDATE knowledge_blocks SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL").bind(timestamp, timestamp, current.id)
    ]);
    return noContent();
  }
  if (segments.length === 3 && segments[2] === "blocks" && request.method === "POST") {
    const document = await mustExist(db, "documents", segments[1]);
    const body = await readJson(request);
    const id = newId("block");
    const timestamp = now();
    const bodyMd = required(body.body_md, "知识块正文", MAX_MARKDOWN_CHARS);
    const position = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM knowledge_blocks WHERE document_id = ? AND deleted_at IS NULL").bind(document.id).first();
    await db.prepare(`
      INSERT INTO knowledge_blocks (id, document_id, heading, body_md, summary, block_type, sort_order, status, processing_mode, valid_from, valid_to, source_capture_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, document.id, required(body.heading, "知识块标题", 120), bodyMd, cleanString(body.summary || summarize(bodyMd), 500), cleanString(body.block_type || "note", 60),
      intInRange(body.sort_order, Number(position?.next_order || 10), 0, 1000000), ensureSet(body.status, KNOWLEDGE_STATUSES, "current"),
      body.processing_mode ? ensureSet(body.processing_mode, PROCESSING_MODES, null) : null, numberOrNull(body.valid_from), numberOrNull(body.valid_to), cleanId(body.source_capture_id) || null, timestamp, timestamp).run();
    return json({ block: rowBlock(await mustExist(db, "knowledge_blocks", id)) }, 201);
  }
  return methodNotAllowed();
}

async function documentDetail(db, id) {
  const document = rowDocument(await mustExist(db, "documents", id));
  const blocks = await db.prepare("SELECT * FROM knowledge_blocks WHERE document_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at").bind(document.id).all();
  return { ...document, blocks: (blocks.results || []).map(rowBlock) };
}

async function nextVersionNo(db, blockId) {
  const row = await db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM block_versions WHERE block_id = ?").bind(blockId).first();
  return Number(row?.version_no || 1);
}

function versionStatement(db, block, versionNo, operationId, note) {
  return db.prepare(`
    INSERT INTO block_versions (id, block_id, version_no, heading, body_md, summary, status, proposal_operation_id, change_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(newId("version"), block.id, versionNo, block.heading, block.body_md, block.summary || "", block.status, operationId || null, cleanString(note, 500), now());
}

async function blocksApi(db, request, segments) {
  if (segments.length === 1 && request.method === "GET") {
    const result = await db.prepare(`
      SELECT b.*, d.title AS document_title, d.category_id, c.name AS category_name
        FROM knowledge_blocks b
        JOIN documents d ON d.id = b.document_id
        JOIN categories c ON c.id = d.category_id
       WHERE b.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY b.updated_at DESC LIMIT 500
    `).all();
    return json({ blocks: (result.results || []).map(rowBlock) });
  }
  const block = await mustExist(db, "knowledge_blocks", segments[1]);
  if (segments.length === 2 && request.method === "PATCH") {
    const body = await readJson(request);
    const documentId = cleanId(body.document_id) || block.document_id;
    if (documentId !== block.document_id) await mustExist(db, "documents", documentId);
    const versionNo = await nextVersionNo(db, block.id);
    const status = body.status === undefined ? block.status : ensureSet(body.status, KNOWLEDGE_STATUSES, block.status);
    const mode = body.processing_mode === null || body.processing_mode === "" ? null : body.processing_mode === undefined ? block.processing_mode : ensureSet(body.processing_mode, PROCESSING_MODES, block.processing_mode);
    const bodyMd = cleanOptionalString(body.body_md, MAX_MARKDOWN_CHARS) ?? block.body_md;
    await db.batch([
      versionStatement(db, block, versionNo, null, body.change_note || "手动编辑前的版本"),
      db.prepare(`UPDATE knowledge_blocks SET document_id = ?, heading = ?, body_md = ?, summary = ?, block_type = ?, sort_order = ?, status = ?, processing_mode = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?`)
        .bind(documentId, cleanOptionalString(body.heading, 120) || block.heading, bodyMd, cleanOptionalString(body.summary, 500) ?? summarize(bodyMd), cleanOptionalString(body.block_type, 60) || block.block_type,
          intInRange(body.sort_order, block.sort_order, 0, 1000000), status, mode, body.valid_from === undefined ? block.valid_from : numberOrNull(body.valid_from), body.valid_to === undefined ? block.valid_to : numberOrNull(body.valid_to), now(), block.id)
    ]);
    return json({ block: rowBlock(await mustExist(db, "knowledge_blocks", block.id)) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    await db.prepare("UPDATE knowledge_blocks SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), block.id).run();
    return noContent();
  }
  if (segments.length === 3 && segments[2] === "versions" && request.method === "GET") {
    const result = await db.prepare("SELECT * FROM block_versions WHERE block_id = ? ORDER BY version_no DESC").bind(block.id).all();
    return json({ block: rowBlock(block), versions: result.results || [] });
  }
  if (segments.length === 4 && segments[2] === "restore" && request.method === "POST") {
    const version = await mustExist(db, "block_versions", segments[3]);
    if (version.block_id !== block.id) fail("历史版本不属于该知识块", 400, "VERSION_MISMATCH");
    const versionNo = await nextVersionNo(db, block.id);
    await db.batch([
      versionStatement(db, block, versionNo, null, `恢复版本 ${version.version_no} 前的版本`),
      db.prepare("UPDATE knowledge_blocks SET heading = ?, body_md = ?, summary = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(version.heading, version.body_md, version.summary, version.status, now(), block.id)
    ]);
    return json({ block: rowBlock(await mustExist(db, "knowledge_blocks", block.id)) });
  }
  return methodNotAllowed();
}

async function capturesApi(env, db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    const conditions = ["c.deleted_at IS NULL"];
    const bindings = [];
    const state = ensureSet(url.searchParams.get("state"), CAPTURE_STATES, "");
    const query = cleanString(url.searchParams.get("q"), 160);
    if (state) { conditions.push("c.state = ?"); bindings.push(state); }
    if (query) { const pattern = likeValue(query); conditions.push("(c.raw_text LIKE ? ESCAPE '\\' OR c.cleaned_text LIKE ? ESCAPE '\\')"); bindings.push(pattern, pattern); }
    const result = await db.prepare(`
      SELECT c.*, cat.name AS category_name,
             (SELECT COUNT(*) FROM proposals p WHERE p.capture_id = c.id) AS proposal_count
        FROM captures c LEFT JOIN categories cat ON cat.id = c.preferred_category_id
       WHERE ${conditions.join(" AND ")} ORDER BY c.updated_at DESC LIMIT 200
    `).bind(...bindings).all();
    return json({ captures: (result.results || []).map((item) => ({ ...item, raw_text: cleanString(item.raw_text, 700), cleaned_text: cleanString(item.cleaned_text, 700) })) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const rawText = required(body.raw_text, "原始输入", MAX_CAPTURE_CHARS);
    const preferredCategoryId = cleanId(body.preferred_category_id) || null;
    const requestedModelId = cleanId(body.requested_model_id) || null;
    if (preferredCategoryId) await mustExist(db, "categories", preferredCategoryId);
    if (requestedModelId) await mustExist(db, "ai_models", requestedModelId);
    const id = newId("capture");
    const timestamp = now();
    const mode = ensureSet(body.processing_mode, PROCESSING_MODES, "external_ai");
    await db.prepare(`
      INSERT INTO captures (id, raw_text, preferred_category_id, processing_mode, requested_model_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
    `).bind(id, rawText, preferredCategoryId, mode, requestedModelId, timestamp, timestamp).run();
    const capture = await mustExist(db, "captures", id);
    if (body.organize === true) {
      const proposalId = await organizeCapture(env, db, capture);
      return json({ capture: await captureDetail(db, id), proposal_id: proposalId }, 201);
    }
    return json({ capture }, 201);
  }
  if (segments.length === 2 && request.method === "GET") return json({ capture: await captureDetail(db, segments[1]) });
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await mustExist(db, "captures", segments[1]);
    const body = await readJson(request);
    const preferredCategoryId = body.preferred_category_id === null || body.preferred_category_id === "" ? null : cleanId(body.preferred_category_id) || current.preferred_category_id;
    const requestedModelId = body.requested_model_id === null || body.requested_model_id === "" ? null : cleanId(body.requested_model_id) || current.requested_model_id;
    if (preferredCategoryId && preferredCategoryId !== current.preferred_category_id) await mustExist(db, "categories", preferredCategoryId);
    if (requestedModelId && requestedModelId !== current.requested_model_id) await mustExist(db, "ai_models", requestedModelId);
    const state = body.state === undefined ? current.state : ensureSet(body.state, CAPTURE_STATES, current.state);
    const mode = body.processing_mode === undefined ? current.processing_mode : ensureSet(body.processing_mode, PROCESSING_MODES, current.processing_mode);
    await db.prepare(`UPDATE captures SET raw_text = ?, preferred_category_id = ?, processing_mode = ?, requested_model_id = ?, state = ?, updated_at = ? WHERE id = ?`)
      .bind(cleanOptionalString(body.raw_text, MAX_CAPTURE_CHARS) || current.raw_text, preferredCategoryId, mode, requestedModelId, state, now(), current.id).run();
    return json({ capture: await captureDetail(db, current.id) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    const current = await mustExist(db, "captures", segments[1]);
    await db.prepare("UPDATE captures SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), current.id).run();
    return noContent();
  }
  if (segments.length === 3 && ["organize", "retry"].includes(segments[2]) && request.method === "POST") {
    const capture = await mustExist(db, "captures", segments[1]);
    const body = await readJson(request);
    if (body.processing_mode) capture.processing_mode = ensureSet(body.processing_mode, PROCESSING_MODES, capture.processing_mode);
    if (body.requested_model_id !== undefined) capture.requested_model_id = cleanId(body.requested_model_id) || null;
    if (capture.requested_model_id) await mustExist(db, "ai_models", capture.requested_model_id);
    await db.prepare("UPDATE captures SET processing_mode = ?, requested_model_id = ?, updated_at = ? WHERE id = ?")
      .bind(capture.processing_mode, capture.requested_model_id, now(), capture.id).run();
    const proposalId = await organizeCapture(env, db, capture);
    return json({ capture: await captureDetail(db, capture.id), proposal_id: proposalId });
  }
  return methodNotAllowed();
}

async function organizeCapture(env, db, capture) {
  if (!capture.raw_text) fail("原始输入为空", 400, "CAPTURE_EMPTY");
  await db.prepare("UPDATE proposals SET status = 'superseded', updated_at = ? WHERE capture_id = ? AND status = 'pending'").bind(now(), capture.id).run();
  await db.prepare("UPDATE captures SET state = 'analyzing', error_code = '', error_message = '', updated_at = ? WHERE id = ?").bind(now(), capture.id).run();
  try {
    if (capture.processing_mode === "manual_only") return await organizeWithRules(db, capture, true);
    if (capture.processing_mode === "platform_rules") return await organizeWithRules(db, capture, false);
    return await organizeWithExternalAi(env, db, capture);
  } catch (error) {
    await db.prepare("UPDATE captures SET state = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
      .bind(cleanString(error?.code || "ORGANIZE_FAILED", 80), cleanString(error?.message || "整理失败", 300), now(), capture.id).run();
    throw error;
  }
}

async function captureDetail(db, id) {
  const capture = await mustExist(db, "captures", id);
  const [proposals, runs] = await Promise.all([
    db.prepare(`
      SELECT p.*, pr.name AS provider_name, m.display_name AS model_name, m.model_id AS provider_model_id
        FROM proposals p LEFT JOIN ai_providers pr ON pr.id = p.provider_id LEFT JOIN ai_models m ON m.id = p.model_id
       WHERE p.capture_id = ? ORDER BY p.created_at DESC
    `).bind(capture.id).all(),
    db.prepare(`SELECT r.*, p.name AS provider_name, m.display_name AS model_name FROM ai_runs r
                LEFT JOIN ai_providers p ON p.id = r.provider_id LEFT JOIN ai_models m ON m.id = r.model_id
                WHERE r.capture_id = ? ORDER BY r.created_at DESC LIMIT 30`).bind(capture.id).all()
  ]);
  return { ...capture, proposals: (proposals.results || []).map(rowProposal), ai_runs: runs.results || [] };
}

async function proposalsApi(db, request, segments, url) {
  if (segments.length === 1 && request.method === "GET") {
    const status = cleanString(url.searchParams.get("status"), 40);
    const conditions = status ? "WHERE p.status = ?" : "";
    const result = await db.prepare(`
      SELECT p.*, c.raw_text, c.processing_mode, c.state AS capture_state,
             pr.name AS provider_name, m.display_name AS model_name,
             SUM(CASE WHEN o.status IN ('pending','edited') THEN 1 ELSE 0 END) AS pending_operations,
             COUNT(o.id) AS operation_count
        FROM proposals p JOIN captures c ON c.id = p.capture_id
        LEFT JOIN ai_providers pr ON pr.id = p.provider_id LEFT JOIN ai_models m ON m.id = p.model_id
        LEFT JOIN proposal_operations o ON o.proposal_id = p.id
        ${conditions} GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 200
    `).bind(...(status ? [status] : [])).all();
    return json({ proposals: (result.results || []).map((item) => ({ ...rowProposal(item), raw_text: cleanString(item.raw_text, 600) })) });
  }
  if (segments.length === 2 && request.method === "GET") return json({ proposal: await proposalDetail(db, segments[1]) });
  if (segments.length === 3 && segments[2] === "apply" && request.method === "POST") {
    const body = await readJson(request);
    return json(await applyProposal(db, segments[1], parseArray(body.operation_ids).map(cleanId).filter(Boolean)));
  }
  if (segments.length === 3 && segments[2] === "reject" && request.method === "POST") {
    const proposal = await mustExist(db, "proposals", segments[1]);
    const timestamp = now();
    await db.batch([
      db.prepare("UPDATE proposal_operations SET status = 'rejected', reviewed_at = ? WHERE proposal_id = ? AND status IN ('pending','edited')").bind(timestamp, proposal.id),
      db.prepare("UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ?").bind(timestamp, proposal.id),
      db.prepare("UPDATE captures SET state = 'rejected', updated_at = ? WHERE id = ?").bind(timestamp, proposal.capture_id)
    ]);
    return json({ proposal: await proposalDetail(db, proposal.id) });
  }
  return methodNotAllowed();
}

async function proposalDetail(db, id) {
  const proposal = rowProposal(await mustExist(db, "proposals", id));
  const [capture, operations] = await Promise.all([
    mustExist(db, "captures", proposal.capture_id, { includeDeleted: true }),
    db.prepare(`
      SELECT o.*, c.name AS target_category_name, d.title AS target_document_title,
             b.heading AS target_block_heading, b.body_md AS current_body_md
        FROM proposal_operations o
        LEFT JOIN categories c ON c.id = o.target_category_id
        LEFT JOIN documents d ON d.id = o.target_document_id
        LEFT JOIN knowledge_blocks b ON b.id = o.target_block_id
       WHERE o.proposal_id = ? ORDER BY o.sort_order
    `).bind(proposal.id).all()
  ]);
  return { ...proposal, capture, operations: operations.results || [] };
}

async function proposalOperationApi(db, request, segments) {
  if (segments.length !== 2 || request.method !== "PATCH") return methodNotAllowed();
  const current = await mustExist(db, "proposal_operations", segments[1]);
  if (!["pending", "edited"].includes(current.status)) fail("该操作已经完成，不能再编辑", 409, "OPERATION_ALREADY_REVIEWED");
  const body = await readJson(request);
  const action = body.action === undefined ? current.action : ensureSet(body.action, OPERATION_ACTIONS, current.action);
  const categoryId = body.target_category_id === null || body.target_category_id === "" ? null : cleanId(body.target_category_id) || current.target_category_id;
  const documentId = body.target_document_id === null || body.target_document_id === "" ? null : cleanId(body.target_document_id) || current.target_document_id;
  const blockId = body.target_block_id === null || body.target_block_id === "" ? null : cleanId(body.target_block_id) || current.target_block_id;
  if (categoryId) await mustExist(db, "categories", categoryId);
  if (documentId) await mustExist(db, "documents", documentId);
  if (blockId) await mustExist(db, "knowledge_blocks", blockId);
  const requestedStatus = body.status === undefined ? "edited" : ensureSet(body.status, OPERATION_STATUSES, "edited");
  if (!["pending", "edited", "rejected"].includes(requestedStatus)) fail("不能把操作设为该状态", 400, "INVALID_OPERATION_STATUS");
  await db.prepare(`
    UPDATE proposal_operations SET action = ?, target_category_id = ?, target_document_id = ?, target_block_id = ?,
      proposed_title = ?, proposed_heading = ?, proposed_body_md = ?, reason = ?, status = ?, reviewed_at = ? WHERE id = ?
  `).bind(action, categoryId, documentId, blockId, cleanOptionalString(body.proposed_title, 120) ?? current.proposed_title,
    cleanOptionalString(body.proposed_heading, 120) ?? current.proposed_heading,
    cleanOptionalString(body.proposed_body_md, MAX_MARKDOWN_CHARS) ?? current.proposed_body_md,
    cleanOptionalString(body.reason, 500) ?? current.reason, requestedStatus,
    requestedStatus === "rejected" ? now() : null, current.id).run();
  return json({ operation: await mustExist(db, "proposal_operations", current.id) });
}

async function applyProposal(db, proposalId, selectedIds) {
  const proposal = await mustExist(db, "proposals", proposalId);
  if (!["pending", "edited"].includes(proposal.status)) fail("该提案已经处理", 409, "PROPOSAL_ALREADY_REVIEWED");
  const operationRows = await db.prepare("SELECT * FROM proposal_operations WHERE proposal_id = ? ORDER BY sort_order").bind(proposal.id).all();
  const allOperations = operationRows.results || [];
  const selected = allOperations.filter((operation) => ["pending", "edited"].includes(operation.status) && (!selectedIds.length || selectedIds.includes(operation.id)));
  if (!selected.length) fail("没有可接受的操作", 400, "NO_OPERATIONS_SELECTED");

  const timestamp = now();
  const statements = [];
  const writes = [];
  for (const operation of selected) {
    let categoryId = cleanId(operation.target_category_id) || "cat_inbox";
    const category = await db.prepare("SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL").bind(categoryId).first();
    if (!category) categoryId = "cat_inbox";

    if (operation.action === "create_document") {
      const documentId = newId("document");
      const blockId = newId("block");
      const titleValue = cleanString(operation.proposed_title || operation.proposed_heading, 120) || "未命名资料";
      statements.push(
        db.prepare(`INSERT INTO documents (id, category_id, title, summary, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'current', ?, ?)`)
          .bind(documentId, categoryId, titleValue, summarize(operation.proposed_body_md), timestamp, timestamp),
        db.prepare(`INSERT INTO knowledge_blocks (id, document_id, heading, body_md, summary, block_type, sort_order, status, source_capture_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'note', 10, 'current', ?, ?, ?)`)
          .bind(blockId, documentId, cleanString(operation.proposed_heading, 120) || titleValue, operation.proposed_body_md, summarize(operation.proposed_body_md), proposal.capture_id, timestamp, timestamp)
      );
      writes.push({ action: operation.action, document_id: documentId, block_id: blockId, title: titleValue });
    } else if (operation.action === "create_block") {
      const document = operation.target_document_id ? await mustExist(db, "documents", operation.target_document_id) : null;
      if (!document) fail("新建知识块需要选择目标文档", 409, "TARGET_DOCUMENT_REQUIRED");
      const blockId = newId("block");
      const order = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM knowledge_blocks WHERE document_id = ? AND deleted_at IS NULL").bind(document.id).first();
      statements.push(db.prepare(`INSERT INTO knowledge_blocks (id, document_id, heading, body_md, summary, block_type, sort_order, status, source_capture_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'note', ?, 'current', ?, ?, ?)`)
        .bind(blockId, document.id, cleanString(operation.proposed_heading, 120) || "未命名知识块", operation.proposed_body_md, summarize(operation.proposed_body_md), Number(order?.next_order || 10), proposal.capture_id, timestamp, timestamp));
      statements.push(db.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(timestamp, document.id));
      writes.push({ action: operation.action, document_id: document.id, block_id: blockId, title: operation.proposed_heading });
    } else if (["append", "merge", "replace", "move", "mark_historical", "archive"].includes(operation.action)) {
      if (operation.target_block_id) {
        const block = await mustExist(db, "knowledge_blocks", operation.target_block_id);
        if (Number(block.updated_at) > Number(proposal.created_at)) fail(`知识块“${block.heading}”在提案后已被修改，请重新整理`, 409, "TARGET_CHANGED");
        statements.push(versionStatement(db, block, await nextVersionNo(db, block.id), operation.id, operation.reason || `应用提案：${operation.action}`));
        if (["append", "merge", "replace"].includes(operation.action)) {
          const nextBody = operation.action === "append" ? `${block.body_md}\n\n${operation.proposed_body_md}`.trim() : operation.proposed_body_md;
          statements.push(db.prepare("UPDATE knowledge_blocks SET heading = ?, body_md = ?, summary = ?, source_capture_id = ?, updated_at = ? WHERE id = ?")
            .bind(cleanString(operation.proposed_heading, 120) || block.heading, nextBody, summarize(nextBody), proposal.capture_id, timestamp, block.id));
        } else if (operation.action === "move") {
          const targetDocument = await mustExist(db, "documents", operation.target_document_id);
          statements.push(db.prepare("UPDATE knowledge_blocks SET document_id = ?, updated_at = ? WHERE id = ?").bind(targetDocument.id, timestamp, block.id));
        } else {
          const nextStatus = operation.action === "archive" ? "archived" : "historical";
          statements.push(db.prepare("UPDATE knowledge_blocks SET status = ?, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?").bind(nextStatus, timestamp, timestamp, block.id));
        }
        writes.push({ action: operation.action, document_id: block.document_id, block_id: block.id, title: block.heading });
      } else if (operation.target_document_id && ["mark_historical", "archive"].includes(operation.action)) {
        const document = await mustExist(db, "documents", operation.target_document_id);
        const nextStatus = operation.action === "archive" ? "archived" : "historical";
        statements.push(
          db.prepare("UPDATE documents SET status = ?, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?").bind(nextStatus, timestamp, timestamp, document.id),
          db.prepare("UPDATE knowledge_blocks SET status = ?, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE document_id = ? AND deleted_at IS NULL").bind(nextStatus, timestamp, timestamp, document.id)
        );
        writes.push({ action: operation.action, document_id: document.id, block_id: null, title: document.title });
      } else {
        fail("该操作缺少有效目标", 409, "TARGET_REQUIRED");
      }
    }
    statements.push(db.prepare("UPDATE proposal_operations SET status = CASE WHEN status = 'edited' THEN 'edited' ELSE 'accepted' END, reviewed_at = ? WHERE id = ?").bind(timestamp, operation.id));
  }

  const remainingIds = allOperations.filter((operation) => !selected.some((item) => item.id === operation.id));
  const willRemainPending = remainingIds.some((operation) => ["pending", "edited"].includes(operation.status));
  const hasRejected = remainingIds.some((operation) => operation.status === "rejected");
  const hasEdited = selected.some((operation) => operation.status === "edited");
  const proposalStatus = willRemainPending ? "pending" : hasEdited ? "edited" : "accepted";
  const captureState = willRemainPending || hasRejected ? "partial" : "approved";
  statements.push(
    db.prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").bind(proposalStatus, timestamp, proposal.id),
    db.prepare("UPDATE captures SET state = ?, updated_at = ? WHERE id = ?").bind(captureState, timestamp, proposal.capture_id)
  );
  await db.batch(statements);
  return { ok: true, writes, proposal: await proposalDetail(db, proposal.id) };
}

function providerDefaultBaseUrl(type) {
  if (type === "deepseek") return "https://api.deepseek.com";
  if (type === "volcengine") return "https://ark.cn-beijing.volces.com/api/v3";
  if (type === "openai_compatible") return "https://api.openai.com/v1";
  return "";
}

function providerSetupError(error) {
  if (error?.code) fail(cleanString(error.message, 500), 400, cleanString(error.code, 80));
  throw error;
}

async function providersApi(env, db, request, segments) {
  if (segments.length === 3 && request.method === "GET") {
    const result = await db.prepare("SELECT * FROM ai_providers ORDER BY created_at").all();
    return json({ providers: (result.results || []).map(rowProvider), encryption_configured: hasEncryptionKey(env), workers_ai_bound: Boolean(env.AI) });
  }
  if (segments.length === 3 && request.method === "POST") {
    const body = await readJson(request);
    const providerType = ensureSet(body.provider_type, PROVIDER_TYPES, "openai_compatible");
    const id = newId("provider");
    const timestamp = now();
    const name = required(body.name || providerType, "服务商名称", 100);
    const baseUrl = cleanString(body.base_url || providerDefaultBaseUrl(providerType), 500);
    let encrypted = { ciphertext: "", iv: "", last4: "" };
    if (cleanString(body.api_key, 4096)) {
      if (!hasEncryptionKey(env)) fail("系统尚未配置 AI_CONFIG_ENCRYPTION_KEY，不能保存 API Key", 503, "MISSING_AI_CONFIG_ENCRYPTION_KEY");
      encrypted = await encryptSecret(env, body.api_key);
    }
    await db.prepare(`
      INSERT INTO ai_providers (id, provider_type, name, base_url, key_ciphertext, key_iv, key_last4, enabled, allow_auto_fallback, health_status, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
    `).bind(id, providerType, name, baseUrl, encrypted.ciphertext, encrypted.iv, encrypted.last4, toBoolInt(body.enabled, 1), toBoolInt(body.allow_auto_fallback, 1), intInRange(body.timeout_ms, 30000, 3000, 120000), timestamp, timestamp).run();
    return json({ provider: rowProvider(await mustExist(db, "ai_providers", id)) }, 201);
  }
  if (segments.length === 4 && segments[3] === "discover" && request.method === "POST") {
    const body = await readJson(request);
    const providerType = ensureSet(body.provider_type, PROVIDER_TYPES, "openai_compatible");
    const provider = {
      provider_type: providerType,
      base_url: cleanString(body.base_url || providerDefaultBaseUrl(providerType), 500),
      timeout_ms: intInRange(body.timeout_ms, 30000, 3000, 120000)
    };
    try {
      const models = await discoverProviderModels(env, provider, body.api_key);
      return json({ models, count: models.length });
    } catch (error) {
      providerSetupError(error);
    }
  }
  if (segments.length === 4 && request.method === "PATCH") {
    const current = await mustExist(db, "ai_providers", segments[3]);
    const body = await readJson(request);
    let ciphertext = current.key_ciphertext;
    let iv = current.key_iv;
    let last4 = current.key_last4;
    if (body.clear_api_key === true) {
      ciphertext = ""; iv = ""; last4 = "";
    } else if (cleanString(body.api_key, 4096)) {
      if (!hasEncryptionKey(env)) fail("系统尚未配置 AI_CONFIG_ENCRYPTION_KEY，不能保存 API Key", 503, "MISSING_AI_CONFIG_ENCRYPTION_KEY");
      const encrypted = await encryptSecret(env, body.api_key);
      ciphertext = encrypted.ciphertext; iv = encrypted.iv; last4 = encrypted.last4;
    }
    const providerType = body.provider_type === undefined ? current.provider_type : ensureSet(body.provider_type, PROVIDER_TYPES, current.provider_type);
    await db.prepare(`UPDATE ai_providers SET provider_type = ?, name = ?, base_url = ?, key_ciphertext = ?, key_iv = ?, key_last4 = ?, enabled = ?, allow_auto_fallback = ?, timeout_ms = ?, updated_at = ? WHERE id = ?`)
      .bind(providerType, cleanOptionalString(body.name, 100) || current.name, cleanOptionalString(body.base_url, 500) || current.base_url, ciphertext, iv, last4,
        body.enabled === undefined ? current.enabled : toBoolInt(body.enabled), body.allow_auto_fallback === undefined ? current.allow_auto_fallback : toBoolInt(body.allow_auto_fallback),
        intInRange(body.timeout_ms, current.timeout_ms, 3000, 120000), now(), current.id).run();
    return json({ provider: rowProvider(await mustExist(db, "ai_providers", current.id)) });
  }
  if (segments.length === 4 && request.method === "DELETE") {
    const provider = await mustExist(db, "ai_providers", segments[3]);
    const modelCount = await db.prepare("SELECT COUNT(*) AS count FROM ai_models WHERE provider_id = ?").bind(provider.id).first();
    if (Number(modelCount?.count)) fail("该服务商仍有模型，删除前请先删除模型", 409, "PROVIDER_HAS_MODELS");
    await db.prepare("DELETE FROM ai_providers WHERE id = ?").bind(provider.id).run();
    return noContent();
  }
  if (segments.length === 5 && segments[4] === "test" && request.method === "POST") {
    const provider = await mustExist(db, "ai_providers", segments[3]);
    try {
      const result = await testProvider(env, provider);
      await db.prepare("UPDATE ai_providers SET health_status = 'healthy', last_checked_at = ?, last_error = '', updated_at = ? WHERE id = ?").bind(now(), now(), provider.id).run();
      return json(result);
    } catch (error) {
      await db.prepare("UPDATE ai_providers SET health_status = 'error', last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?").bind(now(), cleanString(error?.message, 300), now(), provider.id).run();
      providerSetupError(error);
    }
  }
  if (segments.length === 6 && segments[4] === "models" && segments[5] === "sync" && request.method === "POST") {
    const provider = await mustExist(db, "ai_providers", segments[3]);
    let discoveredModels;
    try {
      discoveredModels = await discoverProviderModels(env, provider);
    } catch (error) {
      providerSetupError(error);
    }
    const modelIds = discoveredModels.map((model) => model.id);
    const currentModels = await db.prepare("SELECT model_id FROM ai_models WHERE provider_id = ?").bind(provider.id).all();
    const existing = new Set((currentModels.results || []).map((item) => item.model_id));
    const timestamp = now();
    const statements = discoveredModels.filter((model) => !existing.has(model.id)).map((model) => db.prepare(`
      INSERT INTO ai_models (id, provider_id, model_id, display_name, enabled, supports_structured_output, thinking_enabled, cost_level, capabilities, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, 0, 'unknown', '[]', '', ?, ?)
    `).bind(newId("model"), provider.id, model.id, model.display_name || model.id, timestamp, timestamp));
    if (statements.length) await db.batch(statements.slice(0, 100));
    return json({ model_ids: modelIds, created: Math.min(statements.length, 100) });
  }
  return methodNotAllowed();
}

async function modelsApi(db, request, segments, url) {
  if (segments.length === 3 && request.method === "GET") {
    const providerId = cleanId(url.searchParams.get("provider_id"));
    const rows = providerId
      ? await db.prepare("SELECT m.*, p.name AS provider_name, p.provider_type FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id WHERE p.id = ? ORDER BY m.created_at").bind(providerId).all()
      : await db.prepare("SELECT m.*, p.name AS provider_name, p.provider_type FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id ORDER BY m.created_at").all();
    return json({ models: (rows.results || []).map(rowModel) });
  }
  if (segments.length === 3 && request.method === "POST") {
    const body = await readJson(request);
    const provider = await mustExist(db, "ai_providers", body.provider_id);
    const modelId = required(body.model_id, "模型 ID", 200);
    const id = newId("model");
    const timestamp = now();
    await db.prepare(`
      INSERT INTO ai_models (id, provider_id, model_id, display_name, enabled, supports_structured_output, thinking_enabled, cost_level, input_price, output_price, price_currency, context_limit, max_output_tokens, capabilities, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, provider.id, modelId, cleanString(body.display_name || modelId, 160), toBoolInt(body.enabled, 1), toBoolInt(body.supports_structured_output, 1), toBoolInt(body.thinking_enabled), ensureSet(body.cost_level, new Set(["free", "low", "medium", "high", "unknown"]), "unknown"),
      numberOrNull(body.input_price), numberOrNull(body.output_price), cleanString(body.price_currency, 16), numberOrNull(body.context_limit), numberOrNull(body.max_output_tokens), JSON.stringify(cleanStringList(body.capabilities, 80, 30)), cleanString(body.notes, 500), timestamp, timestamp).run();
    return json({ model: rowModel(await mustExist(db, "ai_models", id)) }, 201);
  }
  if (segments.length === 4 && request.method === "PATCH") {
    const current = await mustExist(db, "ai_models", segments[3]);
    const body = await readJson(request);
    const providerId = cleanId(body.provider_id) || current.provider_id;
    if (providerId !== current.provider_id) await mustExist(db, "ai_providers", providerId);
    await db.prepare(`UPDATE ai_models SET provider_id = ?, model_id = ?, display_name = ?, enabled = ?, supports_structured_output = ?, thinking_enabled = ?, cost_level = ?, input_price = ?, output_price = ?, price_currency = ?, context_limit = ?, max_output_tokens = ?, capabilities = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .bind(providerId, cleanOptionalString(body.model_id, 200) || current.model_id, cleanOptionalString(body.display_name, 160) || current.display_name,
        body.enabled === undefined ? current.enabled : toBoolInt(body.enabled), body.supports_structured_output === undefined ? current.supports_structured_output : toBoolInt(body.supports_structured_output), body.thinking_enabled === undefined ? current.thinking_enabled : toBoolInt(body.thinking_enabled),
        body.cost_level === undefined ? current.cost_level : ensureSet(body.cost_level, new Set(["free", "low", "medium", "high", "unknown"]), current.cost_level), body.input_price === undefined ? current.input_price : numberOrNull(body.input_price), body.output_price === undefined ? current.output_price : numberOrNull(body.output_price), cleanOptionalString(body.price_currency, 16) ?? current.price_currency,
        body.context_limit === undefined ? current.context_limit : numberOrNull(body.context_limit), body.max_output_tokens === undefined ? current.max_output_tokens : numberOrNull(body.max_output_tokens), body.capabilities === undefined ? current.capabilities : JSON.stringify(cleanStringList(body.capabilities, 80, 30)), cleanOptionalString(body.notes, 500) ?? current.notes, now(), current.id).run();
    return json({ model: rowModel(await mustExist(db, "ai_models", current.id)) });
  }
  if (segments.length === 4 && request.method === "DELETE") {
    const current = await mustExist(db, "ai_models", segments[3]);
    const refs = await db.prepare("SELECT (SELECT COUNT(*) FROM ai_routes WHERE default_model_id = ? OR fallback_model_ids LIKE ?) AS route_count").bind(current.id, `%${current.id}%`).first();
    if (Number(refs?.route_count)) fail("该模型正在模型路由中使用，请先移出路由", 409, "MODEL_IN_USE");
    await db.prepare("DELETE FROM ai_models WHERE id = ?").bind(current.id).run();
    return noContent();
  }
  return methodNotAllowed();
}

async function routesApi(db, request, segments) {
  if (segments.length === 3 && request.method === "GET") {
    const result = await db.prepare(`SELECT r.*, m.display_name AS default_model_name FROM ai_routes r LEFT JOIN ai_models m ON m.id = r.default_model_id ORDER BY r.task_type`).all();
    return json({ routes: (result.results || []).map((row) => ({ ...row, fallback_model_ids: parseArray(row.fallback_model_ids), allow_cross_provider: Boolean(Number(row.allow_cross_provider)) })) });
  }
  if (segments.length === 4 && request.method === "PATCH") {
    const taskType = cleanString(segments[3], 60);
    if (!ROUTE_TASKS.has(taskType)) fail("未知的 AI 任务类型", 400, "INVALID_ROUTE_TASK");
    const current = await db.prepare("SELECT * FROM ai_routes WHERE task_type = ?").bind(taskType).first();
    if (!current) fail("路由不存在", 404, "NOT_FOUND");
    const body = await readJson(request);
    const defaultModelId = body.default_model_id === null || body.default_model_id === "" ? null : cleanId(body.default_model_id) || current.default_model_id;
    if (defaultModelId) await mustExist(db, "ai_models", defaultModelId);
    const fallback = body.fallback_model_ids === undefined ? parseArray(current.fallback_model_ids) : [...new Set(parseArray(body.fallback_model_ids).map(cleanId).filter(Boolean))].slice(0, 10);
    for (const modelId of fallback) await mustExist(db, "ai_models", modelId);
    await db.prepare(`UPDATE ai_routes SET default_model_id = ?, fallback_model_ids = ?, timeout_ms = ?, max_retries = ?, allow_cross_provider = ?, max_input_chars = ?, max_output_tokens = ?, updated_at = ? WHERE task_type = ?`)
      .bind(defaultModelId, JSON.stringify(fallback), intInRange(body.timeout_ms, current.timeout_ms, 3000, 120000), intInRange(body.max_retries, current.max_retries, 0, 2), body.allow_cross_provider === undefined ? current.allow_cross_provider : toBoolInt(body.allow_cross_provider), intInRange(body.max_input_chars, current.max_input_chars, 4000, 100000), intInRange(body.max_output_tokens, current.max_output_tokens, 200, 8000), now(), taskType).run();
    return json({ route: await db.prepare("SELECT * FROM ai_routes WHERE task_type = ?").bind(taskType).first() });
  }
  return methodNotAllowed();
}

async function aiRunsApi(db, request, segments, url) {
  if (segments.length !== 3 || request.method !== "GET") return methodNotAllowed();
  const limit = intInRange(url.searchParams.get("limit"), 50, 1, 200);
  const result = await db.prepare(`SELECT r.*, p.name AS provider_name, m.display_name AS model_name FROM ai_runs r LEFT JOIN ai_providers p ON p.id = r.provider_id LEFT JOIN ai_models m ON m.id = r.model_id ORDER BY r.created_at DESC LIMIT ${limit}`).all();
  return json({ runs: result.results || [] });
}

async function presetsApi(db, request, segments) {
  if (segments.length === 1 && request.method === "GET") {
    const result = await db.prepare("SELECT * FROM context_presets ORDER BY updated_at DESC").all();
    return json({ presets: (result.results || []).map(rowPreset) });
  }
  if (segments.length === 1 && request.method === "POST") {
    const body = await readJson(request);
    const id = newId("preset");
    const timestamp = now();
    const mode = ["full", "compact", "custom"].includes(body.mode) ? body.mode : "full";
    await db.prepare(`INSERT INTO context_presets (id, name, description, selection_json, ordering_json, mode, token_budget, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, required(body.name, "预设名称", 120), cleanString(body.description, 500), JSON.stringify(body.selection && typeof body.selection === "object" ? body.selection : {}), JSON.stringify(parseArray(body.ordering).map(cleanId).filter(Boolean).slice(0, 800)), mode, numberOrNull(body.token_budget), timestamp, timestamp).run();
    return json({ preset: rowPreset(await mustExist(db, "context_presets", id)) }, 201);
  }
  if (segments.length === 2 && request.method === "PATCH") {
    const current = await mustExist(db, "context_presets", segments[1]);
    const body = await readJson(request);
    const mode = body.mode === undefined ? current.mode : ["full", "compact", "custom"].includes(body.mode) ? body.mode : current.mode;
    await db.prepare(`UPDATE context_presets SET name = ?, description = ?, selection_json = ?, ordering_json = ?, mode = ?, token_budget = ?, updated_at = ? WHERE id = ?`)
      .bind(cleanOptionalString(body.name, 120) || current.name, cleanOptionalString(body.description, 500) ?? current.description,
        body.selection === undefined ? current.selection_json : JSON.stringify(body.selection && typeof body.selection === "object" ? body.selection : {}),
        body.ordering === undefined ? current.ordering_json : JSON.stringify(parseArray(body.ordering).map(cleanId).filter(Boolean).slice(0, 800)), mode,
        body.token_budget === undefined ? current.token_budget : numberOrNull(body.token_budget), now(), current.id).run();
    return json({ preset: rowPreset(await mustExist(db, "context_presets", current.id)) });
  }
  if (segments.length === 2 && request.method === "DELETE") {
    await mustExist(db, "context_presets", segments[1]);
    await db.prepare("DELETE FROM context_presets WHERE id = ?").bind(cleanId(segments[1])).run();
    return noContent();
  }
  return methodNotAllowed();
}

async function contextApi(db, request, segments) {
  if (segments.length === 2 && segments[1] === "preview" && request.method === "POST") {
    return json(await buildContextPreview(db, await readJson(request)));
  }
  if (segments.length === 2 && segments[1] === "compress" && request.method === "POST") {
    const body = await readJson(request);
    return json(await buildContextPreview(db, { ...body, mode: "compact" }));
  }
  if (segments.length === 3 && segments[1] === "export" && request.method === "POST") {
    const body = await readJson(request);
    const preview = await buildContextPreview(db, body);
    if (segments[2] === "markdown") return text(preview.markdown, 200, downloadHeaders(`nanstar-context-${compactTimestamp()}.md`, "text/markdown; charset=utf-8"));
    if (segments[2] === "json") return json(preview, 200, downloadHeaders(`nanstar-context-${compactTimestamp()}.json`, "application/json; charset=utf-8"));
  }
  return methodNotAllowed();
}

async function exportApi(db, request, segments, url) {
  if (request.method !== "GET") return methodNotAllowed();
  const includeRuns = url.searchParams.get("include_runs") === "1";
  if (segments[1] === "markdown") return text(await createLibraryMarkdown(db), 200, downloadHeaders(`nanstar-context-${compactTimestamp()}.md`, "text/markdown; charset=utf-8"));
  if (segments[1] === "json") return json(await createBackup(db, includeRuns), 200, downloadHeaders(`nanstar-context-backup-${compactTimestamp()}.json`, "application/json; charset=utf-8"));
  if (segments[1] === "zip") return new Response(await createBackupZip(db, includeRuns), { status: 200, headers: downloadHeaders(`nanstar-context-backup-${compactTimestamp()}.zip`, "application/zip") });
  return methodNotAllowed();
}

async function importApi(db, request, segments) {
  if (segments.length !== 2 || !["preview", "apply"].includes(segments[1]) || request.method !== "POST") return methodNotAllowed();
  const body = await readJson(request, MAX_IMPORT_BYTES);
  if (segments[1] === "preview") return json(previewImport(body));
  return json(await applyImport(db, body));
}

async function settingsApi(env, db, request, segments, url) {
  if (segments[1] !== "ai") return methodNotAllowed();
  if (segments[2] === "providers" || segments[2] === "models" || segments[2] === "routes" || segments[2] === "runs") {
    if (segments[2] === "providers") return providersApi(env, db, request, segments);
    if (segments[2] === "models") return modelsApi(db, request, segments, url);
    if (segments[2] === "routes") return routesApi(db, request, segments);
    return aiRunsApi(db, request, segments, url);
  }
  return methodNotAllowed();
}

async function apiRouter(env, db, request, segments, url) {
  if (!segments.length) return json({ name: "nanstar-context", ok: true });
  if (segments[0] === "session") return handleSession(env, db, request);
  const authError = await authorize(env, request);
  if (authError) return authError;
  const originError = requireSameOrigin(request);
  if (originError) return originError;

  if (segments[0] === "dashboard" && request.method === "GET") return dashboard(db);
  if (segments[0] === "health" && request.method === "GET") return health(env, db);
  if (segments[0] === "search" && request.method === "GET") return search(db, url);
  if (segments[0] === "categories") return categoriesApi(db, request, segments);
  if (segments[0] === "documents") return documentsApi(db, request, segments, url);
  if (segments[0] === "blocks") return blocksApi(db, request, segments);
  if (segments[0] === "captures") return capturesApi(env, db, request, segments, url);
  if (segments[0] === "proposals") return proposalsApi(db, request, segments, url);
  if (segments[0] === "proposal-operations") return proposalOperationApi(db, request, segments);
  if (segments[0] === "context") return contextApi(db, request, segments);
  if (segments[0] === "context-presets") return presetsApi(db, request, segments);
  if (segments[0] === "export") return exportApi(db, request, segments, url);
  if (segments[0] === "import") return importApi(db, request, segments);
  if (segments[0] === "settings") return settingsApi(env, db, request, segments, url);
  return json({ error: "Not found", code: "NOT_FOUND" }, 404);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const db = requireDatabase(env);
  if (!db) return missingDatabase();
  try {
    return await apiRouter(env, db, request, getPathSegments(params), new URL(request.url));
  } catch (error) {
    return errorResponse(error);
  }
}
