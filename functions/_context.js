import JSZip from "jszip";

import {
  KNOWLEDGE_STATUSES,
  cleanId,
  cleanString,
  cleanStringList,
  estimateTokens,
  now,
  parseArray,
  parseJson,
  parseTags
} from "./_shared.js";

const EXPORT_VERSION = 2;
const SUPPORTED_IMPORT_VERSIONS = new Set([1, 2]);
const MAX_CONTEXT_BLOCKS = 800;
const MAX_IMPORT_ROWS = 6000;

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}

function safeIds(value, limit = 500) {
  return [...new Set(parseArray(value).map((entry) => cleanId(entry)).filter(Boolean))].slice(0, limit);
}

function safeStatusList(value) {
  const selected = parseArray(value).filter((status) => KNOWLEDGE_STATUSES.has(status));
  return selected.length ? [...new Set(selected)] : ["current"];
}

export async function buildContextPreview(db, body = {}) {
  const selection = body.selection && typeof body.selection === "object" ? body.selection : body;
  const categoryIds = safeIds(selection.category_ids);
  const documentIds = safeIds(selection.document_ids);
  const blockIds = safeIds(selection.block_ids);
  const statuses = safeStatusList(selection.statuses);
  const tags = cleanStringList(selection.tags, 64, 30).map((tag) => tag.toLowerCase());
  const conditions = ["b.deleted_at IS NULL", "d.deleted_at IS NULL", "c.deleted_at IS NULL"];
  const bindings = [];

  conditions.push(`b.status IN (${placeholders(statuses.length)})`);
  bindings.push(...statuses);
  const selectedScopes = [];
  if (categoryIds.length) {
    selectedScopes.push(`(c.id IN (${placeholders(categoryIds.length)}) OR c.parent_id IN (${placeholders(categoryIds.length)}))`);
    bindings.push(...categoryIds, ...categoryIds);
  }
  if (documentIds.length) {
    selectedScopes.push(`d.id IN (${placeholders(documentIds.length)})`);
    bindings.push(...documentIds);
  }
  if (blockIds.length) {
    selectedScopes.push(`b.id IN (${placeholders(blockIds.length)})`);
    bindings.push(...blockIds);
  }
  if (selectedScopes.length) conditions.push(`(${selectedScopes.join(" OR ")})`);

  const from = Number(selection.valid_from);
  const to = Number(selection.valid_to);
  if (Number.isFinite(from) && from > 0) {
    conditions.push("COALESCE(b.valid_to, d.valid_to, 9223372036854775807) >= ?");
    bindings.push(from);
  }
  if (Number.isFinite(to) && to > 0) {
    conditions.push("COALESCE(b.valid_from, d.valid_from, 0) <= ?");
    bindings.push(to);
  }

  const result = await db.prepare(`
    SELECT b.id AS block_id, b.heading, b.body_md, b.summary AS block_summary,
           b.status, b.valid_from AS block_valid_from, b.valid_to AS block_valid_to,
           d.id AS document_id, d.title AS document_title, d.summary AS document_summary,
           d.tags, d.valid_from AS document_valid_from, d.valid_to AS document_valid_to,
           c.id AS category_id, c.name AS category_name, c.sort_order AS category_order,
           p.name AS parent_category_name, b.sort_order AS block_order, d.updated_at AS document_updated_at
      FROM knowledge_blocks b
      JOIN documents d ON d.id = b.document_id
      JOIN categories c ON c.id = d.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.sort_order, d.updated_at DESC, b.sort_order
     LIMIT ${MAX_CONTEXT_BLOCKS}
  `).bind(...bindings).all();

  let items = (result.results || [])
    .filter((row) => !tags.length || tags.some((tag) => parseTags(row.tags).map((item) => item.toLowerCase()).includes(tag)))
    .map((row) => ({
      id: row.block_id,
      category_id: row.category_id,
      category_path: row.parent_category_name ? `${row.parent_category_name}/${row.category_name}` : row.category_name,
      document_id: row.document_id,
      document_title: row.document_title,
      block_id: row.block_id,
      heading: row.heading,
      body_md: row.body_md,
      summary: row.block_summary || row.document_summary || "",
      status: row.status,
      tags: parseTags(row.tags),
      valid_from: row.block_valid_from || row.document_valid_from || null,
      valid_to: row.block_valid_to || row.document_valid_to || null
    }));

  const explicitOrder = safeIds(body.ordering || selection.ordering, MAX_CONTEXT_BLOCKS);
  if (explicitOrder.length) {
    const rank = new Map(explicitOrder.map((id, index) => [id, index]));
    items.sort((a, b) => (rank.get(a.block_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.block_id) ?? Number.MAX_SAFE_INTEGER));
  }

  const mode = ["full", "compact", "custom"].includes(body.mode) ? body.mode : "full";
  let truncated = false;
  if (mode === "compact") {
    items = items.map((item) => ({ ...item, body_md: item.summary || item.body_md.slice(0, 500) }));
  }
  if (mode === "custom") {
    const budget = Math.max(100, Math.min(Number(body.token_budget) || 4000, 200000));
    let remaining = budget;
    const selected = [];
    for (const item of items) {
      const overhead = estimateTokens(`${item.category_path}\n${item.document_title}\n${item.heading}`) + 8;
      const tokens = estimateTokens(item.body_md) + overhead;
      if (tokens <= remaining) {
        selected.push(item);
        remaining -= tokens;
        continue;
      }
      if (!selected.length && remaining > overhead + 20) {
        const ratio = Math.max(0.05, (remaining - overhead) / Math.max(estimateTokens(item.body_md), 1));
        selected.push({ ...item, body_md: `${item.body_md.slice(0, Math.floor(item.body_md.length * ratio))}\n\n[内容因预算截断]` });
      }
      truncated = true;
      break;
    }
    items = selected;
  }

  const markdown = contextMarkdown(items);
  return {
    mode,
    items,
    markdown,
    item_count: items.length,
    character_count: markdown.length,
    estimated_tokens: markdown ? estimateTokens(markdown) : 0,
    token_estimate_notice: "Token 为按字符数计算的近似值，实际数量以目标模型为准。",
    truncated
  };
}

export function contextMarkdown(items) {
  if (!items.length) return "";
  const lines = ["# NanStar Context", ""];
  let lastDocument = "";
  for (const item of items) {
    if (item.document_id !== lastDocument) {
      lines.push(`## ${item.document_title}`, "", `> 来源分类：${item.category_path}`, "");
      lastDocument = item.document_id;
    }
    lines.push(`### ${item.heading}`, "", item.body_md, "", `<!-- source: ${item.document_id}/${item.block_id} -->`, "");
  }
  return lines.join("\n").trim();
}

async function tableRows(db, sql) {
  const result = await db.prepare(sql).all();
  return result.results || [];
}

export async function createBackup(db, includeRuns = false) {
  const [
    categories, organizations, people, personRoles, personExpertise, projectPeople, workItemPeople,
    audioRecordings, audioSegments, meetings, meetingParticipants, meetingTopics, personInteractions,
    documents, blocks, versions, captures, proposals, operations,
    workProjects, workModules, workItems, workMilestones, dailyLogs, dailyEvents, workProposals, dailyDrafts, workVersions,
    providers, models, routes, presets, settings, runs
  ] = await Promise.all([
    tableRows(db, "SELECT * FROM categories ORDER BY sort_order"),
    tableRows(db, "SELECT * FROM organizations ORDER BY created_at"),
    tableRows(db, "SELECT * FROM people ORDER BY created_at"),
    tableRows(db, "SELECT * FROM person_roles ORDER BY person_id, created_at"),
    tableRows(db, "SELECT * FROM person_expertise ORDER BY person_id, created_at"),
    tableRows(db, "SELECT * FROM project_people ORDER BY project_id, created_at"),
    tableRows(db, "SELECT * FROM work_item_people ORDER BY work_item_id, created_at"),
    tableRows(db, "SELECT * FROM audio_recordings ORDER BY created_at"),
    tableRows(db, "SELECT * FROM audio_transcript_segments ORDER BY recording_id, segment_index"),
    tableRows(db, "SELECT * FROM meetings ORDER BY created_at"),
    tableRows(db, "SELECT * FROM meeting_participants ORDER BY meeting_id, created_at"),
    tableRows(db, "SELECT * FROM meeting_topics ORDER BY meeting_id, sort_order, created_at"),
    tableRows(db, "SELECT * FROM person_interactions ORDER BY person_id, occurred_at DESC"),
    tableRows(db, "SELECT * FROM documents ORDER BY created_at"),
    tableRows(db, "SELECT * FROM knowledge_blocks ORDER BY document_id, sort_order"),
    tableRows(db, "SELECT * FROM block_versions ORDER BY block_id, version_no"),
    tableRows(db, "SELECT * FROM captures ORDER BY created_at"),
    tableRows(db, "SELECT * FROM proposals ORDER BY created_at"),
    tableRows(db, "SELECT * FROM proposal_operations ORDER BY proposal_id, sort_order"),
    tableRows(db, "SELECT * FROM work_projects ORDER BY sort_order, updated_at DESC"),
    tableRows(db, "SELECT * FROM work_modules ORDER BY project_id, sort_order, updated_at DESC"),
    tableRows(db, "SELECT * FROM work_items ORDER BY project_id, module_id, sort_order, updated_at DESC"),
    tableRows(db, "SELECT * FROM work_milestones ORDER BY project_id, COALESCE(target_date, '9999-12-31'), updated_at DESC"),
    tableRows(db, "SELECT * FROM daily_work_logs ORDER BY work_date DESC, updated_at DESC"),
    tableRows(db, "SELECT * FROM daily_work_events ORDER BY daily_log_id, created_at"),
    tableRows(db, "SELECT * FROM work_update_proposals ORDER BY daily_log_id, created_at"),
    tableRows(db, "SELECT * FROM daily_progress_drafts ORDER BY daily_log_id, updated_at DESC"),
    tableRows(db, "SELECT * FROM work_state_versions ORDER BY entity_type, entity_id, version_no"),
    tableRows(db, `SELECT id, provider_type, name, base_url, '' AS key_ciphertext, '' AS key_iv,
                          '' AS key_last4, enabled, allow_auto_fallback, health_status,
                          last_checked_at, '' AS last_error, timeout_ms, created_at, updated_at
                     FROM ai_providers ORDER BY created_at`),
    tableRows(db, "SELECT * FROM ai_models ORDER BY created_at"),
    tableRows(db, "SELECT * FROM ai_routes ORDER BY task_type"),
    tableRows(db, "SELECT * FROM context_presets ORDER BY created_at"),
    tableRows(db, "SELECT * FROM app_settings ORDER BY key"),
    includeRuns ? tableRows(db, "SELECT * FROM ai_runs ORDER BY created_at") : Promise.resolve([])
  ]);
  return {
    format: "nanstar-context",
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    secrets_included: false,
    data: {
      categories,
      organizations,
      people,
      person_roles: personRoles,
      person_expertise: personExpertise,
      project_people: projectPeople,
      work_item_people: workItemPeople,
      audio_recordings: audioRecordings,
      audio_transcript_segments: audioSegments,
      meetings,
      meeting_participants: meetingParticipants,
      meeting_topics: meetingTopics,
      person_interactions: personInteractions,
      documents,
      knowledge_blocks: blocks,
      block_versions: versions,
      captures,
      proposals,
      proposal_operations: operations,
      work_projects: workProjects,
      work_modules: workModules,
      work_items: workItems,
      work_milestones: workMilestones,
      daily_work_logs: dailyLogs,
      daily_work_events: dailyEvents,
      work_update_proposals: workProposals,
      daily_progress_drafts: dailyDrafts,
      work_state_versions: workVersions,
      ai_providers: providers,
      ai_models: models,
      ai_routes: routes,
      context_presets: presets,
      app_settings: settings,
      ai_runs: runs
    }
  };
}

function yamlValue(value) {
  return JSON.stringify(value ?? "");
}

export async function createLibraryMarkdown(db) {
  const rows = await tableRows(db, `
    SELECT c.name AS category_name, p.name AS parent_name,
           d.id AS document_id, d.title, d.summary AS document_summary, d.tags,
           d.status AS document_status, d.valid_from, d.valid_to,
           b.heading, b.body_md, b.summary AS block_summary, b.status AS block_status
      FROM documents d
      JOIN categories c ON c.id = d.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
      LEFT JOIN knowledge_blocks b ON b.document_id = d.id AND b.deleted_at IS NULL
     WHERE d.deleted_at IS NULL AND c.deleted_at IS NULL
     ORDER BY c.sort_order, d.updated_at DESC, b.sort_order
  `);
  if (!rows.length) return "# NanStar Context 知识库\n\n暂无资料。";
  const lines = ["# NanStar Context 知识库", "", `导出时间：${new Date().toISOString()}`, ""];
  let lastCategory = "";
  let lastDocument = "";
  for (const row of rows) {
    const category = row.parent_name ? `${row.parent_name}/${row.category_name}` : row.category_name;
    if (category !== lastCategory) {
      lines.push(`# ${category}`, "");
      lastCategory = category;
      lastDocument = "";
    }
    if (row.document_id !== lastDocument) {
      lines.push(`## ${row.title}`, "", "```yaml", `summary: ${yamlValue(row.document_summary)}`, `tags: ${yamlValue(parseTags(row.tags))}`, `status: ${row.document_status}`, "```", "");
      lastDocument = row.document_id;
    }
    if (row.heading) lines.push(`### ${row.heading}`, "", row.body_md || "", "");
  }
  return lines.join("\n").trim();
}

function safeFilename(value, fallback) {
  return cleanString(value, 100).replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/[. ]+$/g, "") || fallback;
}

export async function createBackupZip(db, includeRuns = false) {
  const [backup, markdown, docs] = await Promise.all([
    createBackup(db, includeRuns),
    createLibraryMarkdown(db),
    tableRows(db, `
      SELECT c.name AS category_name, p.name AS parent_name, d.id AS document_id, d.title,
             d.summary AS document_summary, d.tags, d.status AS document_status,
             b.heading, b.body_md
        FROM documents d
        JOIN categories c ON c.id = d.category_id
        LEFT JOIN categories p ON p.id = c.parent_id
        LEFT JOIN knowledge_blocks b ON b.document_id = d.id AND b.deleted_at IS NULL
       WHERE d.deleted_at IS NULL AND c.deleted_at IS NULL
       ORDER BY c.sort_order, d.updated_at DESC, b.sort_order
    `)
  ]);
  const zip = new JSZip();
  const root = zip.folder("nanstar-context-export");
  root.file("manifest.json", JSON.stringify({ format: backup.format, version: backup.version, exported_at: backup.exported_at, secrets_included: false }, null, 2));
  root.file("data.json", JSON.stringify(backup, null, 2));
  root.file("knowledge-library.md", markdown);

  const grouped = new Map();
  for (const row of docs) {
    if (!grouped.has(row.document_id)) grouped.set(row.document_id, []);
    grouped.get(row.document_id).push(row);
  }
  for (const rows of grouped.values()) {
    const first = rows[0];
    const category = first.parent_name ? `${first.parent_name}/${first.category_name}` : first.category_name;
    const path = category.split("/").map((part) => safeFilename(part, "未分类")).join("/");
    const lines = [`# ${first.title}`, "", first.document_summary || "", "", `标签：${parseTags(first.tags).join("、") || "无"}`, `状态：${first.document_status}`, ""];
    for (const row of rows) if (row.heading) lines.push(`## ${row.heading}`, "", row.body_md || "", "");
    root.file(`markdown/${path}/${safeFilename(first.title, first.document_id)}.md`, lines.join("\n").trim());
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function backupPayload(value) {
  if (value?.format === "nanstar-context" && value?.data) return value;
  if (value?.backup?.format === "nanstar-context") return value.backup;
  return null;
}

const IMPORT_COLUMNS = {
  categories: ["id", "parent_id", "name", "slug", "description", "default_processing_mode", "sort_order", "created_at", "updated_at", "deleted_at"],
  organizations: ["id", "name", "short_name", "organization_type", "parent_id", "description", "status", "created_at", "updated_at", "archived_at"],
  people: ["id", "display_name", "aliases_json", "organization_id", "department", "notes", "status", "processing_mode", "sensitivity", "created_at", "updated_at", "archived_at"],
  person_roles: ["id", "person_id", "organization_id", "role_type", "role_name", "scope_description", "valid_from", "valid_to", "is_primary", "source_type", "confidence", "created_at", "updated_at", "archived_at"],
  person_expertise: ["id", "person_id", "expertise_name", "expertise_category", "level", "scope_description", "source_type", "source_id", "confidence", "review_status", "created_at", "updated_at", "archived_at"],
  project_people: ["id", "project_id", "person_id", "relationship_type", "responsibility", "module_id", "valid_from", "valid_to", "status", "source_type", "confidence", "created_at", "updated_at", "archived_at"],
  work_item_people: ["id", "work_item_id", "person_id", "relation_type", "created_at", "updated_at", "archived_at"],
  audio_recordings: ["id", "title", "file_name", "storage_key", "mime_type", "size_bytes", "duration_ms", "description", "project_id", "source_type", "processing_mode", "requested_model_id", "status", "language", "transcript_summary", "error_code", "error_message", "created_at", "updated_at", "archived_at"],
  audio_transcript_segments: ["id", "recording_id", "segment_index", "start_ms", "end_ms", "speaker_label", "person_id", "text", "asr_confidence", "language", "is_overlap", "review_status", "created_at", "updated_at", "archived_at"],
  meetings: ["id", "recording_id", "title", "meeting_date", "meeting_type", "selected_project_ids_json", "participant_status", "summary", "status", "created_at", "updated_at", "archived_at"],
  meeting_participants: ["id", "meeting_id", "person_id", "speaker_label", "attendance_status", "identification_method", "confidence", "confirmed_at", "created_at", "updated_at", "archived_at"],
  meeting_topics: ["id", "meeting_id", "title", "summary", "start_ms", "end_ms", "project_id", "module_id", "topic_type", "confidence", "review_status", "sort_order", "created_at", "updated_at", "archived_at"],
  person_interactions: ["id", "person_id", "project_id", "meeting_id", "interaction_type", "summary", "occurred_at", "source_id", "created_at", "updated_at", "archived_at"],
  ai_providers: ["id", "provider_type", "name", "base_url", "key_ciphertext", "key_iv", "key_last4", "enabled", "allow_auto_fallback", "health_status", "last_checked_at", "last_error", "timeout_ms", "created_at", "updated_at"],
  ai_models: ["id", "provider_id", "model_id", "display_name", "enabled", "supports_structured_output", "thinking_enabled", "cost_level", "input_price", "output_price", "price_currency", "context_limit", "max_output_tokens", "capabilities", "notes", "created_at", "updated_at"],
  ai_routes: ["id", "task_type", "default_model_id", "fallback_model_ids", "timeout_ms", "max_retries", "allow_cross_provider", "max_input_chars", "max_output_tokens", "updated_at"],
  work_projects: ["id", "name", "customer_name", "description", "status", "stage", "goal", "current_summary", "next_action", "target_date", "processing_mode", "tags_json", "sort_order", "created_at", "updated_at", "archived_at"],
  work_modules: ["id", "project_id", "name", "description", "stage", "status", "current_summary", "next_action", "target_date", "sort_order", "created_at", "updated_at", "archived_at"],
  work_items: ["id", "project_id", "module_id", "item_type", "title", "description", "status", "priority", "external_reference", "owner", "current_result", "next_action", "due_date", "discovered_at", "resolved_at", "sort_order", "created_at", "updated_at", "archived_at"],
  work_milestones: ["id", "project_id", "title", "description", "target_date", "status", "acceptance_criteria", "current_result", "next_action", "created_at", "updated_at"],
  daily_work_logs: ["id", "work_date", "raw_text", "cleaned_text", "selected_project_ids_json", "processing_mode", "requested_model_id", "state", "error_code", "error_message", "created_at", "updated_at"],
  daily_work_events: ["id", "daily_log_id", "project_id", "module_id", "work_item_id", "event_type", "content", "occurred_at", "confidence", "review_status", "created_at"],
  work_update_proposals: ["id", "daily_log_id", "project_id", "module_id", "work_item_id", "action", "field_name", "old_value", "proposed_value", "reason", "source_event_id", "status", "provider_id", "model_id", "created_at", "reviewed_at"],
  daily_progress_drafts: ["id", "daily_log_id", "work_date", "project_scope_json", "progress_text", "detail_text", "next_action_text", "status", "provider_id", "model_id", "created_at", "updated_at"],
  work_state_versions: ["id", "entity_type", "entity_id", "version_no", "snapshot_json", "change_reason", "source_event_id", "proposal_id", "created_at"],
  captures: ["id", "raw_text", "cleaned_text", "preferred_category_id", "processing_mode", "requested_model_id", "state", "error_code", "error_message", "created_at", "updated_at", "deleted_at"],
  documents: ["id", "category_id", "title", "summary", "tags", "status", "processing_mode", "valid_from", "valid_to", "created_at", "updated_at", "deleted_at"],
  proposals: ["id", "capture_id", "provider_id", "model_id", "status", "cleaned_text", "classification_json", "conflicts_json", "questions_json", "warnings_json", "input_tokens", "output_tokens", "estimated_cost", "cost_currency", "latency_ms", "created_at", "updated_at"],
  proposal_operations: ["id", "proposal_id", "action", "target_category_id", "target_document_id", "target_block_id", "proposed_title", "proposed_heading", "proposed_body_md", "reason", "status", "sort_order", "reviewed_at"],
  knowledge_blocks: ["id", "document_id", "heading", "body_md", "summary", "block_type", "sort_order", "status", "processing_mode", "valid_from", "valid_to", "source_capture_id", "created_at", "updated_at", "deleted_at"],
  block_versions: ["id", "block_id", "version_no", "heading", "body_md", "summary", "status", "proposal_operation_id", "change_note", "created_at"],
  context_presets: ["id", "name", "description", "selection_json", "ordering_json", "mode", "token_budget", "created_at", "updated_at"],
  app_settings: ["key", "value_json", "updated_at"],
  ai_runs: ["id", "task_type", "capture_id", "daily_log_id", "provider_id", "model_id", "attempt_no", "status", "input_tokens", "output_tokens", "estimated_cost", "cost_currency", "latency_ms", "error_code", "error_message", "created_at"]
};

const IMPORT_ORDER = [
  "categories", "ai_providers", "ai_models", "ai_routes",
  "work_projects", "work_modules", "work_items", "work_milestones", "daily_work_logs",
  "daily_work_events", "work_update_proposals", "daily_progress_drafts", "work_state_versions",
  "organizations", "people", "person_roles", "person_expertise", "project_people", "work_item_people",
  "audio_recordings", "audio_transcript_segments", "meetings", "meeting_participants", "meeting_topics", "person_interactions",
  "captures", "documents", "knowledge_blocks", "proposals", "proposal_operations", "block_versions",
  "context_presets", "app_settings", "ai_runs"
];

export function previewImport(value) {
  const backup = backupPayload(value);
  if (!backup) throw Object.assign(new Error("文件不是 NanStar Context JSON 备份"), { status: 400, code: "IMPORT_FORMAT_INVALID" });
  if (!SUPPORTED_IMPORT_VERSIONS.has(Number(backup.version))) throw Object.assign(new Error("备份版本不兼容"), { status: 400, code: "IMPORT_VERSION_UNSUPPORTED" });
  const counts = {};
  let total = 0;
  for (const table of IMPORT_ORDER) {
    const count = Array.isArray(backup.data?.[table]) ? backup.data[table].length : 0;
    counts[table] = count;
    total += count;
  }
  if (total > MAX_IMPORT_ROWS) throw Object.assign(new Error(`备份包含 ${total} 行，超过首版 ${MAX_IMPORT_ROWS} 行导入限制`), { status: 413, code: "IMPORT_TOO_LARGE" });
  return { format: backup.format, version: backup.version, exported_at: backup.exported_at, counts, total, secrets_included: false };
}

function importStatement(db, table, columns, row) {
  const key = table === "app_settings" ? "key" : table === "ai_routes" ? "task_type" : "id";
  if (!cleanString(row?.[key], 200)) return null;
  const values = columns.map((column) => {
    if (["key_ciphertext", "key_iv", "key_last4"].includes(column)) return "";
    if (column === "last_error") return "";
    if (column === "proposal_operation_id" && !row[column]) return null;
    return row[column] ?? null;
  });
  const updates = columns.filter((column) => column !== key && !["key_ciphertext", "key_iv", "key_last4"].includes(column));
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders(columns.length)})
    ON CONFLICT(${key}) DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}`;
  return db.prepare(sql).bind(...values);
}

export async function applyImport(db, value) {
  const preview = previewImport(value);
  const backup = backupPayload(value);
  const imported = {};
  for (const table of IMPORT_ORDER) {
    const rows = Array.isArray(backup.data?.[table]) ? backup.data[table] : [];
    const columns = IMPORT_COLUMNS[table];
    const statements = rows.map((row) => importStatement(db, table, columns, row)).filter(Boolean);
    for (let index = 0; index < statements.length; index += 50) {
      await db.batch(statements.slice(index, index + 50));
    }
    imported[table] = statements.length;
  }
  await db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('last_import', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
    .bind(JSON.stringify({ imported_at: new Date().toISOString(), source_exported_at: backup.exported_at }), now()).run();
  return { ok: true, imported, total: preview.total };
}
