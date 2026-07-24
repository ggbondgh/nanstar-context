import {
  MAX_AI_OPERATIONS,
  MAX_MARKDOWN_CHARS,
  OPERATION_ACTIONS,
  cleanId,
  cleanString,
  cleanStringList,
  decryptSecret,
  estimateTokens,
  inferTitle,
  ensureSet,
  newId,
  now,
  parseArray,
  safeJsonObjectFromText,
  summarize
} from "./_shared.js";
import {
  buildDailyProgressPromptData,
  buildManualDailyProgress,
  loadDailyProgressContext,
  normalizeDailyProgressResult,
  rowDailyLog,
  rowDailyEvent,
  rowWorkDraft,
  rowWorkProposal
} from "./_work_shared.js";

const MAX_PROVIDER_RESPONSE_BYTES = 768 * 1024;
const RETRYABLE_STATUS = new Set([404, 408, 409, 429, 500, 502, 503, 504]);

function apiError(message, status = 400, code = "AI_REQUEST_FAILED", retryable = false) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(cleanString(value, 500));
  } catch {
    throw apiError("服务商 Base URL 无效", 400, "INVALID_PROVIDER_URL");
  }
  if (url.protocol !== "https:") {
    throw apiError("服务商 Base URL 必须使用 HTTPS", 400, "INSECURE_PROVIDER_URL");
  }
  return url.toString().replace(/\/$/, "");
}

async function readBoundedText(response, limit = MAX_PROVIDER_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw apiError("服务商响应过大", 502, "AI_RESPONSE_TOO_LARGE");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw apiError("服务商响应过大", 502, "AI_RESPONSE_TOO_LARGE");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function classifyProviderError(status, body) {
  const lowered = String(body || "").toLowerCase();
  if (status === 401 || status === 403) return apiError("服务商 API Key 无效或无权限", 502, "AI_AUTH_FAILED");
  if (status === 429) return apiError("服务商请求限流或额度不足", 502, "AI_RATE_LIMITED", true);
  if (status === 404) return apiError("模型不存在或已下线", 502, "AI_MODEL_NOT_FOUND", true);
  if (lowered.includes("insufficient") || lowered.includes("quota") || lowered.includes("balance")) {
    return apiError("服务商额度不足", 502, "AI_QUOTA_EXCEEDED", true);
  }
  return apiError("服务商暂时不可用", 502, `AI_PROVIDER_${status}`, RETRYABLE_STATUS.has(status));
}

async function providerFetch(provider, apiKey, pathname, init = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Math.min(Number(provider.timeout_ms) || 30000, 120000));
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(provider.base_url)}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    const body = await readBoundedText(response);
    if (!response.ok) throw classifyProviderError(response.status, body.slice(0, 1000));
    try {
      return JSON.parse(body || "{}");
    } catch {
      throw apiError("服务商返回了无法解析的数据", 502, "AI_PROVIDER_INVALID_JSON", true);
    }
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") {
      throw apiError("服务商请求超时", 504, "AI_TIMEOUT", true);
    }
    if (error?.code) throw error;
    const detail = cleanString(error?.message || "网络请求失败", 120);
    throw apiError(`无法连接 AI 服务商：${detail}`, 502, "AI_NETWORK_ERROR", true);
  } finally {
    clearTimeout(timeout);
  }
}

async function providerKey(env, provider) {
  if (provider.provider_type === "cloudflare_ai") return "";
  if (!provider.key_ciphertext || !provider.key_iv) {
    if (provider.provider_type === "funasr") return "";
    throw apiError("服务商尚未配置 API Key", 400, "AI_KEY_MISSING");
  }
  return decryptSecret(env, provider.key_ciphertext, provider.key_iv);
}

export async function modelWithProvider(db, modelId) {
  const clean = cleanId(modelId);
  if (!clean) throw apiError("请选择模型", 400, "MODEL_REQUIRED");
  const row = await db.prepare(`
    SELECT m.*, p.provider_type, p.name AS provider_name, p.base_url, p.key_ciphertext, p.key_iv,
           p.enabled AS provider_enabled, p.allow_auto_fallback, p.timeout_ms
      FROM ai_models m
      JOIN ai_providers p ON p.id = m.provider_id
     WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1
  `).bind(clean).first();
  if (!row) throw apiError("模型不存在、已停用，或服务商已停用", 400, "MODEL_NOT_AVAILABLE");
  return row;
}

async function providerMultipartFetch(provider, apiKey, pathname, formData) {
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Math.min(Number(provider.timeout_ms) || 30000, 120000));
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(provider.base_url)}${pathname}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: formData
    });
    const body = await readBoundedText(response, MAX_PROVIDER_RESPONSE_BYTES * 2);
    if (!response.ok) throw classifyProviderError(response.status, body.slice(0, 1000));
    try {
      return JSON.parse(body || "{}");
    } catch {
      throw apiError("转写服务返回了无法解析的数据", 502, "ASR_PROVIDER_INVALID_JSON", true);
    }
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") {
      throw apiError("语音转文字请求超时", 504, "ASR_TIMEOUT", true);
    }
    if (error?.code) throw error;
    const detail = cleanString(error?.message || "网络请求失败", 120);
    throw apiError(`无法连接语音转文字服务：${detail}`, 502, "ASR_NETWORK_ERROR", true);
  } finally {
    clearTimeout(timeout);
  }
}

function humanizeModelId(value) {
  const source = cleanString(value, 200);
  const aliases = {
    api: "API",
    chat: "Chat",
    claude: "Claude",
    code: "Code",
    coder: "Coder",
    deepseek: "DeepSeek",
    doubao: "Doubao",
    ernie: "ERNIE",
    flash: "Flash",
    glm: "GLM",
    gpt: "GPT",
    instruct: "Instruct",
    json: "JSON",
    kimi: "Kimi",
    llama: "Llama",
    llm: "LLM",
    max: "Max",
    mini: "Mini",
    mistral: "Mistral",
    moonshot: "Moonshot",
    opus: "Opus",
    pro: "Pro",
    qwen: "Qwen",
    reasoning: "Reasoning",
    reasoner: "Reasoner",
    sonnet: "Sonnet",
    thinking: "Thinking",
    turbo: "Turbo",
    yi: "Yi"
  };
  const label = source.replace(/^@/, "").split(/[/:._-]+/).filter(Boolean).map((part) => {
    const lower = part.toLowerCase();
    if (aliases[lower]) return aliases[lower];
    if (/^[a-z]?\d+(\.\d+)?[a-z]?$/i.test(part)) return part.toUpperCase();
    if (/^[a-z]+\d+[a-z0-9]*$/i.test(part)) return part.toUpperCase();
    return lower.slice(0, 1).toUpperCase() + lower.slice(1);
  }).join(" ");
  return cleanString(label || source, 160);
}

function inferredModelCapabilities(provider, item, modelId) {
  const capabilities = new Set(cleanStringList(
    typeof item === "object" ? item.capabilities || item.tags || item.features : [],
    80,
    20
  ));
  const providerText = `${provider?.provider_type || ""} ${provider?.name || ""} ${provider?.base_url || ""}`.toLowerCase();
  const modelText = cleanString(modelId, 200).toLowerCase();
  if (
    provider?.provider_type === "funasr"
    || providerText.includes("funasr")
    || /(whisper|sensevoice|paraformer|transcrib|speech[-_ ]?to[-_ ]?text|\basr\b|\bstt\b)/i.test(modelText)
  ) {
    capabilities.add("audio_transcription");
  }
  return [...capabilities];
}

function normalizeProviderModel(item, provider = {}) {
  const id = cleanString(typeof item === "string" ? item : item?.id, 200);
  if (!id) return null;
  const displayName = cleanString(
    typeof item === "object" ? item.display_name || item.name || item.label : "",
    160
  ) || humanizeModelId(id);
  return {
    id,
    display_name: displayName,
    owned_by: cleanString(typeof item === "object" ? item.owned_by || item.owner || item.created_by : "", 120),
    object: cleanString(typeof item === "object" ? item.object : "", 40),
    capabilities: inferredModelCapabilities(provider, item, id)
  };
}

function openAiText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
  }
  return typeof payload?.response === "string" ? payload.response : "";
}

async function runModel(env, provider, model, messages, maxOutputTokens) {
  const startedAt = now();
  let payload;
  if (provider.provider_type === "cloudflare_ai") {
    if (!env.AI) throw apiError("Cloudflare Workers AI binding 未配置", 503, "AI_BINDING_MISSING");
    payload = await env.AI.run(model.model_id, {
      messages,
      max_tokens: maxOutputTokens,
      temperature: 0.2
    });
  } else {
    const apiKey = await providerKey(env, provider);
    const requestBody = {
      model: model.model_id,
      messages,
      temperature: 0.2,
      max_tokens: maxOutputTokens,
      stream: false
    };
    if (Number(model.supports_structured_output)) requestBody.response_format = { type: "json_object" };
    payload = await providerFetch(provider, apiKey, "/chat/completions", {
      method: "POST",
      body: JSON.stringify(requestBody)
    });
  }

  const text = openAiText(payload);
  if (!text) throw apiError("模型没有返回可用内容", 502, "AI_EMPTY_RESPONSE", true);
  const usage = payload?.usage || {};
  return {
    text,
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens) || null,
    outputTokens: Number(usage.completion_tokens || usage.output_tokens) || null,
    latencyMs: now() - startedAt
  };
}

export async function runSelectedChatModel(env, model, messages, maxOutputTokens = 1800) {
  return runModel(env, model, model, messages, maxOutputTokens);
}

export async function transcribeAudioWithModel(env, model, file, options = {}) {
  if (model.provider_type === "cloudflare_ai") {
    throw apiError("Workers AI 语音转文字暂未接入这个入口，请使用 OpenAI 兼容 ASR 服务商，或先粘贴转写文本", 400, "ASR_PROVIDER_UNSUPPORTED");
  }
  const apiKey = await providerKey(env, model);
  const form = new FormData();
  form.set("file", file, file.name || "audio");
  form.set("model", model.model_id);
  form.set("response_format", "verbose_json");
  const language = cleanString(options.language, 20);
  if (language) form.set("language", language);
  const prompt = cleanString(options.prompt, 2000);
  if (prompt) form.set("prompt", prompt);
  const payload = await providerMultipartFetch(model, apiKey, "/audio/transcriptions", form);
  return {
    text: cleanString(payload?.text, 200000),
    language: cleanString(payload?.language || language, 20),
    duration: Number(payload?.duration) || null,
    segments: Array.isArray(payload?.segments) ? payload.segments : [],
    raw: payload
  };
}

function keywordTerms(value) {
  const matches = cleanString(value, 24000).toLowerCase().match(/[\p{L}\p{N}]{2,16}/gu) || [];
  return [...new Set(matches)].sort((a, b) => b.length - a.length).slice(0, 6);
}

async function findCandidates(db, capture, maxChars) {
  const terms = keywordTerms(capture.raw_text);
  const where = [
    "b.deleted_at IS NULL",
    "d.deleted_at IS NULL",
    "c.deleted_at IS NULL",
    "b.status = 'current'",
    "COALESCE(b.processing_mode, d.processing_mode, c.default_processing_mode) = 'external_ai'"
  ];
  const bindings = [];
  if (capture.preferred_category_id) {
    where.push("(d.category_id = ? OR c.parent_id = ?)");
    bindings.push(capture.preferred_category_id, capture.preferred_category_id);
  }
  if (terms.length) {
    where.push(`(${terms.map(() => "(LOWER(d.title) LIKE ? OR LOWER(b.heading) LIKE ? OR LOWER(b.summary) LIKE ? OR LOWER(b.body_md) LIKE ?)").join(" OR ")})`);
    for (const term of terms) bindings.push(...Array(4).fill(`%${term}%`));
  }
  const result = await db.prepare(`
    SELECT b.id AS block_id, b.heading, b.summary, b.body_md,
           d.id AS document_id, d.title AS document_title,
           c.id AS category_id, c.name AS category_name
      FROM knowledge_blocks b
      JOIN documents d ON d.id = b.document_id
      JOIN categories c ON c.id = d.category_id
     WHERE ${where.join(" AND ")}
     ORDER BY b.updated_at DESC
     LIMIT 8
  `).bind(...bindings).all();

  let used = 0;
  return (result.results || []).map((row) => {
    const body = cleanString(row.body_md, 1500);
    const remaining = Math.max(0, maxChars - used);
    const clipped = body.slice(0, remaining);
    used += clipped.length;
    return { ...row, body_md: clipped };
  }).filter((row) => row.body_md || row.summary);
}

function buildOrganizeMessages(capture, candidates, categories, maxInputChars) {
  const candidateText = candidates.map((item, index) => [
    `候选 ${index + 1}`,
    `category_id=${item.category_id} 分类=${item.category_name}`,
    `document_id=${item.document_id} 文档=${item.document_title}`,
    `block_id=${item.block_id} 知识块=${item.heading}`,
    item.body_md
  ].join("\n")).join("\n\n");
  const categoryText = categories.map((item) => `${item.id}: ${item.path}`).join("\n");
  const rawText = cleanString(capture.raw_text, Math.max(1, maxInputChars - candidateText.length - categoryText.length - 4000));
  const system = `你是个人长期上下文整理器。只根据用户输入和候选资料提出建议，绝不编造事实，绝不直接修改资料。输出一个 JSON 对象，不要 Markdown 代码围栏。结构为：
{"cleaned_text":"完整清晰表达","topics":[{"title":"主题","category_suggestion":{"category_id":"真实分类ID或null","path":"分类路径","reason":"理由"},"operation":{"action":"create_document|create_block|append|merge|replace|move|mark_historical|archive","target_document_id":"真实ID或null","target_block_id":"真实ID或null","proposed_heading":"标题","proposed_body_md":"Markdown正文","reason":"理由"}}],"conflicts":[],"questions":[],"warnings":[]}
最多 ${MAX_AI_OPERATIONS} 个 topics。只能使用提供的真实 ID。目标不明确时使用 create_document 或 create_block，不要猜测覆盖。保留所有确定事实；不确定内容放入 questions。`;
  const user = `可用分类：
${categoryText || "无"}

用户偏好分类：${capture.preferred_category_id || "自动判断"}

少量候选资料：
${candidateText || "无候选资料"}

本次原始输入：
${rawText}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export async function buildWebAiAssistPrompt(db, capture) {
  const maxInputChars = 48000;
  const [candidates, categories] = await Promise.all([
    findCandidates(db, capture, 8000),
    categoryPaths(db)
  ]);
  const messages = buildOrganizeMessages(capture, candidates, categories, maxInputChars);
  return [
    "请帮我把下面这条个人上下文输入整理成 NanStar Context 可审核提案。",
    "你只需要返回一个 JSON 对象，不要输出解释、Markdown 代码围栏或额外文字。",
    "如果资料不足以判断目标位置，请优先使用 create_document 或 create_block，并把不确定点写入 questions。",
    "【系统要求】",
    messages[0].content,
    "【待整理资料】",
    messages[1].content,
    "【输出提醒】",
    "最终回复必须是一个完整 JSON 对象，字段名和枚举值必须严格匹配上面的结构。"
  ].join("\n\n");
}

export async function normalizeWebAiAssistResult(db, capture, resultText) {
  const rawPlan = safeJsonObjectFromText(resultText);
  if (!rawPlan) {
    throw apiError("网页版 AI 输出不是有效 JSON。请让它只返回 JSON 对象，或直接粘贴包含 JSON 的完整回复。", 400, "WEB_AI_OUTPUT_INVALID_JSON");
  }
  const plan = await normalizePlan(db, rawPlan, capture);
  plan.classification = {
    ...(plan.classification || {}),
    source: "web_ai_assist"
  };
  plan.warnings = [
    ...new Set([
      ...(plan.warnings || []),
      "由网页版 AI 手动辅助生成，平台未调用外部模型；请审核后再写入知识库。"
    ])
  ];
  return plan;
}

async function categoryPaths(db) {
  const result = await db.prepare(`
    SELECT c.id, c.name, p.name AS parent_name
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.deleted_at IS NULL
     ORDER BY c.sort_order
  `).all();
  return (result.results || []).map((row) => ({
    id: row.id,
    path: row.parent_name ? `${row.parent_name}/${row.name}` : row.name
  }));
}

async function validateTarget(db, kind, id) {
  const clean = cleanId(id);
  if (!clean) return null;
  const table = kind === "block" ? "knowledge_blocks" : kind === "document" ? "documents" : "categories";
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(clean).first();
  return row?.id || null;
}

async function normalizePlan(db, raw, capture) {
  const cleanedText = cleanString(raw?.cleaned_text || capture.raw_text, 120000);
  const topics = Array.isArray(raw?.topics) ? raw.topics.slice(0, MAX_AI_OPERATIONS) : [];
  const operations = [];
  for (const [index, topic] of topics.entries()) {
    const operation = topic?.operation || {};
    let action = OPERATION_ACTIONS.has(operation.action) ? operation.action : "create_document";
    const targetCategoryId = await validateTarget(db, "category", topic?.category_suggestion?.category_id || capture.preferred_category_id);
    const targetDocumentId = await validateTarget(db, "document", operation.target_document_id);
    const targetBlockId = await validateTarget(db, "block", operation.target_block_id);
    if (["append", "merge", "replace"].includes(action) && !targetBlockId) {
      action = targetDocumentId ? "create_block" : "create_document";
    }
    if (["move", "mark_historical", "archive"].includes(action) && !targetBlockId && !targetDocumentId) {
      action = "create_document";
    }
    const proposedHeading = cleanString(operation.proposed_heading || topic?.title || inferTitle(cleanedText), 120);
    const proposedBody = cleanString(operation.proposed_body_md || cleanedText, MAX_MARKDOWN_CHARS);
    if (!proposedBody && !["mark_historical", "archive", "move"].includes(action)) continue;
    operations.push({
      action,
      target_category_id: targetCategoryId || capture.preferred_category_id || "cat_inbox",
      target_document_id: targetDocumentId,
      target_block_id: targetBlockId,
      proposed_title: cleanString(topic?.title || proposedHeading, 120),
      proposed_heading: proposedHeading,
      proposed_body_md: proposedBody,
      reason: cleanString(operation.reason || topic?.category_suggestion?.reason || "根据本次输入整理", 500),
      sort_order: index + 1
    });
  }
  if (!operations.length) {
    operations.push({
      action: "create_document",
      target_category_id: capture.preferred_category_id || "cat_inbox",
      target_document_id: null,
      target_block_id: null,
      proposed_title: inferTitle(cleanedText),
      proposed_heading: inferTitle(cleanedText),
      proposed_body_md: cleanedText,
      reason: "未识别到明确目标，建议新建文档后由你审核位置",
      sort_order: 1
    });
  }
  return {
    cleaned_text: cleanedText,
    classification: { topics: operations.map((item) => ({ title: item.proposed_title, category_id: item.target_category_id })) },
    conflicts: Array.isArray(raw?.conflicts) ? raw.conflicts.slice(0, 20) : [],
    questions: Array.isArray(raw?.questions) ? raw.questions.slice(0, 20) : [],
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.slice(0, 20) : [],
    operations
  };
}

export async function createProposal(db, capture, plan, metadata = {}) {
  const timestamp = now();
  const proposalId = newId("proposal");
  const statements = [
    db.prepare(`
      INSERT INTO proposals (
        id, capture_id, provider_id, model_id, status, cleaned_text,
        classification_json, conflicts_json, questions_json, warnings_json,
        input_tokens, output_tokens, estimated_cost, cost_currency, latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      proposalId, capture.id, metadata.providerId || null, metadata.modelId || null,
      plan.cleaned_text, JSON.stringify(plan.classification || {}), JSON.stringify(plan.conflicts || []),
      JSON.stringify(plan.questions || []), JSON.stringify(plan.warnings || []), metadata.inputTokens || null,
      metadata.outputTokens || null, metadata.estimatedCost ?? null, metadata.costCurrency || "",
      metadata.latencyMs || null, timestamp, timestamp
    ),
    db.prepare("UPDATE captures SET cleaned_text = ?, state = 'review', error_code = '', error_message = '', updated_at = ? WHERE id = ?")
      .bind(plan.cleaned_text, timestamp, capture.id)
  ];
  for (const operation of plan.operations) {
    statements.push(db.prepare(`
      INSERT INTO proposal_operations (
        id, proposal_id, action, target_category_id, target_document_id, target_block_id,
        proposed_title, proposed_heading, proposed_body_md, reason, status, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
      newId("operation"), proposalId, operation.action, operation.target_category_id || null,
      operation.target_document_id || null, operation.target_block_id || null, operation.proposed_title || "",
      operation.proposed_heading || "", operation.proposed_body_md || "", operation.reason || "", operation.sort_order
    ));
  }
  await db.batch(statements);
  return proposalId;
}

export async function organizeWithRules(db, capture, manualOnly = false) {
  const cleaned = manualOnly
    ? cleanString(capture.raw_text, 120000)
    : cleanString(capture.raw_text, 120000).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const title = inferTitle(cleaned);
  const plan = {
    cleaned_text: cleaned,
    classification: { mode: manualOnly ? "manual_only" : "platform_rules" },
    conflicts: [],
    questions: manualOnly ? ["请确认目标分类、文档和知识块后再接受。"] : [],
    warnings: [manualOnly ? "未调用 AI，也未执行自动整理。" : "仅执行了平台本地确定性规则，未发送给第三方 AI。"],
    operations: [{
      action: "create_document",
      target_category_id: capture.preferred_category_id || "cat_inbox",
      target_document_id: null,
      target_block_id: null,
      proposed_title: title,
      proposed_heading: title,
      proposed_body_md: cleaned,
      reason: manualOnly ? "手动归档草稿" : "平台本地规则生成的待审核草稿",
      sort_order: 1
    }]
  };
  return createProposal(db, capture, plan);
}

async function routeAndModels(db, taskType, requestedModelId) {
  const route = await db.prepare("SELECT * FROM ai_routes WHERE task_type = ?").bind(taskType).first();
  const ids = [];
  if (cleanId(requestedModelId)) ids.push(cleanId(requestedModelId));
  if (route?.default_model_id) ids.push(route.default_model_id);
  ids.push(...parseArray(route?.fallback_model_ids).map((entry) => cleanId(entry)).filter(Boolean));
  const models = [];
  for (const id of [...new Set(ids)]) {
    const row = await db.prepare(`
      SELECT m.*, p.provider_type, p.name AS provider_name, p.base_url, p.key_ciphertext, p.key_iv,
             p.enabled AS provider_enabled, p.allow_auto_fallback, p.timeout_ms
        FROM ai_models m
        JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1
    `).bind(id).first();
    if (row) models.push(row);
  }
  return { route: route || {}, models };
}

function estimatedCost(model, inputTokens, outputTokens) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  if (model.input_price === null && model.output_price === null) return null;
  return (inputTokens / 1_000_000) * (Number(model.input_price) || 0)
    + (outputTokens / 1_000_000) * (Number(model.output_price) || 0);
}

async function startRun(db, { taskType = "organize_capture", captureId = null, dailyLogId = null, model, attemptNo }) {
  const id = newId("run");
  const startedAt = now();
  await db.prepare(`
    INSERT INTO ai_runs (
      id, task_type, capture_id, daily_log_id, provider_id, model_id, attempt_no, status,
      input_tokens, output_tokens, estimated_cost, cost_currency, latency_ms,
      error_code, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, taskType, captureId, dailyLogId, model.provider_id, model.id, attemptNo, "running",
    null, null, null, model.price_currency || "", null, "", "", startedAt
  ).run();
  return { id, startedAt };
}

async function finishRun(db, run, model, status, details = {}) {
  await db.prepare(`
    UPDATE ai_runs
       SET status = ?, input_tokens = ?, output_tokens = ?, estimated_cost = ?,
           cost_currency = ?, latency_ms = ?, error_code = ?, error_message = ?
     WHERE id = ?
  `).bind(
    status,
    details.inputTokens || null,
    details.outputTokens || null,
    details.estimatedCost ?? null,
    model.price_currency || "",
    details.latencyMs || Math.max(0, now() - Number(run.startedAt || now())),
    cleanString(details.errorCode, 80),
    cleanString(details.errorMessage, 300),
    run.id
  ).run();
}

export async function organizeWithExternalAi(env, db, capture) {
  const { route, models } = await routeAndModels(db, "organize_capture", capture.requested_model_id);
  if (!models.length) throw apiError("没有可用的整理模型，请先在设置中配置服务商、模型和路由", 400, "NO_ORGANIZE_MODEL");
  const maxInputChars = Math.max(4000, Math.min(Number(route.max_input_chars) || 24000, 100000));
  if (capture.raw_text.length > maxInputChars) {
    throw apiError(`输入超过当前路由的 ${maxInputChars} 字限制，请拆分后重试`, 413, "AI_INPUT_TOO_LONG");
  }
  const [candidates, categories] = await Promise.all([
    findCandidates(db, capture, Math.min(8000, Math.floor(maxInputChars / 3))),
    categoryPaths(db)
  ]);
  const messages = buildOrganizeMessages(capture, candidates, categories, maxInputChars);
  const maxRetries = Math.max(0, Math.min(Number(route.max_retries) || 0, 2));
  let finalError = null;
  let attemptNo = 0;

  for (const [modelIndex, model] of models.entries()) {
    if (modelIndex > 0 && !Number(route.allow_cross_provider) && model.provider_id !== models[0].provider_id) continue;
    if (modelIndex > 0 && !Number(model.allow_auto_fallback)) continue;
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      attemptNo += 1;
      const run = await startRun(db, { taskType: "organize_capture", captureId: capture.id, model, attemptNo });
      let result = null;
      try {
        result = await runModel(env, model, model, messages, Math.min(Number(route.max_output_tokens) || 1800, 8000));
        const rawPlan = safeJsonObjectFromText(result.text);
        if (!rawPlan) throw apiError("模型返回内容不是有效的结构化 JSON", 502, "AI_OUTPUT_INVALID_JSON", true);
        const plan = await normalizePlan(db, rawPlan, capture);
        const inputTokens = result.inputTokens || estimateTokens(messages.map((item) => item.content).join("\n"));
        const outputTokens = result.outputTokens || estimateTokens(result.text);
        const cost = estimatedCost(model, inputTokens, outputTokens);
        await finishRun(db, run, model, "succeeded", {
          inputTokens,
          outputTokens,
          estimatedCost: cost,
          latencyMs: result.latencyMs
        });
        return createProposal(db, capture, plan, {
          providerId: model.provider_id,
          modelId: model.id,
          inputTokens,
          outputTokens,
          estimatedCost: cost,
          costCurrency: model.price_currency || "",
          latencyMs: result.latencyMs
        });
      } catch (error) {
        finalError = error;
        await finishRun(db, run, model, "failed", {
          errorCode: error.code || "AI_REQUEST_FAILED",
          errorMessage: error.message,
          latencyMs: result?.latencyMs || Math.max(0, now() - run.startedAt)
        });
        if (!error.retryable) throw error;
      }
    }
  }
  throw finalError || apiError("所有可用模型均整理失败", 502, "AI_ALL_MODELS_FAILED");
}

async function loadDailyLog(db, id) {
  const clean = cleanId(id);
  if (!clean) throw apiError("日报不存在", 404, "NOT_FOUND");
  const log = await db.prepare("SELECT * FROM daily_work_logs WHERE id = ?").bind(clean).first();
  if (!log) throw apiError("日报不存在", 404, "NOT_FOUND");
  return rowDailyLog(log);
}

async function persistDailyProgressArtifacts(db, log, normalized, metadata, scope) {
  const timestamp = now();
  const selectedProjects = (scope.selected_projects || []).map((project) => ({
    id: project.id,
    name: project.name,
    customer_name: project.customer_name,
    status: project.status,
    stage: project.stage,
    current_summary: project.current_summary,
    next_action: project.next_action
  }));
  const eventRows = normalized.events.map((event) => ({
    id: newId("workevent"),
    ...event
  }));
  const proposalRows = normalized.updates.map((update) => ({
    id: newId("workprop"),
    ...update
  }));
  const statements = [
    db.prepare("UPDATE daily_work_logs SET cleaned_text = ?, state = 'analyzing', error_code = '', error_message = '', updated_at = ? WHERE id = ?")
      .bind(normalized.cleaned_text, timestamp, log.id),
    db.prepare("UPDATE daily_work_events SET review_status = 'rejected' WHERE daily_log_id = ? AND review_status = 'pending'").bind(log.id),
    db.prepare("UPDATE work_update_proposals SET status = 'rejected', reviewed_at = ? WHERE daily_log_id = ? AND status = 'pending'").bind(timestamp, log.id),
    db.prepare("UPDATE daily_progress_drafts SET status = 'archived', updated_at = ? WHERE daily_log_id = ? AND status IN ('draft', 'edited', 'approved', 'copied')").bind(timestamp, log.id)
  ];
  for (const event of eventRows) {
    statements.push(db.prepare(`
      INSERT INTO daily_work_events (
        id, daily_log_id, project_id, module_id, work_item_id, event_type, content,
        occurred_at, confidence, review_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(
      event.id, log.id, event.project_id || null, event.module_id || null, event.work_item_id || null,
      event.event_type, event.content, Number(event.occurred_at) || timestamp, event.confidence || "medium", timestamp
    ));
  }
  for (const proposal of proposalRows) {
    const sourceEvent = Number.isInteger(Number(proposal.source_event_index)) ? eventRows[proposal.source_event_index] : null;
    statements.push(db.prepare(`
      INSERT INTO work_update_proposals (
        id, daily_log_id, project_id, module_id, work_item_id, action, field_name, old_value, proposed_value,
        reason, source_event_id, status, provider_id, model_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).bind(
      proposal.id, log.id, proposal.project_id || null, proposal.module_id || null, proposal.work_item_id || null,
      proposal.action, proposal.field_name || "", proposal.old_value || "", proposal.proposed_value || "",
      proposal.reason || "", sourceEvent?.id || proposal.source_event_id || null,
      metadata.providerId || null, metadata.modelId || null, timestamp
    ));
  }
  statements.push(
    db.prepare(`
      INSERT INTO daily_progress_drafts (
        id, daily_log_id, work_date, project_scope_json, progress_text, detail_text, next_action_text,
        status, provider_id, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("workdraft"),
      log.id,
      log.work_date,
      JSON.stringify(selectedProjects),
      normalized.progress_text,
      normalized.detail_text,
      normalized.next_action_text,
      normalized.events.length || normalized.updates.length ? "draft" : "approved",
      metadata.providerId || null,
      metadata.modelId || null,
      timestamp,
      timestamp
    )
  );
  statements.push(db.prepare("UPDATE daily_work_logs SET state = 'review', updated_at = ?, cleaned_text = ?, error_code = '', error_message = '' WHERE id = ?")
    .bind(timestamp, normalized.cleaned_text, log.id));
  await db.batch(statements);
  return {
    log_id: log.id,
    event_count: eventRows.length,
    proposal_count: proposalRows.length,
    draft_status: normalized.events.length || normalized.updates.length ? "draft" : "approved"
  };
}

export async function generateDailyProgress(env, db, dailyLogInput) {
  const log = typeof dailyLogInput === "string" ? await loadDailyLog(db, dailyLogInput) : rowDailyLog(dailyLogInput);
  if (!log) throw apiError("日报不存在", 404, "NOT_FOUND");
  const scope = await loadDailyProgressContext(db, log);
  const cleanMode = ensureSet(log.processing_mode, new Set(["external_ai", "platform_rules", "manual_only"]), "platform_rules");
  const { route, models } = await routeAndModels(db, "daily_progress", log.requested_model_id);
  const maxOutputTokens = Math.max(200, Math.min(Number(route.max_output_tokens) || 2200, 8000));
  const maxRetries = Math.max(0, Math.min(Number(route.max_retries) || 0, 2));
  const shouldUseExternalAi = cleanMode === "external_ai" && models.length > 0;

  if (!shouldUseExternalAi) {
    const normalized = buildManualDailyProgress(log, scope);
    const artifacts = await persistDailyProgressArtifacts(db, log, normalized, {}, scope);
    return {
      ...artifacts,
      normalized,
      scope,
      provider: null,
      model: null,
      external_ai: false
    };
  }

  const promptData = buildDailyProgressPromptData(log, scope);
  const messages = [
    { role: "system", content: promptData.system },
    { role: "user", content: cleanString(promptData.user, Math.max(4000, Number(route.max_input_chars) || 50000)) }
  ];
  let finalError = null;
  let attemptNo = 0;

  for (const [modelIndex, model] of models.entries()) {
    if (modelIndex > 0 && !Number(route.allow_cross_provider) && model.provider_id !== models[0].provider_id) continue;
    if (modelIndex > 0 && !Number(model.allow_auto_fallback)) continue;
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      attemptNo += 1;
      const run = await startRun(db, { taskType: "daily_progress", dailyLogId: log.id, model, attemptNo });
      let result = null;
      try {
        result = await runModel(env, model, model, messages, maxOutputTokens);
        const rawPlan = safeJsonObjectFromText(result.text);
        if (!rawPlan) throw apiError("日报生成内容不是合法 JSON", 502, "DAILY_PROGRESS_INVALID_JSON", true);
        const normalized = await normalizeDailyProgressResult(db, log, rawPlan);
        const inputTokens = result.inputTokens || estimateTokens(messages.map((item) => item.content).join("\n"));
        const outputTokens = result.outputTokens || estimateTokens(result.text);
        const cost = estimatedCost(model, inputTokens, outputTokens);
        await finishRun(db, run, model, "succeeded", {
          inputTokens,
          outputTokens,
          estimatedCost: cost,
          latencyMs: result.latencyMs
        });
        const artifacts = await persistDailyProgressArtifacts(db, log, normalized, {
          providerId: model.provider_id,
          modelId: model.id
        }, scope);
        return {
          ...artifacts,
          normalized,
          scope,
          provider: model.provider_id,
          model: model.id,
          external_ai: true,
          inputTokens,
          outputTokens,
          estimatedCost: cost,
          latencyMs: result.latencyMs,
          rawText: result.text
        };
      } catch (error) {
        finalError = error;
        await finishRun(db, run, model, "failed", {
          errorCode: error.code || "AI_REQUEST_FAILED",
          errorMessage: error.message,
          latencyMs: result?.latencyMs || Math.max(0, now() - run.startedAt)
        });
        if (!error.retryable) throw error;
      }
    }
  }

  throw finalError || apiError("日报 AI 生成失败", 502, "DAILY_PROGRESS_ALL_MODELS_FAILED");
}

export async function testProvider(env, provider) {
  if (provider.provider_type === "cloudflare_ai") {
    if (!env.AI) throw apiError("Cloudflare Workers AI binding 未配置", 503, "AI_BINDING_MISSING");
    return { ok: true, message: "Workers AI binding 可用" };
  }
  const key = await providerKey(env, provider);
  const payload = await providerFetch(provider, key, "/models", { method: "GET" });
  return { ok: true, model_count: Array.isArray(payload?.data) ? payload.data.length : null };
}

export async function discoverProviderModels(env, provider, apiKey = undefined) {
  if (provider.provider_type === "cloudflare_ai") {
    throw apiError("Workers AI 模型请手动添加模型 ID", 400, "MODEL_SYNC_UNSUPPORTED");
  }
  const key = apiKey === undefined ? await providerKey(env, provider) : cleanString(apiKey, 4096);
  if (!key && provider.provider_type !== "funasr") throw apiError("服务商尚未配置 API Key", 400, "AI_KEY_MISSING");
  const payload = await providerFetch(provider, key, "/models", { method: "GET" });
  if (!Array.isArray(payload?.data)) {
    throw apiError("服务商未返回 OpenAI 兼容的 models 列表", 502, "AI_MODELS_INVALID_RESPONSE");
  }
  return payload.data.map((item) => normalizeProviderModel(item, provider)).filter(Boolean).slice(0, 300);
}

export async function listProviderModels(env, provider) {
  return (await discoverProviderModels(env, provider)).map((model) => model.id);
}

